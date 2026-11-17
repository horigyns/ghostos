// Finds a project's folders on this Mac (e.g. the MacBook after the brain synced from the Mac mini):
// git repos are matched by their remote, other folders (synced through iCloud) by folder name.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FolderSuggestion, Project } from "../../shared/types";
import { remoteOf } from "./git";

const SEARCH_DEPTH = 3;
const MAX_DIRS_SCANNED = 20_000;
const SKIP = new Set(["node_modules", "Library", "Applications", ".Trash", "Pictures", "Music", "Movies", "venv", ".venv", "dist", "build"]);

export function searchRoots(home = os.homedir()): string[] {
  return [
    home,
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "Downloads"),
    path.join(home, "Developer"),
    path.join(home, "code"),
    path.join(home, "Projects"),
    path.join(home, "src"),
    path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
  ];
}

/** Normalises git remotes so `git@github.com:u/r.git` and `https://github.com/u/r` compare equal. */
export function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

async function walk(roots: string[], visit: (dir: string, name: string, isRepo: boolean) => Promise<void>): Promise<void> {
  const seen = new Set<string>();
  let scanned = 0;
  const queue = roots.map((r) => ({ dir: r, depth: 0 }));
  while (queue.length && scanned < MAX_DIRS_SCANNED) {
    const { dir, depth } = queue.shift()!;
    let real: string;
    try {
      real = await fs.realpath(dir);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    scanned++;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // no permission (e.g. protected folders) or gone
    }
    const isRepo = entries.some((e) => e.name === ".git");
    if (depth > 0) await visit(dir, path.basename(dir), isRepo);
    if (isRepo || depth >= SEARCH_DEPTH) continue;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name)) queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
}

/** Suggestions for the project's folders that have no path on this Mac yet. */
export async function suggestFolders(project: Project, machineId: string, roots = searchRoots()): Promise<FolderSuggestion[]> {
  const missing = project.folders
    .map((f, folderIndex) => ({ f, folderIndex }))
    .filter(({ f }) => !f.paths[machineId]);
  if (!missing.length) return [];
  const byRemote = new Map(missing.filter((m) => m.f.remote).map((m) => [normalizeRemote(m.f.remote!), m]));
  const byName = new Map(missing.filter((m) => !m.f.remote && m.f.label).map((m) => [m.f.label!.toLowerCase(), m]));
  const out: FolderSuggestion[] = [];
  await walk(roots, async (dir, name, isRepo) => {
    if (isRepo && byRemote.size) {
      const remote = await remoteOf(dir);
      const hit = remote ? byRemote.get(normalizeRemote(remote)) : undefined;
      if (hit) out.push({ folderIndex: hit.folderIndex, label: hit.f.label ?? name, path: dir, reason: "git remote" });
    }
    const named = byName.get(name.toLowerCase());
    if (named) out.push({ folderIndex: named.folderIndex, label: named.f.label ?? name, path: dir, reason: "folder name" });
  });
  return out;
}
