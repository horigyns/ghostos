// Ghost's view of unfinished work: open loops per project, worked out fresh from what GhostOS already knows
// (session summaries, git state of project folders, run history, saved sidenotes) plus the user's decisions.
// Pure functions over their inputs, so they can be tested without a clock, git or Electron.
import crypto from "node:crypto";
import type { GhostDecision, GhostLoop, GhostProjectStatus, Project, RunDefinition, RunRecord, SessionSummaryDoc, Sidenote } from "../../shared/types";

const DAY_MS = 24 * 60 * 60_000;
/** Open threads from summaries older than this are no longer tracked. */
export const THREAD_WINDOW_DAYS = 60;
/** At most this many thread loops per project (newest first). */
const MAX_THREADS_PER_PROJECT = 15;
const TITLE_MAX_CHARS = 140;
const BRANCHES_LISTED = 4;

/** Git state of one repository folder of a project on this Mac. */
export interface FolderGitState {
  folder: string;
  label: string;
  /** files with uncommitted changes (tracked or new) */
  dirtyCount: number;
  /** newest modification time among those files (ms) */
  dirtyMtime?: number;
  branch?: string;
  /** commits on the current branch not on its upstream */
  ahead: number;
  lastCommitAt?: number;
  /** local branches not merged into the default branch, with their last commit time (ms) */
  unmerged: { name: string; at: number }[];
  defaultBranch?: string;
}

export interface RecentSession {
  sessionId: string;
  title: string;
  cwd: string;
  /** last write to the transcript (ms) */
  updatedAt: number;
}

export interface ProjectInputs {
  project: Pick<Project, "id" | "name">;
  summaries: SessionSummaryDoc[];
  sessions: RecentSession[];
  git: FolderGitState[];
  runs: { defs: RunDefinition[]; records: RunRecord[] };
  sidenotes: Sidenote[];
}

const shortHash = (text: string) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
const clip = (text: string) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > TITLE_MAX_CHARS ? one.slice(0, TITLE_MAX_CHARS - 1) + "…" : one;
};
const iso = (ms: number) => new Date(ms).toISOString();
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Loop ids for git loops start with these, so "dismiss" can mean "snooze" for them (the state comes back by itself). */
export const GIT_LOOP_KINDS = new Set(["uncommitted", "unpushed", "branches"]);

export function threadLoopId(sessionId: string, thread: string): string {
  return `t-${shortHash(`${sessionId}\n${thread.trim()}`)}`;
}

/** A summary's time for activity purposes: its session's last change when known, else when it was written. */
function summaryTime(summary: SessionSummaryDoc, session?: RecentSession): string {
  return session ? iso(Math.min(session.updatedAt, Date.parse(summary.createdAt))) : summary.createdAt;
}

/** Every open loop for one project, before the user's decisions are applied. */
export function projectLoops(input: ProjectInputs, now: Date): GhostLoop[] {
  const { project } = input;
  const loops: GhostLoop[] = [];

  const since = now.getTime() - THREAD_WINDOW_DAYS * DAY_MS;
  const summaries = [...input.summaries].filter((s) => Date.parse(s.createdAt) >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sessionOf = new Map(input.sessions.map((s) => [s.sessionId, s]));
  let threads = 0;
  for (const s of summaries) {
    for (const thread of s.openThreads) {
      if (threads >= MAX_THREADS_PER_PROJECT) break;
      loops.push({
        id: threadLoopId(s.sessionId, thread),
        projectId: project.id,
        kind: "thread",
        title: clip(thread),
        detail: `From "${clip(s.title)}"`,
        // When the session itself last changed, not when its summary was written (that can be much later).
        lastActivityAt: summaryTime(s, sessionOf.get(s.sessionId)),
        sessionId: s.sessionId,
        cwd: sessionOf.get(s.sessionId)?.cwd,
      });
      threads++;
    }
  }

  const seenRepos = new Set<string>();
  for (const g of input.git) {
    if (seenRepos.has(g.folder)) continue;
    seenRepos.add(g.folder);
    const fallback = g.lastCommitAt ?? now.getTime();
    if (g.dirtyCount > 0) {
      loops.push({
        id: `u-${shortHash(g.folder)}`,
        projectId: project.id,
        kind: "uncommitted",
        title: `${plural(g.dirtyCount, "uncommitted change")} in ${g.label}`,
        detail: g.branch ? `on ${g.branch}` : undefined,
        lastActivityAt: iso(g.dirtyMtime ?? fallback),
        folder: g.folder,
      });
    }
    if (g.ahead > 0) {
      loops.push({
        id: `p-${shortHash(`${g.folder}\n${g.branch ?? ""}`)}`,
        projectId: project.id,
        kind: "unpushed",
        title: `${plural(g.ahead, "commit")} on ${g.branch ?? "this branch"} not pushed (${g.label})`,
        lastActivityAt: iso(fallback),
        folder: g.folder,
      });
    }
    if (g.unmerged.length) {
      const sorted = [...g.unmerged].sort((a, b) => b.at - a.at);
      const names = sorted.slice(0, BRANCHES_LISTED).map((b) => b.name).join(", ");
      const more = sorted.length > BRANCHES_LISTED ? ` and ${sorted.length - BRANCHES_LISTED} more` : "";
      loops.push({
        id: `b-${shortHash(g.folder)}`,
        projectId: project.id,
        kind: "branches",
        title: `${plural(sorted.length, "branch", "branches")} not merged into ${g.defaultBranch ?? "main"} (${g.label})`,
        detail: `${names}${more}`,
        lastActivityAt: iso(sorted[0].at),
        folder: g.folder,
      });
    }
  }

  // A run whose latest result failed (a later success clears it).
  for (const def of input.runs.defs) {
    const latest = input.runs.records.filter((r) => r.runId === def.id && r.status !== "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (latest?.status !== "failed") continue;
    loops.push({
      id: `r-${latest.id}`,
      projectId: project.id,
      kind: "run-failed",
      title: `Run "${clip(def.name)}" failed`,
      detail: latest.note ? clip(latest.note) : undefined,
      lastActivityAt: latest.endedAt ?? latest.startedAt,
      sessionId: latest.sessionId,
    });
  }

  for (const note of input.sidenotes) {
    if (note.status !== "saved") continue;
    loops.push({
      id: `s-${note.id}`,
      projectId: project.id,
      kind: "sidenote",
      title: `Saved note: ${clip(note.text)}`,
      lastActivityAt: note.createdAt,
      sessionId: note.sessionId || undefined,
    });
  }
  return loops;
}

/**
 * The newest sign of the user's work on a project: their sessions, commits, uncommitted edits, manual runs, notes,
 * and summaries at their session's time (a summary GhostOS writes days later doesn't count as new work; one from a
 * session on the other Mac, whose transcript isn't here, counts when it was written). Not scheduled runs;
 * `sessions` must already exclude GhostOS's run sessions.
 */
export function projectLastActivity(input: ProjectInputs): number | undefined {
  const times: number[] = [];
  const sessionOf = new Map(input.sessions.map((s) => [s.sessionId, s]));
  for (const s of input.sessions) times.push(s.updatedAt);
  for (const s of input.summaries) times.push(Date.parse(summaryTime(s, sessionOf.get(s.sessionId))));
  for (const g of input.git) {
    if (g.lastCommitAt) times.push(g.lastCommitAt);
    if (g.dirtyMtime) times.push(g.dirtyMtime);
  }
  // Scheduled runs are automatic; only runs the user started count as work.
  for (const r of input.runs.records) if (r.trigger === "manual") times.push(Date.parse(r.startedAt));
  for (const n of input.sidenotes) times.push(Date.parse(n.createdAt));
  const valid = times.filter((t) => Number.isFinite(t));
  return valid.length ? Math.max(...valid) : undefined;
}

export interface GhostView {
  projects: GhostProjectStatus[];
  snoozed: { loop: GhostLoop; until: string }[];
}

/** Applies decisions and works out which projects are stalled. */
export function ghostView(inputs: ProjectInputs[], decisions: GhostDecision[], stallDays: number, now: Date): GhostView {
  const decided = new Map(decisions.map((d) => [d.id, d]));
  const projects: GhostProjectStatus[] = [];
  const snoozed: GhostView["snoozed"] = [];
  for (const input of inputs) {
    const open: GhostLoop[] = [];
    for (const loop of projectLoops(input, now)) {
      const d = decided.get(loop.id);
      if (d?.status === "done" || d?.status === "dismissed") continue;
      if (d?.status === "snoozed" && d.snoozeUntil && Date.parse(d.snoozeUntil) > now.getTime()) {
        snoozed.push({ loop, until: d.snoozeUntil });
        continue;
      }
      open.push(loop);
    }
    if (!open.length) continue;
    open.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    const last = projectLastActivity(input);
    const idleDays = last === undefined ? undefined : Math.floor((now.getTime() - last) / DAY_MS);
    projects.push({
      projectId: input.project.id,
      lastActivityAt: last === undefined ? undefined : iso(last),
      idleDays,
      stalled: idleDays !== undefined && idleDays >= stallDays,
      loops: open,
    });
  }
  projects.sort((a, b) => Number(b.stalled) - Number(a.stalled) || (b.idleDays ?? 0) - (a.idleDays ?? 0) || b.loops.length - a.loops.length);
  return { projects, snoozed };
}

/** True when `hour` (0-23) is inside quiet hours from..to (wrapping past midnight); from === to means never. */
export function inQuietHours(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** One line for a notification, e.g. "Idle 4 days · 3 open threads, uncommitted changes". */
export function stalledSummary(status: GhostProjectStatus): string {
  const counts = new Map<string, number>();
  for (const l of status.loops) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
  const parts: string[] = [];
  const threads = counts.get("thread");
  if (threads) parts.push(plural(threads, "open thread"));
  if (counts.get("uncommitted")) parts.push("uncommitted changes");
  if (counts.get("unpushed")) parts.push("unpushed commits");
  if (counts.get("branches")) parts.push("unmerged branches");
  const failed = counts.get("run-failed");
  if (failed) parts.push(plural(failed, "failed run"));
  const notes = counts.get("sidenote");
  if (notes) parts.push(plural(notes, "saved note"));
  return `Idle ${plural(status.idleDays ?? 0, "day")} · ${parts.join(", ")}`;
}
