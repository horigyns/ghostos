// The open loops Ghost last found, per project, kept in a small file in app data. New Claude sessions get them
// as context: GhostOS's own through the app, all others through the hook (a separate process that reads this file).
// Loop titles come from session summaries (written from transcripts), so readers treat them as untrusted notes.
import fs from "node:fs";
import path from "node:path";

export const GHOST_LOOPS_FILE = "ghost-loops.json";
/** A cache older than this (GhostOS closed for a while) isn't used: the loops may be finished by now. */
export const LOOPS_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const TITLE_MAX_CHARS = 120;

export interface CachedLoop {
  title: string;
  kind: string;
  lastActivityAt: string;
}

export interface LoopsCache {
  updatedAt: string;
  projects: Record<string, CachedLoop[]>;
}

/** Written to a temporary file and renamed, so the hook never reads half a file. */
export function writeCacheFile(appData: string, cache: LoopsCache): void {
  fs.mkdirSync(appData, { recursive: true });
  const file = path.join(appData, GHOST_LOOPS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, file);
}

/** One plain line: no line breaks, control characters or markdown headings, and short. */
export function cleanLoopTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const one = title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/#+\s/g, "").replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX_CHARS ? `${one.slice(0, TITLE_MAX_CHARS - 1)}…` : one;
}

export function readLoopsCache(appData: string, projectId: string, now = Date.now()): { title: string; kind: string; days: number }[] {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(appData, GHOST_LOOPS_FILE), "utf8")) as LoopsCache;
    if (typeof cache.updatedAt !== "string" || now - Date.parse(cache.updatedAt) > LOOPS_CACHE_MAX_AGE_MS) return [];
    const list = cache.projects?.[projectId];
    if (!Array.isArray(list)) return [];
    return list
      .filter((l) => typeof l?.title === "string" && typeof l.kind === "string" && typeof l.lastActivityAt === "string" && !Number.isNaN(Date.parse(l.lastActivityAt)))
      .map((l) => ({
        title: cleanLoopTitle(l.title),
        kind: l.kind.replace(/[^a-z-]/g, "").slice(0, 20),
        days: Math.max(0, Math.floor((now - Date.parse(l.lastActivityAt)) / DAY_MS)),
      }))
      .filter((l) => l.title);
  } catch {
    return [];
  }
}
