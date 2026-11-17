import { describe, expect, it } from "vitest";
import { boardItems, briefDiff, greeting, pendingQuestion, shortAge, type BoardInputs } from "../src/renderer/board";
import type { ChatEvent, GhostState, LiveSession, ProjectView, RunRecord } from "../src/shared/types";

const NOW = Date.parse("2026-11-16T15:00:00Z");
const DAY = 24 * 60 * 60_000;

function project(id: string, extra: Partial<ProjectView> = {}): ProjectView {
  return { id, name: id.toUpperCase(), area: "work", folders: [], createdAt: "2026-01-01", localFolders: [], primaryPath: `/p/${id}`, ...extra };
}

function session(key: string, projectId: string, extra: Partial<LiveSession> = {}): LiveSession {
  return { key, projectId, cwd: `/p/${projectId}`, title: `Chat ${key}`, view: "chat", busy: false, permissionMode: "auto", ...extra };
}

const asked: ChatEvent[] = [
  { kind: "user", text: "Tighten the hero copy" },
  { kind: "assistant-text", text: "Two options drafted.\n\nKeep the outcome-led one?" },
  { kind: "turn-end", ok: true },
];

function inputs(extra: Partial<BoardInputs> = {}): BoardInputs {
  return { projects: [project("a"), project("b")], live: [], events: {}, activityAt: {}, unreadRuns: {}, pendingBriefs: [], ghost: null, hidden: {}, scope: null, now: NOW, ...extra };
}

describe("pendingQuestion", () => {
  it("finds a question at the end of the last turn", () => {
    expect(pendingQuestion(asked)?.text).toContain("Keep the outcome-led one?");
  });
  it("ignores a question the user already answered", () => {
    expect(pendingQuestion([...asked, { kind: "user", text: "yes" }])).toBeUndefined();
  });
  it("ignores a question in an earlier paragraph", () => {
    expect(pendingQuestion([{ kind: "user", text: "x" }, { kind: "assistant-text", text: "Why? Because.\n\nDone." }, { kind: "turn-end", ok: true }])).toBeUndefined();
  });
  it("ignores a question mark that isn't the end of the reply", () => {
    const reply = (text: string): ChatEvent[] => [{ kind: "user", text: "x" }, { kind: "assistant-text", text }, { kind: "turn-end", ok: true }];
    expect(pendingQuestion(reply("Deployed to https://example.com/?ref=a"))).toBeUndefined();
    expect(pendingQuestion(reply("Shall I push?\n\n```\nwhat?\n```"))?.text).toContain("Shall I push?");
    expect(pendingQuestion(reply("Want me to add it? (I'd keep the old one)"))).toBeUndefined();
    expect(pendingQuestion(reply("Want me to **add it?**"))).toBeDefined();
  });
  it("ignores a failed turn", () => {
    expect(pendingQuestion([{ kind: "user", text: "x" }, { kind: "assistant-text", text: "Ok?" }, { kind: "turn-end", ok: false }])).toBeUndefined();
  });
});

describe("boardItems", () => {
  it("lists questions, failed runs and briefs as needing action, before unfinished loops", () => {
    const run: RunRecord = { id: "r1", runId: "d1", projectId: "b", name: "Nightly", trigger: "schedule", status: "failed", startedAt: new Date(NOW - DAY).toISOString(), read: false };
    const ghost: GhostState = {
      enabled: true,
      scanning: false,
      projects: [{ projectId: "a", stalled: true, loops: [{ id: "t1", projectId: "a", kind: "thread", title: "Finish the bio", detail: 'From "Bio rewrite"', lastActivityAt: new Date(NOW - 4 * DAY).toISOString(), sessionId: "s-1" }] }],
      snoozed: [],
      digestRunning: false,
      summarizedLastScan: 0,
      stallDays: 3,
    };
    const items = boardItems(inputs({ live: [session("k1", "a")], events: { k1: asked }, activityAt: { k1: NOW - 60_000 }, unreadRuns: { b: run }, pendingBriefs: ["a"], ghost }));
    expect(items.map((i) => [i.group, i.kind])).toEqual([
      ["needs", "brief"],
      ["needs", "ask"],
      ["needs", "run"],
      ["unfinished", "stalled"],
    ]);
    expect(items.find((i) => i.kind === "run")?.tone).toBe("bad");
    expect(items.find((i) => i.kind === "stalled")?.reason).toEqual({ lead: "Idle 4 days in", name: "Bio rewrite", tail: "A" });
  });

  it("filters to the scoped project and drops hidden items until their time", () => {
    const base = inputs({ pendingBriefs: ["a", "b"], scope: "b" });
    expect(boardItems(base).map((i) => i.projectId)).toEqual(["b"]);
    expect(boardItems({ ...base, hidden: { "brief:b": NOW + 1 } })).toEqual([]);
    expect(boardItems({ ...base, hidden: { "brief:b": NOW - 1 } })).toHaveLength(1);
  });

  it("leaves out archived projects and busy sessions", () => {
    const items = boardItems(inputs({ projects: [project("a", { archived: true }), project("b")], live: [session("k1", "b", { busy: true })], events: { k1: asked }, pendingBriefs: ["a"] }));
    expect(items).toEqual([]);
  });
});

describe("helpers", () => {
  it("formats short ages", () => {
    expect(shortAge(NOW - 30_000, NOW)).toBe("now");
    expect(shortAge(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(shortAge(NOW - 3 * 60 * 60_000, NOW)).toBe("3h");
    expect(shortAge(NOW - 2 * DAY, NOW)).toBe("2d");
    expect(shortAge(NOW - 21 * DAY, NOW)).toBe("3w");
  });
  it("greets by the hour", () => {
    expect([greeting(9), greeting(13), greeting(20)]).toEqual(["Good morning", "Good afternoon", "Good evening"]);
  });
  it("diffs a brief by line", () => {
    expect(briefDiff("Keep\nOld line", "Keep\nNew line")).toEqual([
      { sign: "-", text: "Old line" },
      { sign: "+", text: "New line" },
    ]);
  });
});
