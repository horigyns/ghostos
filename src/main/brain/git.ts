// Keeps the brain folder under git: initialises it and commits changes shortly after they happen.
// Commits and syncs (brain/sync.ts) take turns through `exclusive`, so a commit never lands mid-rebase.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMIT_DEBOUNCE_MS = 5_000;
const GIT_TIMEOUT_MS = 15_000;

export function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // No credential prompts: a remote that needs a login fails fast instead of hanging until the timeout.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
    execFile("git", args, { cwd, timeout: timeoutMs, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/**
 * Returns the origin remote of a folder that is the top of its own git repo, or undefined.
 * A plain folder nested inside another repo (e.g. inside a home folder that is a repo) gets none,
 * so it never inherits an unrelated remote.
 */
export async function remoteOf(folder: string): Promise<string | undefined> {
  if (!fs.existsSync(folder)) return undefined;
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(folder)) return undefined;
  const r = await git(folder, ["remote", "get-url", "origin"]);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

export class BrainGit {
  private timer: NodeJS.Timeout | undefined;
  private reasons = new Set<string>();
  private committedListeners: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs git work one piece at a time (commits and syncs never overlap). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Called after each successful commit (used to sync the brain to its remote). */
  onCommitted(listener: () => void): void {
    this.committedListeners.push(listener);
  }

  constructor(private readonly dir: string) {}

  async init(): Promise<void> {
    if (fs.existsSync(path.join(this.dir, ".git"))) return this.recover();
    const r = await git(this.dir, ["init", "-b", "main"]);
    if (!r.ok) {
      console.warn(`[brain-git] git init failed: ${r.stderr.trim()}`);
      return;
    }
    fs.writeFileSync(path.join(this.dir, ".gitignore"), "*.tmp\n.DS_Store\n");
    fs.writeFileSync(
      path.join(this.dir, "README.md"),
      "# GhostOS brain\n\nProjects, areas, ideas and sidenotes for GhostOS. Edited by the app; safe to read by hand.\n",
    );
  }

  /** Undoes a rebase or merge left half-done by a crash or forced quit during a sync. */
  private async recover(): Promise<void> {
    const gitDir = path.join(this.dir, ".git");
    if (fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))) {
      const r = await git(this.dir, ["rebase", "--abort"]);
      console.warn(`[brain-git] aborted an interrupted sync rebase${r.ok ? "" : `: ${r.stderr.trim()}`}`);
    }
    if (fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) await git(this.dir, ["merge", "--abort"]);
  }

  /** Schedules a commit; several changes within a few seconds become one commit. */
  scheduleCommit(reason: string): void {
    this.reasons.add(reason);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.commitNow(), COMMIT_DEBOUNCE_MS);
  }

  /** Commits every change in the brain (also ones made without scheduleCommit). */
  commitNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.exclusive(() => this.commitLocked());
  }

  /** The commit itself; only call while holding `exclusive`. */
  async commitLocked(): Promise<void> {
    const gitDir = path.join(this.dir, ".git");
    if (!fs.existsSync(gitDir)) return;
    // Another process (the app or the background runner) is in the middle of a sync: commit later.
    if (["rebase-merge", "rebase-apply", "MERGE_HEAD"].some((f) => fs.existsSync(path.join(gitDir, f)))) return;
    const status = await git(this.dir, ["status", "--porcelain"]);
    if (!status.ok || !status.stdout.trim()) return;
    if (status.stdout.split("\n").some((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line))) {
      // Never commit conflict markers into the brain.
      console.warn("[brain-git] unmerged files in the brain; not committing until they are resolved");
      return;
    }
    const message = `GhostOS: ${[...this.reasons].join(", ") || "update"}`;
    this.reasons.clear();
    const add = await git(this.dir, ["add", "-A"]);
    if (!add.ok) {
      console.warn(`[brain-git] git add failed: ${add.stderr.trim()}`);
      return;
    }
    const commit = await git(this.dir, ["commit", "-m", message, "--no-verify"]);
    // "nothing to commit" is fine; anything else is worth a log line.
    if (!commit.ok && !/nothing to commit/i.test(commit.stdout + commit.stderr)) {
      console.warn(`[brain-git] git commit failed: ${commit.stderr.trim()}`);
    }
    if (commit.ok) this.committedListeners.forEach((l) => l());
  }
}
