import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunDefinition, UsageSnapshot } from "../src/shared/types";
import { describeSchedule, isDue, lastSlot, validateSchedule } from "../src/main/runs/schedule";
import { backgroundAllowed, decideRun } from "../src/main/runs/budget";
import { LOCK_HEARTBEAT_STALE_MS, LocalState, bootTime } from "../src/main/runs/local-state";
import { BrainStore, DEFAULT_SETTINGS } from "../src/main/brain/store";
import { tick } from "../src/main/runs/tick";
import { reconcileInterruptedRuns } from "../src/main/runs/executor";

const budget = DEFAULT_SETTINGS.budget;
const H = 3_600_000;

function def(schedule: RunDefinition["schedule"], createdAt = "2026-01-01T00:00:00"): RunDefinition {
  return {
    id: "r1",
    projectId: "p",
    name: "Daily digest",
    prompt: "Summarize",
    schedule,
    permissionMode: "auto",
    runOn: "mini",
    enabled: true,
    createdAt: new Date(createdAt).toISOString(),
  };
}

describe("schedule", () => {
  it("finds the latest daily and weekly slot in local time", () => {
    const now = new Date(2026, 10, 13, 10, 30); // Fri Nov 13 2026 10:30
    expect(lastSlot({ kind: "daily", time: "09:00" }, now)).toEqual(new Date(2026, 10, 13, 9, 0));
    expect(lastSlot({ kind: "daily", time: "11:00" }, now)).toEqual(new Date(2026, 10, 12, 11, 0));
    expect(lastSlot({ kind: "weekly", days: [1], time: "09:00" }, now)).toEqual(new Date(2026, 10, 9, 9, 0)); // Monday
  });

  it("runs a daily slot once, catches up after a short sleep, and skips long-missed slots", () => {
    const d = def({ kind: "daily", time: "09:00" });
    expect(isDue(d, {}, new Date(2026, 10, 13, 9, 1))).toBe(true);
    expect(isDue(d, { lastStartAt: new Date(2026, 10, 13, 9, 1).getTime() }, new Date(2026, 10, 13, 9, 30))).toBe(false);
    expect(isDue(d, {}, new Date(2026, 10, 13, 14, 0))).toBe(true); // 5 h late: still within catch-up
    expect(isDue(d, {}, new Date(2026, 10, 13, 20, 0))).toBe(false); // 11 h late: skipped
  });

  it("never runs slots from before the run was created, or while disabled or deferred", () => {
    const now = new Date(2026, 10, 13, 9, 5);
    expect(isDue(def({ kind: "daily", time: "09:00" }, "2026-11-13T09:02:00"), {}, now)).toBe(false);
    expect(isDue({ ...def({ kind: "daily", time: "09:00" }), enabled: false }, {}, now)).toBe(false);
    expect(isDue(def({ kind: "daily", time: "09:00" }), { deferUntil: now.getTime() + H }, now)).toBe(false);
  });

  it("doesn't fire a run just because its schedule was edited, and lets a deferred run catch up after the wait", () => {
    const edited = { ...def({ kind: "daily", time: "17:00" }), updatedAt: new Date(2026, 10, 13, 18, 0).toISOString() };
    expect(isDue(edited, {}, new Date(2026, 10, 13, 18, 1))).toBe(false); // today's 17:00 was before the edit
    expect(isDue(edited, {}, new Date(2026, 10, 14, 17, 1))).toBe(true);
    const d = def({ kind: "daily", time: "09:00" });
    const resetAt = new Date(2026, 10, 13, 14, 10).getTime(); // waited 5 h for the 5-hour window
    expect(isDue(d, { deferUntil: resetAt }, new Date(2026, 10, 13, 15, 30))).toBe(true); // 6.5 h after the slot, 1.3 h after the wait
  });

  it("runs interval schedules every N minutes", () => {
    const d = def({ kind: "interval", everyMinutes: 60 }, "2026-11-13T08:00:00");
    expect(isDue(d, {}, new Date("2026-11-13T08:30:00"))).toBe(false);
    expect(isDue(d, {}, new Date("2026-11-13T09:00:00"))).toBe(true);
    expect(isDue(d, { lastStartAt: Date.parse("2026-11-13T09:00:00") }, new Date("2026-11-13T09:30:00"))).toBe(false);
  });

  it("validates and describes schedules", () => {
    expect(() => validateSchedule({ kind: "daily", time: "25:00" })).toThrow();
    expect(() => validateSchedule({ kind: "interval", everyMinutes: 1 })).toThrow();
    expect(() => validateSchedule({ kind: "weekly", days: [], time: "09:00" })).toThrow();
    expect(describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:30" })).toBe("Weekdays at 08:30");
    expect(describeSchedule({ kind: "interval", everyMinutes: 120 })).toBe("Every 2 h");
  });
});

describe("budget guard", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  const usage = (week: number, fiveHour: number): UsageSnapshot => ({
    sevenDayPct: week,
    sevenDayResetsAt: now / 1000 + 3 * 24 * 3600,
    fiveHourPct: fiveHour,
    fiveHourResetsAt: now / 1000 + 2 * 3600,
    observedAt: now - 60_000,
  });

  it("runs normally when usage is low or unknown", () => {
    expect(decideRun("opus", usage(30, 10), budget, now)).toEqual({ action: "run", model: "opus" });
    expect(decideRun("opus", undefined, budget, now)).toEqual({ action: "run", model: "opus" });
  });

  it("switches to the cheaper model, waits out a full 5-hour window, and skips near the weekly limit", () => {
    expect(decideRun("opus", usage(75, 10), budget, now)).toMatchObject({ action: "run", model: "sonnet" });
    expect(decideRun("haiku", usage(75, 10), budget, now)).toMatchObject({ action: "run", model: "haiku" });
    expect(decideRun("claude-haiku-5-5", usage(75, 10), budget, now)).toMatchObject({ action: "run", model: "claude-haiku-5-5" });
    expect(decideRun("opus", usage(40, 90), budget, now)).toMatchObject({ action: "defer", until: now + 2 * H });
    expect(decideRun("opus", usage(95, 10), budget, now)).toMatchObject({ action: "skip" });
  });

  it("ignores windows that have already reset and stale observations", () => {
    const reset: UsageSnapshot = { ...usage(95, 95), sevenDayResetsAt: now / 1000 - 10, fiveHourResetsAt: now / 1000 - 10 };
    expect(decideRun("opus", reset, budget, now)).toMatchObject({ action: "run", model: "opus" });
    expect(decideRun("opus", { ...usage(95, 95), observedAt: now - 7 * H }, budget, now)).toMatchObject({ action: "run" });
    expect(backgroundAllowed(usage(95, 10), budget, now)).toBe(false);
    expect(backgroundAllowed(usage(50, 10), budget, now)).toBe(true);
  });
});

describe("local state and the scheduler", () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-runs-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("lets only one runner hold the lock, steals abandoned locks, and never releases someone else's", () => {
    const local = new LocalState(dir);
    const lockFile = path.join(dir, "runner.lock");
    const live = { pid: process.ppid, token: "other", at: Date.now(), bootAt: bootTime() };
    fs.writeFileSync(lockFile, JSON.stringify(live));
    expect(local.tryLock()).toBeUndefined(); // held by a live process
    expect(local.lockHeldByOther()).toBe(true);
    fs.writeFileSync(lockFile, JSON.stringify({ ...live, bootAt: bootTime() - 86_400_000 })); // from before a reboot
    const mine = local.tryLock();
    expect(mine).toBeDefined();
    expect(new LocalState(dir).tryLock()).toBeUndefined(); // now held by us
    fs.writeFileSync(lockFile, JSON.stringify({ ...live, token: "newer" })); // someone else took over
    mine!.release();
    expect(fs.existsSync(lockFile)).toBe(true); // our release didn't remove their lock
    fs.writeFileSync(lockFile, JSON.stringify({ ...live, at: Date.now() - LOCK_HEARTBEAT_STALE_MS - 1 }));
    expect(local.tryLock()).toBeDefined(); // no heartbeat for too long: abandoned
  });

  it("keeps the newest usage", () => {
    const local = new LocalState(dir);
    local.recordUsage({ sevenDayPct: 40, observedAt: 2 });
    local.recordUsage({ sevenDayPct: 10, observedAt: 1 });
    local.recordUsage({ fiveHourPct: 5, observedAt: 3 });
    expect(local.getUsage()).toMatchObject({ sevenDayPct: 40, fiveHourPct: 5, observedAt: 3 });
  });

  it("records a skipped run once and doesn't start it again in the same slot", async () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const project = store.createProject({ name: "Persona study", area: "research" });
    const run = { ...def({ kind: "daily", time: "09:00" }), projectId: project.id };
    store.saveRun(run);
    const local = new LocalState(path.join(dir, "app"));
    local.approve(run);
    local.recordUsage({ sevenDayPct: 95, sevenDayResetsAt: Date.now() / 1000 + 86_400, observedAt: Date.now() });
    const ctx = {
      store,
      local,
      claudeBinary: "/nonexistent/claude",
      env: {},
      machineId: "mini",
      folderFor: () => dir,
      onBrainChanged: () => undefined,
    };
    const now = new Date();
    now.setHours(9, 10, 0, 0);
    expect(await tick(ctx, now)).toBe(0);
    expect(await tick(ctx, new Date(now.getTime() + 60_000))).toBe(0);
    const records = store.listRunRecords(project.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "skipped", read: false });
    expect(records[0].note).toMatch(/weekly usage is at 95%/);
  });

  it("doesn't start runs of an archived project", async () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const project = store.createProject({ name: "Acme ad agent", area: "work" });
    const run = { ...def({ kind: "daily", time: "09:00" }), projectId: project.id };
    store.saveRun(run);
    store.updateProject(project.id, { archived: true });
    const local = new LocalState(path.join(dir, "app"));
    local.approve(run);
    local.recordUsage({ sevenDayPct: 95, sevenDayResetsAt: Date.now() / 1000 + 86_400, observedAt: Date.now() });
    const ctx = { store, local, claudeBinary: "/nonexistent/claude", env: {}, machineId: "mini", folderFor: () => dir, onBrainChanged: () => undefined };
    const now = new Date();
    now.setHours(9, 10, 0, 0);
    expect(await tick(ctx, now)).toBe(0);
    // Not even a "skipped" record: the scheduler doesn't look at it.
    expect(store.listRunRecords(project.id)).toHaveLength(0);
  });

  it("doesn't start runs that weren't approved on this Mac", async () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const project = store.createProject({ name: "Synced", area: "random" });
    store.saveRun({ ...def({ kind: "interval", everyMinutes: 5 }, "2026-01-01T00:00:00"), projectId: project.id });
    const local = new LocalState(path.join(dir, "app"));
    const ctx = { store, local, claudeBinary: "/nonexistent/claude", env: {}, machineId: "mini", folderFor: () => dir, onBrainChanged: () => undefined };
    expect(await tick(ctx)).toBe(0);
    expect(store.listRunRecords(project.id)).toHaveLength(0);
  });

  it("closes runs left running by a process that is gone", () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const p = store.createProject({ name: "X", area: "random" });
    store.appendRunRecord(p.id, { id: "dead", runId: "r", name: "n", status: "running", startedAt: new Date().toISOString(), read: false, ownerPid: 999_999, ownerBootAt: bootTime() });
    store.appendRunRecord(p.id, { id: "alive", runId: "r2", name: "n", status: "running", startedAt: new Date().toISOString(), read: false, ownerPid: process.pid, ownerBootAt: bootTime() });
    expect(reconcileInterruptedRuns(store)).toBe(1);
    const records = Object.fromEntries(store.listRunRecords(p.id).map((r) => [r.id, r]));
    expect(records.dead.status).toBe("failed");
    expect(records.dead.note).toMatch(/Interrupted/);
    expect(records.alive.status).toBe("running");
  });

  it("merges appended run records, newest first", () => {
    const store = new BrainStore(path.join(dir, "brain"));
    store.ensure();
    const p = store.createProject({ name: "X", area: "random" });
    store.appendRunRecord(p.id, { id: "a", runId: "r", name: "n", status: "running", startedAt: "2026-11-13T09:00:00Z", read: false });
    store.appendRunRecord(p.id, { id: "b", runId: "r", name: "n", status: "succeeded", startedAt: "2026-11-13T10:00:00Z", read: false });
    store.appendRunRecord(p.id, { id: "a", status: "failed", note: "timed out" });
    store.appendRunRecord(p.id, { id: "a", read: true });
    const records = store.listRunRecords(p.id);
    expect(records.map((r) => r.id)).toEqual(["b", "a"]);
    expect(records[1]).toMatchObject({ status: "failed", note: "timed out", read: true });
  });
});
