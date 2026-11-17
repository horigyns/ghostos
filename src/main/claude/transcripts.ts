// Reads Claude Code's own transcript files (~/.claude/projects/<encoded folder>/<session>.jsonl)
// to list a project's past sessions and replay one's history into the chat view.
// Read-only: GhostOS never writes into Claude Code's files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEvent, SessionSummary } from "../../shared/types";
import { summarizeToolInput, previewToolResult, toolFilePath } from "./events";

const TITLE_SCAN_BYTES = 256 * 1024;
const TITLE_MAX_CHARS = 90;
const MAX_SESSIONS_PER_FOLDER = 40;
const MAX_HISTORY_EVENTS = 400;
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Claude Code stores each folder's transcripts under the path with every non-alphanumeric character replaced by "-". */
export function encodeProjectDir(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Transcript folders for a project folder. Claude Code uses the resolved path (e.g. /var -> /private/var,
 * or through a symlink), so both the given and the resolved form are checked.
 */
export function transcriptDirs(folder: string): string[] {
  let real = folder;
  try {
    real = fs.realpathSync(folder);
  } catch {
    // folder missing on this Mac; its transcripts may still exist under the given path
  }
  return [...new Set([folder, real])].map((f) => path.join(claudeProjectsDir(), encodeProjectDir(f)));
}

function readSlice(file: string, start: number, length: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** First real text the user typed, ignoring injected context such as <ide_selection> or command wrappers. */
export function userText(message: unknown): string | undefined {
  const content = (message as { content?: unknown })?.content;
  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        texts.push(String((block as { text?: unknown }).text ?? ""));
      }
    }
  }
  const real = texts.map((t) => t.trim()).filter((t) => t && !t.startsWith("<"));
  return real.length ? real.join("\n\n") : undefined;
}

function parseLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Partial lines at slice boundaries are expected; skip them.
    }
  }
  return out;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function summarizeSession(file: string): SessionSummary | undefined {
  const stat = fs.statSync(file);
  const head = parseLines(readSlice(file, 0, Math.min(stat.size, TITLE_SCAN_BYTES)));
  const tail =
    stat.size > TITLE_SCAN_BYTES
      ? parseLines(readSlice(file, Math.max(0, stat.size - TITLE_SCAN_BYTES), TITLE_SCAN_BYTES))
      : [];
  let aiTitle: string | undefined;
  for (const entry of [...head, ...tail]) {
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") aiTitle = entry.aiTitle;
  }
  let firstPrompt: string | undefined;
  let cwd = "";
  for (const entry of head) {
    if (entry.type !== "user" || entry.isSidechain) continue;
    cwd ||= String(entry.cwd ?? "");
    firstPrompt ??= userText(entry.message);
    if (firstPrompt) break;
  }
  const title = aiTitle ?? firstPrompt;
  if (!title) return undefined; // empty or tool-only sessions aren't worth listing
  return { sessionId: path.basename(file, ".jsonl"), title: truncate(title, TITLE_MAX_CHARS), updatedAt: stat.mtimeMs, cwd };
}

function recentTranscripts(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, MAX_SESSIONS_PER_FOLDER);
}

export function listSessions(folders: string[]): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  for (const folder of folders) {
    for (const file of transcriptDirs(folder).flatMap(recentTranscripts)) {
      try {
        const summary = summarizeSession(file);
        if (summary) sessions.push({ ...summary, cwd: summary.cwd || folder });
      } catch (err) {
        console.warn(`[transcripts] could not read ${file}: ${(err as Error).message}`);
      }
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Finds a session among a project's folders and the folder it ran in (needed to resume it). */
export function locateSession(sessionId: string, folders: string[]): { file: string; cwd: string } | undefined {
  for (const folder of folders) {
    const file = findTranscript(sessionId, [folder]);
    if (!file) continue;
    let cwd = folder;
    try {
      cwd = summarizeSession(file)?.cwd || folder;
    } catch {
      // unreadable head; the project folder is the best guess
    }
    return { file, cwd };
  }
  return undefined;
}

export function findTranscript(sessionId: string, folders: string[]): string | undefined {
  for (const folder of folders) {
    for (const dir of transcriptDirs(folder)) {
      const file = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return undefined;
}

/**
 * Converts a transcript into the same events the live chat view shows (main thread only).
 * Only the end of the file is read: transcripts can be tens of MB and the view shows the latest events.
 */
export function loadHistory(file: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - HISTORY_TAIL_BYTES);
  for (const entry of parseLines(readSlice(file, start, size - start))) {
    if (entry.isSidechain) continue;
    const message = entry.message as { content?: unknown } | undefined;
    if (entry.type === "user") {
      const text = userText(message);
      if (text) events.push({ kind: "user", text });
      if (Array.isArray(message?.content)) {
        for (const block of message.content as Record<string, unknown>[]) {
          if (block.type === "tool_result") {
            events.push({
              kind: "tool-result",
              id: String(block.tool_use_id ?? ""),
              isError: Boolean(block.is_error),
              preview: previewToolResult(block.content),
            });
          }
        }
      }
    } else if (entry.type === "assistant" && Array.isArray(message?.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === "text" && String(block.text ?? "").trim()) {
          events.push({ kind: "assistant-text", text: String(block.text) });
        } else if (block.type === "tool_use") {
          events.push({
            kind: "tool-use",
            id: String(block.id ?? ""),
            name: String(block.name ?? "tool"),
            summary: summarizeToolInput(block.input),
            filePath: toolFilePath(String(block.name ?? ""), block.input),
          });
        }
      }
    }
  }
  return events.slice(-MAX_HISTORY_EVENTS);
}
