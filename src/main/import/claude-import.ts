// Brings what Claude already keeps about the user into the brain, so it lives in GhostOS and syncs between Macs:
//   - Claude Code's auto-memory notes (~/.claude/projects/<folder>/memory/*.md), per project or "about you"
//   - ~/.claude/CLAUDE.md (your global instructions), as an "about you" note
//   - scheduled tasks from the Claude desktop app (Application Support/Claude/.../scheduled-tasks.json)
//   - claude.ai cloud routines, from a snapshot of the routines list saved in GhostOS's app data
// Scanning only reads. Importing copies; nothing in ~/.claude, the desktop app or claude.ai is changed.
// No Electron dependency, so it can be unit tested.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ImportMemoryItem, ImportRunItem, ImportScan, ImportSelection, ImportResult } from "../../shared/api";
import { ME_SCOPE, type Project, type RunDefinition, type RunSchedule } from "../../shared/types";
import { describeSchedule, splitCronTz } from "../../shared/schedule";
import { isMemoryFileName, memoryNoteHeader, type BrainStore } from "../brain/store";
import { validateSchedule } from "../runs/schedule";
import { claudeProjectSlug } from "../capabilities/context";

export { claudeProjectSlug };

const MEMORY_INDEX = "MEMORY.md";
const NOTE_MAX_CHARS = 60_000;
const RUN_PROMPT_MAX_CHARS = 20_000;
const RUN_ID_BYTES = 4;
/** Cloud routines run on UTC unless their cron says CRON_TZ=… */
const CLOUD_DEFAULT_TZ = "UTC";
const GLOBAL_CLAUDE_MD_FILE = "claude-global-instructions.md";
/** Strings that look like credentials; such notes are flagged and not selected by default. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:secret|password|passwd|token|api[_-]?key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/i,
  /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/i,
];

export interface ImportPaths {
  /** ~/.claude */
  claudeDir: string;
  /** ~/Library/Application Support/Claude (the desktop app) */
  desktopDir: string;
  /** GhostOS's snapshot of the claude.ai routines list */
  routinesFile: string;
  homeDir: string;
}

export function defaultImportPaths(appData: string): ImportPaths {
  const home = os.homedir();
  return {
    claudeDir: path.join(home, ".claude"),
    desktopDir: path.join(home, "Library", "Application Support", "Claude"),
    routinesFile: path.join(appData, "imports", "claude-routines.json"),
    homeDir: home,
  };
}

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

const hash = (text: string) => crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 16);

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Reads a regular file; symlinks, folders and unreadable files give undefined (so nothing outside is copied). */
function readRegularFile(file: string): string | undefined {
  try {
    return fs.lstatSync(file).isFile() ? fs.readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.lstatSync(dir).isDirectory() ? fs.readdirSync(dir) : [];
  } catch {
    return [];
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

// ---------- matching folders and names to projects ----------

interface ProjectIndex {
  /** Claude slug of each project folder on this Mac -> project id */
  slugs: { slug: string; projectId: string }[];
  /** normalized git remote -> project id */
  remotes: Map<string, string>;
  projects: Project[];
  /** Claude slugs of archived projects' folders: their memory isn't offered (it would land in another project) */
  archivedSlugs: string[];
}

const normRemote = (url: string) => url.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "").replace(/^git@github\.com:/, "https://github.com/");

function indexProjects(store: BrainStore, machineId: string): ProjectIndex {
  const projects = store.listActiveProjects();
  const slugs: ProjectIndex["slugs"] = [];
  const remotes = new Map<string, string>();
  for (const p of projects) {
    for (const f of p.folders) {
      const local = f.paths[machineId];
      if (local) slugs.push({ slug: claudeProjectSlug(local), projectId: p.id });
      if (f.remote) remotes.set(normRemote(f.remote), p.id);
    }
  }
  slugs.sort((a, b) => b.slug.length - a.slug.length); // deepest folder first
  const archivedSlugs = store
    .listProjects()
    .filter((p) => p.archived)
    .flatMap((p) => p.folders.flatMap((f) => (f.paths[machineId] ? [claudeProjectSlug(f.paths[machineId])] : [])));
  return { slugs, remotes, projects, archivedSlugs };
}

/**
 * The project a Claude memory folder belongs to: its own folder (exact), or one that looks like a folder inside it,
 * e.g. a worktree. A prefix match is only a guess ("app-old" and "app/old" have the same slug), so it isn't preselected.
 */
function projectForSlug(index: ProjectIndex, slug: string): { projectId: string; exact: boolean } | undefined {
  const hit = index.slugs.find((s) => slug === s.slug || slug.startsWith(s.slug + "-"));
  return hit && { projectId: hit.projectId, exact: hit.slug === slug };
}

const RESOLVE_MAX_DEPTH = 12;

/**
 * The real folder behind a Claude slug, found by walking the disk ("-Users-me-Acme-MVP-acme-app" could be
 * many paths; only one exists). Undefined when the folder is gone.
 */
export function resolveClaudeSlug(slug: string, from = "/", depth = 0): string | undefined {
  const here = claudeProjectSlug(from === "/" ? "" : from);
  if (slug === here) return from;
  if (depth > RESOLVE_MAX_DEPTH || !slug.startsWith(here + "-")) return undefined;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const next = path.join(from, entry.name);
    const nextSlug = claudeProjectSlug(next);
    if (slug !== nextSlug && !slug.startsWith(nextSlug + "-")) continue;
    const found = resolveClaudeSlug(slug, next, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const tildePath = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + path.sep) ? `~/${p.slice(home.length + 1)}` : p);

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Best project for a routine: by its repository, else by shared words in the name (ties: none). */
function guessProject(index: ProjectIndex, name: string, repos: string[]): string {
  for (const repo of repos) {
    const hit = index.remotes.get(normRemote(repo));
    if (hit) return hit;
  }
  const nameWords = words(name);
  let best = { id: "", score: 0, tie: false };
  for (const p of index.projects) {
    const score = [...words(p.name)].filter((w) => nameWords.has(w)).length;
    if (score > best.score) best = { id: p.id, score, tie: false };
    else if (score === best.score && score > 0) best.tie = true;
  }
  // Several projects sharing only the area word ("Acme …") is a guess too weak to preselect.
  return best.tie ? "" : best.id;
}

// ---------- memory ----------

function scanMemory(paths: ImportPaths, store: BrainStore, index: ProjectIndex): ImportMemoryItem[] {
  const items: ImportMemoryItem[] = [];
  const projectsDir = path.join(paths.claudeDir, "projects");
  const homeSlug = claudeProjectSlug(paths.homeDir);
  const inBrain = new Map<string, Map<string, string>>(); // scope -> file -> hash
  const brainHashes = (scope: string) => {
    let map = inBrain.get(scope);
    if (!map) {
      map = new Map(store.listClaudeMemory(scope).map((n) => [n.file, hash(n.content)]));
      inBrain.set(scope, map);
    }
    return map;
  };
  const status = (scope: string, file: string, content: string): ImportMemoryItem["status"] => {
    if (!scope) return "new";
    const existing = brainHashes(scope).get(file);
    return existing === undefined ? "new" : existing === hash(content) ? "imported" : "changed";
  };

  const dirs = listDir(projectsDir).sort();
  for (const slug of dirs) {
    const memDir = path.join(projectsDir, slug, "memory");
    const files = listDir(memDir).filter((f) => f !== MEMORY_INDEX && isMemoryFileName(f)).sort();
    if (!files.length) continue;
    // An archived project's own folder (or one inside it) that no active project claims.
    const archived = index.archivedSlugs.some((a) => slug === a || slug.startsWith(a + "-"));
    if (archived && !projectForSlug(index, slug)?.exact) continue;
    const match = slug === homeSlug ? { projectId: ME_SCOPE, exact: true } : projectForSlug(index, slug);
    const target = match?.projectId ?? "";
    const real = slug === homeSlug ? undefined : resolveClaudeSlug(slug);
    const sourceLabel = slug === homeSlug ? "Your home folder (~)" : real ? tildePath(real, paths.homeDir) : `${slug.replace(claudeProjectSlug(paths.homeDir) + "-", "~/")} (folder not on this Mac)`;
    for (const file of files) {
      const content = readRegularFile(path.join(memDir, file));
      if (content === undefined || content.length > NOTE_MAX_CHARS) continue;
      const header = memoryNoteHeader(content, file);
      const secret = looksSecret(content);
      const st = status(target, file, content);
      items.push({
        key: `mem:${slug}/${file}`,
        file,
        name: header.name,
        description: header.description,
        sourceLabel,
        target,
        status: st,
        secret,
        guessed: Boolean(match && !match.exact),
        // "changed" isn't preselected: the brain's copy may hold edits made on the other Mac.
        selected: Boolean(match?.exact) && !secret && st === "new",
      });
    }
  }

  const raw = readRegularFile(path.join(paths.claudeDir, "CLAUDE.md"));
  if (raw !== undefined) {
    const content = `---\nname: Global Claude instructions\ndescription: Copy of ~/.claude/CLAUDE.md (Claude Code loads the original on this Mac)\n---\n\n${raw}`;
    const st = status(ME_SCOPE, GLOBAL_CLAUDE_MD_FILE, content);
    items.push({
      key: "claude-md",
      file: GLOBAL_CLAUDE_MD_FILE,
      name: "Global Claude instructions",
      description: "~/.claude/CLAUDE.md, kept as a reference copy (Claude Code already loads it on this Mac)",
      sourceLabel: "~/.claude/CLAUDE.md",
      target: ME_SCOPE,
      status: st,
      secret: looksSecret(raw),
      guessed: false,
      selected: false,
    });
  }
  return items;
}

/** The note's content as it will be stored (re-read from disk at import time, never taken from the renderer). */
function memoryContent(paths: ImportPaths, key: string): { file: string; content: string } | undefined {
  if (key === "claude-md") {
    const raw = readRegularFile(path.join(paths.claudeDir, "CLAUDE.md"));
    if (raw === undefined) return undefined;
    return {
      file: GLOBAL_CLAUDE_MD_FILE,
      content: `---\nname: Global Claude instructions\ndescription: Copy of ~/.claude/CLAUDE.md (Claude Code loads the original on this Mac)\n---\n\n${raw}`,
    };
  }
  const match = /^mem:([^/]+)\/([^/]+\.md)$/.exec(key);
  if (!match || match[1].includes("..") || match[2] === MEMORY_INDEX || !isMemoryFileName(match[2])) return undefined;
  const content = readRegularFile(path.join(paths.claudeDir, "projects", match[1], "memory", match[2]));
  return content === undefined || content.length > NOTE_MAX_CHARS ? undefined : { file: match[2], content };
}

// ---------- runs ----------

interface RunCandidate {
  kind: "cloud-routine" | "desktop-task";
  id: string;
  name: string;
  prompt: string;
  schedule?: RunSchedule;
  scheduleError?: string;
  enabledThere: boolean;
  model?: string;
  connectors: string[];
  repos: string[];
  folder?: string;
}

/** The first user message in a routine's stored events, for routines whose prompt isn't in derived_state. */
function firstEventPrompt(routine: Record<string, unknown>): string | undefined {
  const events = ((routine.job_config as { ccr?: { events?: unknown[] } } | undefined)?.ccr?.events ?? []) as {
    data?: { message?: { content?: unknown } };
  }[];
  for (const e of events) {
    const content = e.data?.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
      if (text.trim()) return text;
    }
  }
  return undefined;
}

function scheduleFrom(cron: string | undefined, onceAt: string | undefined, defaultTz: string | undefined): { schedule?: RunSchedule; error?: string } {
  try {
    if (cron) {
      const { expr, tz } = splitCronTz(cron);
      return { schedule: validateSchedule({ kind: "cron", expr, tz: tz ?? defaultTz }) };
    }
    if (onceAt) return { schedule: validateSchedule({ kind: "once", at: onceAt }) };
    return { error: "No schedule" };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Reads the routines snapshot: the claude.ai routines list as returned by its API ({ data: [...] }) or a bare array. */
export function readCloudRoutines(file: string): { routines: RunCandidate[]; savedAt?: string } {
  if (!fs.existsSync(file)) return { routines: [] };
  const raw = readJson(file);
  const list = (Array.isArray(raw) ? raw : (raw as { data?: unknown } | undefined)?.data) as Record<string, unknown>[] | undefined;
  if (!Array.isArray(list)) return { routines: [] };
  const routines: RunCandidate[] = [];
  for (const r of list) {
    const id = str(r.id);
    const name = str(r.name);
    const derived = (r.derived_state ?? {}) as { prompt?: unknown; model?: unknown };
    const prompt = str(derived.prompt) ?? firstEventPrompt(r);
    if (!id || !name || !prompt) continue;
    const config = ((r.session_request as { config?: Record<string, unknown> } | undefined)?.config ?? {}) as {
      sources?: { url?: unknown }[];
      model?: unknown;
    };
    const { schedule, error } = scheduleFrom(str(r.cron_expression), str(r.run_once_at), CLOUD_DEFAULT_TZ);
    routines.push({
      kind: "cloud-routine",
      id,
      name,
      prompt,
      schedule,
      scheduleError: error,
      enabledThere: r.enabled === true && !str(r.ended_reason),
      model: str(derived.model) ?? str(config.model),
      connectors: ((r.mcp_connections ?? []) as { name?: unknown }[]).map((m) => str(m.name)?.replace(/_/g, " ")).filter((n): n is string => Boolean(n)),
      repos: (config.sources ?? []).map((s) => str(s.url)).filter((u): u is string => Boolean(u)),
    });
  }
  return { routines, savedAt: fs.statSync(file).mtime.toISOString() };
}

/** Scheduled tasks from the Claude desktop app (one scheduled-tasks.json per account and workspace). */
function readDesktopTasks(desktopDir: string): RunCandidate[] {
  const out: RunCandidate[] = [];
  for (const group of ["claude-code-sessions", "local-agent-mode-sessions"]) {
    const base = path.join(desktopDir, group);
    for (const account of listDir(base)) {
      const accountDir = path.join(base, account);
      for (const workspace of listDir(accountDir)) {
        const data = readJson(path.join(accountDir, workspace, "scheduled-tasks.json")) as { scheduledTasks?: Record<string, unknown>[] } | undefined;
        for (const t of data?.scheduledTasks ?? []) {
          const id = str(t.taskId) ?? str(t.id);
          const skill = str(t.path) ?? str(t.skillPath);
          let prompt = str(t.prompt);
          const skillText = !prompt && skill?.endsWith(".md") ? readRegularFile(skill) : undefined;
          if (skillText) prompt = skillText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
          prompt ??= str(t.description);
          const name = str(t.title) ?? str(t.name) ?? id;
          if (!id || !name || !prompt) continue;
          // Desktop tasks run in this Mac's local time.
          const { schedule, error } = scheduleFrom(str(t.cronExpression) ?? str(t.cron), str(t.fireAt), undefined);
          out.push({
            kind: "desktop-task",
            id,
            name,
            prompt,
            schedule,
            scheduleError: error,
            enabledThere: t.enabled !== false,
            model: str(t.model),
            connectors: [],
            repos: [],
            folder: str(t.cwd) ?? str(t.folder),
          });
        }
      }
    }
  }
  return out;
}

function runCandidates(paths: ImportPaths): { candidates: RunCandidate[]; routinesSavedAt?: string } {
  const cloud = readCloudRoutines(paths.routinesFile);
  return { candidates: [...readDesktopTasks(paths.desktopDir), ...cloud.routines], routinesSavedAt: cloud.savedAt };
}

const runKey = (c: RunCandidate) => `run:${c.kind}:${c.id}`;

function importedIds(store: BrainStore): Set<string> {
  return new Set(store.listAllRuns().flatMap((r) => (r.importedFrom ? [`run:${r.importedFrom.kind}:${r.importedFrom.id}`] : [])));
}

function scanRuns(paths: ImportPaths, store: BrainStore, index: ProjectIndex): { runs: ImportRunItem[]; routinesSavedAt?: string } {
  const { candidates, routinesSavedAt } = runCandidates(paths);
  const done = importedIds(store);
  const runs = candidates.map((c): ImportRunItem => {
    const byFolder = c.folder ? projectForSlug(index, claudeProjectSlug(c.folder)) : undefined;
    const target = (byFolder?.exact ? byFolder.projectId : undefined) ?? guessProject(index, c.name, c.repos);
    const already = done.has(runKey(c));
    return {
      key: runKey(c),
      kind: c.kind,
      name: c.name,
      promptPreview: c.prompt.slice(0, 400),
      scheduleText: c.schedule ? describeSchedule(c.schedule) : `Can't import the schedule: ${c.scheduleError}`,
      enabledThere: c.enabledThere,
      model: c.model,
      connectors: c.connectors,
      target,
      status: already ? "imported" : "new",
      importable: Boolean(c.schedule) && c.prompt.length <= RUN_PROMPT_MAX_CHARS,
      // Routines still switched on over there; ones that ended or were turned off are left unticked.
      selected: !already && Boolean(target) && Boolean(c.schedule) && c.enabledThere,
    };
  });
  return { runs, routinesSavedAt };
}

/** The note that starts an imported run's prompt, so it works on this Mac rather than in the cloud. */
export function importPreface(c: Pick<RunCandidate, "kind" | "connectors">): string {
  if (c.kind === "desktop-task") return "";
  const connectors = c.connectors.length ? ` It used these claude.ai connectors: ${c.connectors.join(", ")}; Claude Code on this Mac reaches them through the same account.` : "";
  return (
    "[GhostOS: this job was a claude.ai cloud routine and now runs on this Mac with Claude Code.]" +
    connectors +
    " Where the instructions mention remote-device tools (device_bash, device_list_dir and similar), use the local tools (Bash, Read, Write) directly; the files are on this Mac.\n\n"
  );
}

// ---------- public ----------

export function scanClaudeImports(paths: ImportPaths, store: BrainStore, machineId: string): ImportScan {
  const index = indexProjects(store, machineId);
  const { runs, routinesSavedAt } = scanRuns(paths, store, index);
  return { memory: scanMemory(paths, store, index), runs, routinesFile: paths.routinesFile, routinesSavedAt };
}

/**
 * Copies the selected notes and runs into the brain. Content is re-read from Claude's files here; the renderer
 * only says which items and where. Every target is checked before anything is written; after that, a problem with
 * one item skips it (reported) instead of leaving the import half done. Imported runs arrive switched off, so
 * nothing runs twice while the cloud copy is still on; switching one on in the Runs tab is the user's decision.
 */
export function applyClaudeImports(
  paths: ImportPaths,
  store: BrainStore,
  machineId: string,
  selection: ImportSelection,
  now = new Date(),
): ImportResult & { createdRuns: RunDefinition[] } {
  const projectIds = new Set(store.listActiveProjects().map((p) => p.id));
  const target = (value: unknown, allowMe: boolean): string | undefined =>
    (allowMe && value === ME_SCOPE) || (typeof value === "string" && projectIds.has(value)) ? (value as string) : undefined;
  const memory = selection.memory ?? [];
  const wanted = selection.runs ?? [];
  if (memory.some((i) => !target(i.target, true)) || wanted.some((i) => !target(i.target, false))) {
    throw new Error("Pick a project for every selected item.");
  }

  const result = { notes: 0, runs: 0, skipped: [] as string[], createdRuns: [] as RunDefinition[] };
  const written = new Set<string>(); // scope/file written in this import
  for (const item of memory) {
    const scope = target(item.target, true)!;
    try {
      const note = typeof item.key === "string" ? memoryContent(paths, item.key) : undefined;
      if (!note) {
        result.skipped.push(`${String(item.key)}: no longer there`);
        continue;
      }
      // Two Claude folders (a project and its worktree) can both have e.g. "roadmap.md"; the first one wins.
      if (written.has(`${scope}/${note.file}`)) {
        result.skipped.push(`${note.file}: another note with that name was imported to the same place`);
        continue;
      }
      store.saveClaudeMemory(scope, note.file, note.content);
      written.add(`${scope}/${note.file}`);
      result.notes++;
    } catch (err) {
      result.skipped.push(`${String(item.key)}: ${(err as Error).message}`);
    }
  }

  if (wanted.length) {
    const { candidates } = runCandidates(paths);
    const done = importedIds(store);
    for (const item of wanted) {
      const c = candidates.find((x) => runKey(x) === item.key);
      if (!c || !c.schedule) {
        result.skipped.push(`${String(item.key)}: not found or no usable schedule`);
        continue;
      }
      if (done.has(runKey(c))) {
        result.skipped.push(`${c.name}: already imported`);
        continue;
      }
      const prompt = importPreface(c) + c.prompt;
      if (prompt.length > RUN_PROMPT_MAX_CHARS) {
        result.skipped.push(`${c.name}: instructions too long`);
        continue;
      }
      const def: RunDefinition = {
        id: crypto.randomBytes(RUN_ID_BYTES).toString("hex"),
        projectId: target(item.target, false)!,
        name: c.name.slice(0, 120),
        prompt,
        schedule: c.schedule,
        model: c.model,
        // As in claude.ai, where routines run in auto mode; shown in the dialog and editable in the Runs tab.
        permissionMode: "auto",
        runOn: machineId,
        enabled: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        importedFrom: { kind: c.kind, id: c.id, name: c.name, connectors: c.connectors.length ? c.connectors : undefined, importedAt: now.toISOString() },
      };
      try {
        store.saveRun(def);
      } catch (err) {
        result.skipped.push(`${c.name}: ${(err as Error).message}`);
        continue;
      }
      done.add(runKey(c));
      result.createdRuns.push(def);
      result.runs++;
    }
  }
  return result;
}
