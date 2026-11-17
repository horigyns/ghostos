// Full-text search across Claude session transcripts and the brain (sidenotes, ideas, briefs,
// session summaries, run results). Every word in the query must appear (case-insensitive).
// Runs inside a worker thread (worker.ts) so large transcripts never block the app.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SearchHit } from "../../shared/types";
import { BrainStore } from "../brain/store";
import { summarizeSession, transcriptDirs, userText } from "../claude/transcripts";

export const MAX_HITS = 150;
const HITS_PER_SESSION = 3;
const SNIPPET_RADIUS = 90;
const MIN_QUERY_CHARS = 2;

export interface SearchRequest {
  query: string;
  brainDir: string;
  projects: { id: string; name: string; folders: string[] }[];
}

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((w) => w.length >= MIN_QUERY_CHARS);
}

export function matches(text: string, words: string[]): boolean {
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** A short excerpt around the first matching word. */
export function snippet(text: string, words: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0)));
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + SNIPPET_RADIUS * 2);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

function assistantText(message: unknown): string | undefined {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n");
  return text.trim() || undefined;
}

async function searchTranscript(file: string, words: string[], projectId: string, cwd: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    // Tool results (often huge) never hold text the user or Claude wrote; skip them before parsing.
    if ((!line.includes('"user"') && !line.includes('"assistant"')) || line.includes('"tool_result"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const text = entry.type === "user" ? userText(entry.message) : entry.type === "assistant" ? assistantText(entry.message) : undefined;
    if (!text || !matches(text, words)) continue;
    const at = Date.parse(String(entry.timestamp ?? "")) || undefined;
    hits.push({ kind: "session", projectId, sessionId: path.basename(file, ".jsonl"), cwd, title: "", snippet: snippet(text, words), at });
    if (hits.length >= HITS_PER_SESSION) break;
  }
  lines.close();
  stream.destroy();
  if (hits.length) {
    const title = summarizeSession(file)?.title ?? "Claude session";
    for (const hit of hits) hit.title = title;
  }
  return hits;
}

function searchBrain(req: SearchRequest, words: string[]): SearchHit[] {
  const store = new BrainStore(req.brainDir);
  const hits: SearchHit[] = [];
  const names = new Map(req.projects.map((p) => [p.id, p.name]));
  for (const idea of store.listIdeas()) {
    if (matches(idea.text, words)) {
      hits.push({ kind: "idea", projectId: idea.projectId, title: `Idea · ${idea.projectId ? names.get(idea.projectId) ?? "" : "Unsorted"}`, snippet: snippet(idea.text, words), at: Date.parse(idea.createdAt) });
    }
  }
  for (const p of req.projects) {
    for (const note of store.listSidenotes(p.id)) {
      if (matches(note.text, words)) {
        hits.push({ kind: "sidenote", projectId: p.id, sessionId: note.sessionId, title: `Sidenote · ${p.name}`, snippet: snippet(note.text, words), at: Date.parse(note.createdAt) });
      }
    }
    const brief = store.getBrief(p.id);
    if (brief && matches(brief, words)) hits.push({ kind: "brief", projectId: p.id, title: `Brief · ${p.name}`, snippet: snippet(brief, words) });
    for (const s of store.listSessionSummaries(p.id)) {
      const text = [s.title, s.summary, ...s.decisions, ...s.openThreads].join("\n");
      if (matches(text, words)) {
        hits.push({ kind: "summary", projectId: p.id, sessionId: s.sessionId, title: `Summary · ${s.title}`, snippet: snippet(text, words), at: Date.parse(s.createdAt) });
      }
    }
    for (const r of store.listRunRecords(p.id)) {
      const text = [r.name, r.resultText ?? "", r.note ?? ""].join("\n");
      if (matches(text, words)) {
        hits.push({ kind: "run", projectId: p.id, sessionId: r.sessionId, title: `Run · ${r.name}`, snippet: snippet(text, words), at: Date.parse(r.startedAt) });
      }
    }
  }
  return hits;
}

export async function search(req: SearchRequest): Promise<SearchHit[]> {
  const words = queryWords(req.query);
  if (!words.length) return [];
  const hits = searchBrain(req, words);
  for (const p of req.projects) {
    for (const folder of p.folders) {
      for (const dir of transcriptDirs(folder)) {
        if (!fs.existsSync(dir)) continue;
        // Newest sessions first, so the hit limit never drops recent work.
        const files = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => path.join(dir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        for (const file of files) {
          if (hits.length >= MAX_HITS * 2) break;
          const name = path.basename(file);
          try {
            hits.push(...(await searchTranscript(file, words, p.id, folder)));
          } catch (err) {
            console.warn(`[search] skipped ${name}: ${(err as Error).message}`);
          }
        }
      }
    }
  }
  return hits.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_HITS);
}
