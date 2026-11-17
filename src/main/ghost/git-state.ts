// Reads the git state of a project folder for Ghost: uncommitted changes, unpushed commits, unmerged branches.
// Read-only git commands with a timeout; never fetches, so it works offline and never prompts.
import fs from "node:fs";
import path from "node:path";
import { git } from "../brain/git";
import type { FolderGitState } from "./loops";

const GIT_TIMEOUT_MS = 15_000;
/** Only this many changed files are stat'ed to find when the uncommitted work was last touched. */
const MTIME_SAMPLE = 60;
const MS_PER_SECOND = 1000;

/**
 * Strictly read-only: no optional locks (so `git status` never takes index.lock while the user runs git), and
 * no fsmonitor hook from the repository's own config.
 */
const READ_ONLY = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

async function out(folder: string, args: string[]): Promise<string | undefined> {
  const r = await git(folder, [...READ_ONLY, ...args], GIT_TIMEOUT_MS);
  return r.ok ? r.stdout.trim() : undefined;
}

async function defaultBranch(folder: string): Promise<string | undefined> {
  const remoteHead = await out(folder, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) return remoteHead.replace(/^origin\//, "");
  for (const name of ["main", "master"]) {
    if ((await git(folder, [...READ_ONLY, "show-ref", "--verify", "--quiet", `refs/heads/${name}`], GIT_TIMEOUT_MS)).ok) return name;
  }
  return undefined;
}

/** Paths in `git status --porcelain -z` output (NUL-separated, unquoted; a rename's old path follows as its own entry). */
export function porcelainPaths(status: string): string[] {
  const entries = status.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++; // skip the old name
  }
  return paths;
}

/** Undefined when the folder isn't in a git repository. Results are for the whole repository. */
export async function readGitState(folder: string, label: string): Promise<FolderGitState | undefined> {
  const top = await out(folder, ["rev-parse", "--show-toplevel"]);
  if (!top) return undefined;
  // Raw output (not trimmed: a leading space is part of the status code).
  const statusRun = await git(top, [...READ_ONLY, "status", "--porcelain", "-z", "--untracked-files=normal"], GIT_TIMEOUT_MS);
  const status = statusRun.ok ? statusRun.stdout : "";
  const paths = porcelainPaths(status);
  let dirtyMtime: number | undefined;
  for (const p of paths.slice(0, MTIME_SAMPLE)) {
    try {
      const m = fs.statSync(path.join(top, p)).mtimeMs;
      dirtyMtime = Math.max(dirtyMtime ?? 0, m);
    } catch {
      // deleted files have no mtime
    }
  }
  const [branch, aheadText, lastCommit, base] = await Promise.all([
    out(top, ["rev-parse", "--abbrev-ref", "HEAD"]),
    out(top, ["rev-list", "--count", "@{upstream}..HEAD"]),
    out(top, ["log", "-1", "--format=%ct"]),
    defaultBranch(top),
  ]);
  const unmerged: FolderGitState["unmerged"] = [];
  if (base) {
    const refs = (await out(top, ["for-each-ref", "--format=%(refname:short) %(committerdate:unix)", `--no-merged=${base}`, "refs/heads"])) ?? "";
    for (const line of refs.split("\n").filter(Boolean)) {
      const [name, at] = line.split(" ");
      if (name && name !== base) unmerged.push({ name, at: Number(at) * MS_PER_SECOND });
    }
  }
  return {
    folder: top,
    label,
    dirtyCount: paths.length,
    dirtyMtime,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    ahead: Number(aheadText) || 0,
    lastCommitAt: lastCommit ? Number(lastCommit) * MS_PER_SECOND : undefined,
    unmerged,
    defaultBranch: base,
  };
}
