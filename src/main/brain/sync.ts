// Syncs the brain between Macs through a private git remote (GitHub).
// Order, all under BrainGit's lock so no commit lands in between: commit everything → fetch (network) →
// rebase onto the remote locally (fast, so the app has almost no window to write mid-rebase) → push.
// JSONL files (ideas, sidenotes, run history) merge by union, so both Macs' lines survive; any other
// conflict aborts the rebase and is reported, leaving local data as it was.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SyncStatus } from "../../shared/types";
import { git, type BrainGit } from "./git";

const FETCH_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 30_000;
const GITATTRIBUTES = "*.jsonl merge=union\n";
const REMOTE_BRANCH = "main";
const UNMERGED = /^(UU|AA|DD|AU|UA|DU|UD) /m;

const firstLine = (r: { stdout: string; stderr: string }) => `${r.stderr}${r.stdout}`.trim().split("\n")[0];

export class BrainSync {
  private lastSyncAt: number | undefined;
  private lastError: string | undefined;
  private running: Promise<SyncStatus> | undefined;

  constructor(
    private readonly dir: string,
    private readonly brainGit: BrainGit,
  ) {}

  /** Union-merge for append-style files; committed with the next brain commit. */
  ensureAttributes(): void {
    const file = path.join(this.dir, ".gitattributes");
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (!current.includes("merge=union")) fs.writeFileSync(file, current + GITATTRIBUTES);
  }

  async remote(): Promise<string | undefined> {
    const r = await git(this.dir, ["remote", "get-url", "origin"]);
    return r.ok ? r.stdout.trim() || undefined : undefined;
  }

  async status(): Promise<SyncStatus> {
    const remote = await this.remote();
    let ahead = 0;
    if (remote) {
      const r = await git(this.dir, ["rev-list", "--count", `origin/${REMOTE_BRANCH}..HEAD`]);
      ahead = r.ok ? Number(r.stdout.trim()) || 0 : 0;
    }
    return { remote, lastSyncAt: this.lastSyncAt, error: this.lastError, ahead };
  }

  /** Connects an existing (empty or brain) repo URL as the sync remote and syncs. */
  async connect(url: string): Promise<SyncStatus> {
    const set = (await this.remote())
      ? await git(this.dir, ["remote", "set-url", "origin", url])
      : await git(this.dir, ["remote", "add", "origin", url]);
    if (!set.ok) throw new Error(`Couldn't set the remote: ${firstLine(set)}`);
    return this.sync();
  }

  /** Creates a private GitHub repo with the user's gh login and connects it. Only on the user's click. */
  async createGithubRepo(name: string): Promise<SyncStatus> {
    if (await this.remote()) throw new Error("The brain already has a sync remote.");
    const created = await new Promise<{ ok: boolean; out: string }>((resolve) =>
      execFile(
        "gh",
        ["repo", "create", name, "--private", "--source", this.dir, "--remote", "origin", "--description", "GhostOS brain (private)"],
        { cwd: this.dir, timeout: FETCH_TIMEOUT_MS },
        (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }),
      ),
    );
    if (!created.ok) throw new Error(`GitHub repo not created: ${created.out}`);
    return this.sync();
  }

  /** Commit, fetch, rebase, push. One at a time; a second call joins the running one. */
  sync(): Promise<SyncStatus> {
    this.running ??= this.brainGit.exclusive(() => this.doSync()).finally(() => (this.running = undefined));
    return this.running;
  }

  /** Waits for a sync in progress (used when quitting, so a rebase is never cut off). */
  async settle(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  private async doSync(): Promise<SyncStatus> {
    if (!(await this.remote())) return this.status();
    await this.brainGit.commitLocked();
    const dirty = await git(this.dir, ["status", "--porcelain"]);
    if (UNMERGED.test(dirty.stdout)) return this.fail("The brain has unresolved conflicts; resolve them in the brain folder, then sync again.");
    if (dirty.stdout.trim()) return this.fail("The brain has changes that couldn't be committed; sync will try again shortly.");

    const fetched = await git(this.dir, ["fetch", "origin"], FETCH_TIMEOUT_MS);
    if (!fetched.ok) return this.fail(`Couldn't reach the remote: ${firstLine(fetched)}`);
    const remoteRef = `origin/${REMOTE_BRANCH}`;
    if ((await git(this.dir, ["rev-parse", "--verify", "--quiet", remoteRef])).ok) {
      if (!(await git(this.dir, ["merge-base", "HEAD", remoteRef])).ok) {
        return this.fail(
          "This Mac's brain and the remote brain started separately, so they can't be merged. On a new Mac, clone the remote to the brain folder instead of connecting.",
        );
      }
      const behind = await git(this.dir, ["rev-list", "--count", `HEAD..${remoteRef}`]);
      if (Number(behind.stdout.trim()) > 0) {
        const rebased = await git(this.dir, ["rebase", remoteRef], LOCAL_TIMEOUT_MS);
        if (!rebased.ok) {
          await git(this.dir, ["rebase", "--abort"], LOCAL_TIMEOUT_MS);
          return this.fail(`Sync stopped: both Macs changed the same brain file. Nothing was changed here. (${firstLine(rebased)})`);
        }
      }
    }
    const pushed = await git(this.dir, ["push", "-u", "origin", `HEAD:${REMOTE_BRANCH}`], PUSH_TIMEOUT_MS);
    if (!pushed.ok) return this.fail(`Couldn't push: ${firstLine(pushed)}`);
    this.lastSyncAt = Date.now();
    this.lastError = undefined;
    return this.status();
  }

  private async fail(message: string): Promise<SyncStatus> {
    this.lastError = message;
    return this.status();
  }
}
