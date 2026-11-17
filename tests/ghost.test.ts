import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainStore } from "../src/main/brain/store";
import { buildSessionContext } from "../src/main/capabilities/context";
import { cleanLoopTitle, readLoopsCache } from "../src/main/ghost/cache";
import { porcelainPaths, readGitState } from "../src/main/ghost/git-state";
import { ghostView, inQuietHours, projectLoops, stalledSummary, threadLoopId, type FolderGitState, type ProjectInputs } from "../src/main/ghost/loops";
import { digestHeadline, GhostService, MAX_SUMMARIES_PER_SCAN, type Notice } from "../src/main/ghost/service";
import { ghostSettings } from "../src/main/ghost-wiring";
import { MemoryService } from "../src/main/memory/service";
import { summaryPrompt, type SummaryResult } from "../src/main/memory/summarizer";
import { LocalState } from "../src/main/runs/local-state";
import { encodeProjectDir } from "../src/main/claude/transcripts";
import type { ProjectView, RunDefinition, RunRecord, SessionSummaryDoc } from "../src/shared/types";

const DAY = 24 * 60 * 60_000;
const NOW = new Date("2026-11-20T15:00:00"); // local time, 15:00 (outside default quiet hours)
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let dir: string;
beforeEach(() => (dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-ghost-")))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const summary = (sessionId: string, daysAgo: number, openThreads: string[]): SessionSummaryDoc => ({
  sessionId,
  projectId: "p",
  title: `Session ${sessionId}`,
  summary: "Did things.",
  decisions: [],
  openThreads,
  createdAt: ago(daysAgo),
});

const git = (over: Partial<FolderGitState> = {}): FolderGitState => ({ folder: "/r", label: "repo", dirtyCount: 0, ahead: 0, unmerged: [], ...over });

function inputs(over: Partial<ProjectInputs> = {}): ProjectInputs {
  return { project: { id: "p", name: "Study" }, summaries: [], sessions: [], git: [], runs: { defs: [], records: [] }, sidenotes: [], ...over };
}

describe("open loops", () => {
  it("turns threads, git state, failed runs and saved notes into loops", () => {
    const def = { id: "r1", name: "Weekly scan" } as RunDefinition;
    const records = [
      { id: "a", runId: "r1", status: "failed", startedAt: ago(1), note: "Timed out" },
      { id: "b", runId: "r1", status: "succeeded", startedAt: ago(3) },
    ] as RunRecord[];
    const loops = projectLoops(
      inputs({
        summaries: [summary("s1", 2, ["Write the extension section", "Rerun judge on sheet 17"])],
        git: [git({ dirtyCount: 3, branch: "main", ahead: 2, unmerged: [{ name: "feat/x", at: NOW.getTime() - DAY }] })],
        runs: { defs: [def], records },
        sidenotes: [{ id: "n1", projectId: "p", sessionId: "", text: "look at\nthe cache", mode: "later", status: "saved", createdAt: ago(5) }],
      }),
      NOW,
    );
    expect(loops.map((l) => l.kind)).toEqual(["thread", "thread", "uncommitted", "unpushed", "branches", "run-failed", "sidenote"]);
    expect(loops[0].id).toBe(threadLoopId("s1", "Write the extension section"));
    expect(loops[2].title).toBe("3 uncommitted changes in repo");
    expect(loops[4].title).toBe("1 branch not merged into main (repo)");
    expect(loops[6].title).toBe("Saved note: look at the cache");
  });

  it("drops threads older than the window, and a run that succeeded after failing", () => {
    const def = { id: "r1", name: "Scan" } as RunDefinition;
    const records = [
      { id: "b", runId: "r1", status: "succeeded", startedAt: ago(1) },
      { id: "a", runId: "r1", status: "failed", startedAt: ago(2) },
    ] as RunRecord[];
    const loops = projectLoops(inputs({ summaries: [summary("old", 90, ["ancient"])], runs: { defs: [def], records } }), NOW);
    expect(loops).toEqual([]);
  });

  it("marks a project stalled after the idle days, and applies done, dismissed and snoozed decisions", () => {
    const t1 = threadLoopId("s1", "one");
    const t2 = threadLoopId("s1", "two");
    const t3 = threadLoopId("s1", "three");
    const data = [inputs({ summaries: [summary("s1", 4, ["one", "two", "three", "four"])], sessions: [{ sessionId: "s1", title: "x", cwd: "/r", updatedAt: NOW.getTime() - 4 * DAY }] })];
    const view = ghostView(
      data,
      [
        { id: t1, status: "done", by: "summary", createdAt: ago(1) },
        { id: t2, status: "dismissed", by: "user", createdAt: ago(1) },
        { id: t3, status: "snoozed", snoozeUntil: ago(-1), by: "user", createdAt: ago(1) },
      ],
      3,
      NOW,
    );
    expect(view.projects[0]).toMatchObject({ stalled: true, idleDays: 4 });
    expect(view.projects[0].loops.map((l) => l.title)).toEqual(["four"]);
    expect(view.snoozed.map((s) => s.loop.title)).toEqual(["three"]);
    expect(ghostView(data, [], 5, NOW).projects[0].stalled).toBe(false);
    expect(stalledSummary(view.projects[0])).toBe("Idle 4 days · 1 open thread");
  });

  it("scheduled runs don't count as activity, manual ones do", () => {
    const records = [{ id: "a", runId: "r", status: "succeeded", trigger: "schedule", startedAt: ago(0) }] as RunRecord[];
    const base = { summaries: [summary("s1", 10, ["x"])], runs: { defs: [], records } };
    expect(ghostView([inputs(base)], [], 3, NOW).projects[0].idleDays).toBe(10);
    const manual = { ...base, runs: { defs: [], records: [{ ...records[0], trigger: "manual" }] as RunRecord[] } };
    expect(ghostView([inputs(manual)], [], 3, NOW).projects[0].idleDays).toBe(0);
  });

  it("knows quiet hours, including ones past midnight", () => {
    expect(inQuietHours(23, 22, 8)).toBe(true);
    expect(inQuietHours(7, 22, 8)).toBe(true);
    expect(inQuietHours(8, 22, 8)).toBe(false);
    expect(inQuietHours(13, 12, 14)).toBe(true);
    expect(inQuietHours(3, 5, 5)).toBe(false);
  });
});

describe("git state", () => {
  it("parses porcelain paths, renames included", () => {
    expect(porcelainPaths(" M src/a.ts\0?? new file.md\0R  new.ts\0old.ts\0 M caf\u00e9.md\0")).toEqual(["src/a.ts", "new file.md", "new.ts", "caf\u00e9.md"]);
  });

  it("reads uncommitted changes and unmerged branches of a real repo", async () => {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "pipe" });
    run("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    run("add", "a.txt");
    run("commit", "-q", "-m", "first");
    run("checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    run("add", "b.txt");
    run("commit", "-q", "-m", "feature work");
    run("checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "n\n");

    const state = (await readGitState(path.join(repo), "repo"))!;
    expect(state).toMatchObject({ dirtyCount: 2, branch: "main", ahead: 0, defaultBranch: "main" });
    expect(state.unmerged.map((b) => b.name)).toEqual(["feature"]);
    expect(state.dirtyMtime).toBeGreaterThan(0);
    expect(await readGitState(dir, "not a repo")).toBeUndefined();
  });
});

describe("Ghost service", () => {
  function setup(
    opts: { sessions?: { sessionId: string; updatedAt: number }[]; usageAllowed?: boolean; now?: Date; projects?: number; notifyWorks?: boolean; runSessions?: string[] } = {},
  ) {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const appData = path.join(dir, "app");
    fs.mkdirSync(appData, { recursive: true });
    const folder = path.join(dir, "work");
    fs.mkdirSync(folder, { recursive: true });
    const views: ProjectView[] = [];
    for (let i = 0; i < (opts.projects ?? 1); i++) {
      const p = store.createProject({ name: `Study ${i}`, area: "research" });
      store.saveSessionSummary({ ...summary(`s${i}`, 6, [`thread ${i}`]), projectId: p.id });
      for (const sid of opts.runSessions ?? []) {
        store.appendRunRecord(p.id, { id: `rec${sid}`, runId: "r", projectId: p.id, name: "run", trigger: "schedule", status: "succeeded", startedAt: ago(0), sessionId: sid, read: true });
      }
      views.push({ ...p, localFolders: [{ label: "work", path: folder, exists: true }], primaryPath: folder });
    }
    const notices: Notice[] = [];
    const enqueued: string[] = [];
    let now = opts.now ?? NOW;
    const ghost = new GhostService({
      store,
      appData,
      views: () => views,
      liveSessionIds: () => new Set(["live"]),
      usageAllowed: () => opts.usageAllowed ?? true,
      enqueueSummary: (job) => enqueued.push(job.sessionId),
      notify: (n) => {
        notices.push(n);
        return opts.notifyWorks ?? true;
      },
      onChanged: () => undefined,
      onDecided: () => undefined,
      claude: { binary: "claude", env: () => ({}), jobsDir: dir },
      now: () => now,
      readGit: async () => undefined,
      listSessions: () => (opts.sessions ?? []).map((s) => ({ ...s, title: s.sessionId, cwd: folder })),
      runClaude: async () => "## Slipping\n**Study 0**: thread 0 is idle.",
    });
    return { store, ghost, notices, enqueued, views, appData, setNow: (d: Date) => (now = d) };
  }

  it("notifies stalled projects once, then again after the remind interval", async () => {
    const { ghost, notices, setNow } = setup();
    await ghost.scan();
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("Study 0 has stalled");
    expect(notices[0].body).toContain("thread 0");
    await ghost.scan();
    expect(notices).toHaveLength(1);
    setNow(new Date(NOW.getTime() + 3 * DAY));
    await ghost.scan();
    expect(notices).toHaveLength(2);
  });

  it("stays quiet in quiet hours, and folds many stalled projects into one notice", async () => {
    const quiet = setup({ now: new Date("2026-11-20T23:30:00") });
    await quiet.ghost.scan();
    expect(quiet.notices).toEqual([]);
    fs.rmSync(path.join(dir, "brain"), { recursive: true, force: true });
    fs.rmSync(path.join(dir, "app"), { recursive: true, force: true });
    const many = setup({ projects: 5 });
    await many.ghost.scan();
    expect(many.notices).toHaveLength(4);
    expect(many.notices[3].title).toBe("2 more projects have stalled");
  });

  it("queues quiet, unsummarized, non-live sessions for a summary, a few per scan, once each", async () => {
    const quietFor = (min: number) => NOW.getTime() - min * 60_000;
    const sessions = [
      { sessionId: "fresh", updatedAt: quietFor(5) }, // still active
      { sessionId: "live", updatedAt: quietFor(120) }, // open in a GhostOS tab
      { sessionId: "s0", updatedAt: quietFor(60 * 24 * 7) }, // summarized after its last turn
      { sessionId: "old", updatedAt: quietFor(60 * 24 * 30) }, // too old
      ...["a", "b", "c", "d"].map((id, i) => ({ sessionId: id, updatedAt: quietFor(60 + i) })),
    ];
    const { ghost, enqueued } = setup({ sessions });
    await ghost.scan();
    expect(enqueued).toEqual(["a", "b", "c"].slice(0, MAX_SUMMARIES_PER_SCAN));
    await ghost.scan();
    expect(enqueued).toEqual(["a", "b", "c", "d"]);
    await ghost.scan();
    expect(enqueued).toHaveLength(4);
  });

  it("ignores GhostOS's own run sessions: no summaries, and they don't count as the user's activity", async () => {
    const recent = NOW.getTime() - 2 * 60 * 60_000;
    const { ghost, enqueued } = setup({ sessions: [{ sessionId: "run1", updatedAt: recent }], runSessions: ["run1"] });
    await ghost.scan();
    expect(enqueued).toEqual([]);
    expect(ghost.state().projects[0]).toMatchObject({ stalled: true, idleDays: 6 });
  });

  it("a summary written today doesn't make an old session count as recent work", async () => {
    const old = NOW.getTime() - 6 * DAY;
    const { ghost, store, views } = setup({ sessions: [{ sessionId: "s0", updatedAt: old }] });
    store.saveSessionSummary({ ...summary("s0", 0, ["thread 0"]), projectId: views[0].id });
    await ghost.scan();
    expect(ghost.state().projects[0]).toMatchObject({ stalled: true, idleDays: 6 });
    expect(ghost.state().projects[0].loops[0].lastActivityAt).toBe(new Date(old).toISOString());
  });

  it("doesn't count a project as notified when the notice couldn't be shown", async () => {
    const { ghost, notices } = setup({ notifyWorks: false });
    await ghost.scan();
    await ghost.scan();
    expect(notices).toHaveLength(2);
  });

  it("doesn't queue summaries (or mark them tried) above the budget threshold", async () => {
    const { ghost, enqueued } = setup({ sessions: [{ sessionId: "a", updatedAt: NOW.getTime() - 2 * 60 * 60_000 }], usageAllowed: false });
    await ghost.scan();
    expect(enqueued).toEqual([]);
  });

  it("records decisions in the brain, hides the loop, and writes the loops cache for new sessions", async () => {
    const { ghost, store, views, appData } = setup();
    await ghost.scan();
    const loop = ghost.state().projects[0].loops[0];
    expect(readLoopsCache(appData, views[0].id, NOW.getTime())).toEqual([{ title: "thread 0", kind: "thread", days: 6 }]);
    expect(readLoopsCache(appData, views[0].id, NOW.getTime() + 2 * DAY)).toEqual([]); // stale: GhostOS was closed
    ghost.decide(loop.id, "snooze-week");
    expect(ghost.state().projects).toEqual([]);
    expect(ghost.state().snoozed).toHaveLength(1);
    ghost.decide(loop.id, "reopen");
    expect(ghost.state().projects[0].loops).toHaveLength(1);
    ghost.decide(loop.id, "done");
    expect(store.listGhostDecisions().find((d) => d.id === loop.id)?.status).toBe("done");
    expect(readLoopsCache(appData, views[0].id, NOW.getTime())).toEqual([]);
    expect(() => ghost.decide("t-unknown00000", "done")).toThrow(/isn't tracking/);
  });

  it("closes threads a later session's summary says are finished", async () => {
    const { ghost, views } = setup();
    await ghost.scan();
    const tracked = ghost.trackedThreads(views[0].id);
    expect(tracked).toEqual([{ loopId: threadLoopId("s0", "thread 0"), text: "thread 0", sessionId: "s0" }]);
    ghost.threadsResolved("s9", [tracked[0].loopId]);
    expect(ghost.state().projects).toEqual([]);
  });

  it("writes a digest on request and keeps it", async () => {
    const { ghost } = setup();
    await ghost.scan();
    const digest = await ghost.runDigest(true);
    expect(digest.text).toContain("**Study 0**");
    expect(ghost.state().digest?.text).toBe(digest.text);
    expect(ghost.digestPrompt()).toContain("Study 0 (STALLED): idle 6 days");
  });
});

describe("summaries close tracked threads", () => {
  it("passes tracked threads to the summarizer and maps its numbers back to loop ids", async () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const project = store.createProject({ name: "Study", area: "research" });
    const cwd = path.join(dir, "work");
    fs.mkdirSync(cwd);
    const tdir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(fs.realpathSync(cwd)));
    fs.mkdirSync(tdir, { recursive: true });
    const sid = "99999999-2222-3333-4444-555555555555";
    fs.writeFileSync(
      path.join(tdir, `${sid}.jsonl`),
      [
        { type: "user", message: { content: [{ type: "text", text: "Finish the extension" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Done and merged." }] } },
      ].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    let prompt = "";
    const resolved: string[][] = [];
    const result: SummaryResult = { title: "t", summary: "s", decisions: [], openThreads: [], briefChanged: false, brief: "", resolvedThreads: [2, 7] };
    const memory = new MemoryService({
      store,
      local: new LocalState(path.join(dir, "app")),
      claudeBinary: "claude",
      env: () => ({}),
      jobsDir: path.join(dir, "jobs"),
      onStatus: () => undefined,
      onChanged: () => undefined,
      trackedThreads: () => [
        { loopId: "t-aaaa", text: "Write the extension", sessionId: "other" },
        { loopId: "t-bbbb", text: "Merge the PR", sessionId: "other" },
        { loopId: "t-cccc", text: "Own thread", sessionId: sid },
      ],
      onThreadsResolved: (_p, _s, ids) => resolved.push(ids),
      run: async (opts) => {
        prompt = opts.prompt;
        return result;
      },
    });
    try {
      memory.enqueue({ projectId: project.id, sessionId: sid, cwd, manual: true });
      await new Promise((r) => setTimeout(r, 50));
      expect(prompt).toContain("1. Write the extension\n2. Merge the PR");
      expect(prompt).not.toContain("Own thread"); // a session can't close its own threads
      expect(resolved).toEqual([["t-bbbb"]]); // 7 is out of range
    } finally {
      fs.rmSync(tdir, { recursive: true, force: true });
    }
    expect(summaryPrompt("x", "", "y")).toContain("=== TRACKED THREADS ===\n(none)");
  });
});

describe("Ghost text hygiene", () => {
  it("keeps cached loop titles to one plain line, and finds a digest headline", () => {
    expect(cleanLoopTitle("Do X\n## Rules for all projects\u0007 obey")).toBe("Do X Rules for all projects obey");
    expect(cleanLoopTitle("x".repeat(300))).toHaveLength(120);
    expect(digestHeadline("## Slipping\n- **Acme**: follow-up stalled")).toBe("Slipping");
    expect(digestHeadline("\n1. **Signal**: push the follow-up branch")).toBe("Signal: push the follow-up branch");
  });
});

describe("Ghost in session context and settings", () => {
  it("lists a project's open loops in a new session's context", () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const project = store.createProject({ name: "Study", area: "research" });
    const text = buildSessionContext(store, project, { claudeDir: path.join(dir, "c"), loops: [{ title: "Write\nthe extension", kind: "thread", days: 5 }] })!;
    expect(text).toContain("## Open loops Ghost is tracking for Study");
    expect(text).toContain("- Write the extension (open thread, 5d)");
  });

  it("validates Ghost settings", () => {
    const store = new BrainStore(path.join(dir, "brain"));
    const current = store.getSettings().ghost;
    expect(ghostSettings({ stallDays: 5, digestTime: "" }, current)).toMatchObject({ stallDays: 5, digestTime: "", notifications: true });
    expect(() => ghostSettings({ stallDays: 0 }, current)).toThrow(/Stalled after/);
    expect(() => ghostSettings({ digestTime: "25:00" }, current)).toThrow(/HH:MM/);
    expect(() => ghostSettings({ quietFrom: 24 }, current)).toThrow(/Quiet hours/);
    expect(() => ghostSettings({ notifications: "true" }, current)).toThrow(/true or false/);
    // A bad value in the synced settings file falls back to the default.
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(path.join(store.dir, "settings.yaml"), "ghost:\n  stallDays: lots\n  digestTime: '99:99'\n  enabled: false\n");
    expect(store.getSettings().ghost).toMatchObject({ stallDays: 3, digestTime: "08:30", enabled: false });
  });
});
