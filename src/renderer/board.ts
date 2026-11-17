// What the Board shows: everything that needs action or is unfinished, across projects, as one ranked list.
// Pure functions only, so the ranking can be tested without a window.
import type { ChatEvent, GhostLoop, GhostState, LiveSession, ProjectView, RunRecord } from "../shared/types";

export type BoardKind = "ask" | "run" | "brief" | "stalled" | "git";
/** status-dot tones, shared with the running strip */
export type Tone = "busy" | "idle" | "wait" | "bad" | "ok";

export interface BoardItem {
  /** stable while the thing it points at is unchanged, so done and snooze stick */
  id: string;
  group: "needs" | "unfinished";
  kind: BoardKind;
  tone: Tone;
  projectId: string;
  title: string;
  /** the second line: words, then a bold name, then more words */
  reason: { lead: string; name: string; tail?: string };
  /** where it came from, for the detail kicker ("Session", "Scheduled run", "Brief", a loop kind) */
  source: string;
  /** when it happened (ms), for the age and the sort */
  at: number;
  /** no real time is known (a pending brief); the age is not shown */
  timeless?: boolean;
  ask?: { sessionKey: string; text: string };
  run?: RunRecord;
  loop?: GhostLoop;
}

export interface BoardInputs {
  projects: ProjectView[];
  live: LiveSession[];
  events: Record<string, ChatEvent[]>;
  /** when each live session last changed (ms) */
  activityAt: Record<string, number>;
  /** newest unread finished run per project */
  unreadRuns: Record<string, RunRecord>;
  pendingBriefs: string[];
  ghost: GhostState | null;
  /** item id -> hidden until (ms) */
  hidden: Record<string, number>;
  scope: string | null;
  now: number;
}

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const DAYS_PER_WEEK = 7;
const LOOP_SOURCE: Record<GhostLoop["kind"], string> = {
  thread: "Open thread",
  uncommitted: "Uncommitted",
  unpushed: "Unpushed",
  branches: "Unmerged",
  "run-failed": "Failed run",
  sidenote: "Saved note",
};
const GIT_LOOPS = new Set<GhostLoop["kind"]>(["uncommitted", "unpushed", "branches"]);

/** A short, stable hash of a string (djb2), for ids. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** "now", "12m", "3h", "2d", "3w": the short age on queue rows. */
export function shortAge(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE_MS) return "now";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  const days = Math.floor(ms / DAY_MS);
  return days < DAYS_PER_WEEK * 2 ? `${days}d` : `${Math.floor(days / DAYS_PER_WEEK)}w`;
}

export function greeting(hour: number): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/**
 * Claude's question, when a chat's last turn ended with one and you haven't answered: the last reply after your
 * last message, if its final paragraph asks something. Returns the reply text and the index of the turn's end.
 */
export function pendingQuestion(events: ChatEvent[]): { text: string; turnEnd: number } | undefined {
  let lastUser = -1;
  let lastEnd = -1;
  events.forEach((e, i) => {
    if (e.kind === "user") lastUser = i;
    if (e.kind === "turn-end") lastEnd = i;
  });
  if (lastEnd < 0 || lastEnd < lastUser) return undefined;
  const turnEnd = events[lastEnd];
  if (turnEnd.kind !== "turn-end" || !turnEnd.ok) return undefined;
  let text = "";
  for (let i = lastEnd; i > lastUser; i--) {
    const e = events[i];
    if (e.kind === "assistant-text") {
      text = e.text;
      break;
    }
  }
  // Only a reply that ends by asking: its last paragraph (outside code) ends with "?".
  const prose = text.replace(/```[\s\S]*?```/g, "").trim();
  const paragraphs = prose.split(/\n\s*\n/).filter((p) => p.trim());
  const last = (paragraphs[paragraphs.length - 1] ?? "").trim().replace(/[)"'”’*_\s]+$/, "");
  return last.endsWith("?") ? { text: text.trim(), turnEnd: lastEnd } : undefined;
}

/** Whether a live session is waiting on the user (its turn ended with a question). */
export function isWaiting(session: LiveSession, events: ChatEvent[] | undefined): boolean {
  return session.view === "chat" && !session.busy && !!events && !!pendingQuestion(events);
}

export function sessionTone(session: LiveSession, events: ChatEvent[] | undefined): Tone {
  if (session.busy) return "busy";
  return isWaiting(session, events) ? "wait" : "idle";
}

export function sessionLabel(tone: Tone): string {
  return tone === "busy" ? "working…" : tone === "wait" ? "waiting on you" : "idle";
}

/** The session title a thread loop came from ('From "X"' -> X). */
function loopSource(loop: GhostLoop): string {
  return loop.detail?.match(/^From "(.*)"$/)?.[1] ?? loop.detail ?? "";
}

export function boardItems(input: BoardInputs): BoardItem[] {
  const active = new Map(input.projects.filter((p) => !p.archived).map((p) => [p.id, p]));
  const name = (id: string) => active.get(id)?.name ?? "";
  const items: BoardItem[] = [];

  for (const s of input.live) {
    if (!active.has(s.projectId) || s.busy || s.view !== "chat") continue;
    const q = pendingQuestion(input.events[s.key] ?? []);
    if (!q) continue;
    items.push({
      // Keyed by what was asked, so replaying history (terminal toggle, reload) keeps the same id.
      id: `ask:${s.sessionId ?? s.key}:${hash(q.text)}`,
      group: "needs",
      kind: "ask",
      tone: "wait",
      projectId: s.projectId,
      title: s.title,
      reason: { lead: "Claude asked in", name: s.title, tail: name(s.projectId) },
      source: "Session",
      at: input.activityAt[s.key] ?? input.now,
      ask: { sessionKey: s.key, text: q.text },
    });
  }

  for (const [projectId, run] of Object.entries(input.unreadRuns)) {
    if (!active.has(projectId)) continue;
    const failed = run.status === "failed";
    const skipped = run.status === "skipped";
    items.push({
      id: `run:${run.id}`,
      group: "needs",
      kind: "run",
      tone: failed ? "bad" : skipped ? "wait" : "ok",
      projectId,
      title: run.name,
      reason: { lead: failed ? "Run failed in" : skipped ? "Run skipped in" : "Run finished in", name: name(projectId) },
      source: run.trigger === "manual" ? "Manual run" : "Scheduled run",
      at: Date.parse(run.endedAt ?? run.startedAt) || input.now,
      run,
    });
  }

  for (const projectId of input.pendingBriefs) {
    if (!active.has(projectId)) continue;
    items.push({
      id: `brief:${projectId}`,
      group: "needs",
      kind: "brief",
      tone: "wait",
      projectId,
      title: `Update the brief for ${name(projectId)}`,
      reason: { lead: "Brief update waiting in", name: name(projectId) },
      source: "Brief",
      at: input.now,
      timeless: true,
    });
  }

  if (input.ghost?.enabled) {
    const runItems = new Set(items.flatMap((i) => (i.run ? [`r-${i.run.id}`] : [])));
    for (const status of input.ghost.projects) {
      if (!active.has(status.projectId)) continue;
      for (const loop of status.loops) {
        // A failed run already on the board as unread doesn't need a second row.
        if (loop.kind === "run-failed" && runItems.has(loop.id)) continue;
        const at = Date.parse(loop.lastActivityAt) || input.now;
        const idleDays = Math.floor((input.now - at) / DAY_MS);
        const git = GIT_LOOPS.has(loop.kind);
        items.push({
          id: `loop:${loop.id}`,
          group: "unfinished",
          kind: git ? "git" : loop.kind === "run-failed" ? "run" : "stalled",
          tone: loop.kind === "run-failed" ? "bad" : status.stalled ? "wait" : "idle",
          projectId: loop.projectId,
          title: loop.title,
          reason: git
            ? { lead: `${LOOP_SOURCE[loop.kind]} in`, name: name(loop.projectId) }
            : loopSource(loop)
              ? { lead: idleDays > 0 ? `Idle ${idleDays} day${idleDays === 1 ? "" : "s"} in` : "Open in", name: loopSource(loop), tail: name(loop.projectId) }
              : { lead: `${LOOP_SOURCE[loop.kind]} in`, name: name(loop.projectId) },
          source: LOOP_SOURCE[loop.kind],
          at,
          loop,
        });
      }
    }
  }

  return items
    .filter((i) => !input.scope || i.projectId === input.scope)
    .filter((i) => !(input.hidden[i.id] > input.now))
    .sort((a, b) => (a.group !== b.group ? (a.group === "needs" ? -1 : 1) : b.at - a.at || a.title.localeCompare(b.title)));
}

/** Lines of a brief that the proposal removes ("-") or adds ("+"), in order, for the approval block. */
export function briefDiff(current: string, proposed: string): { sign: "+" | "-"; text: string }[] {
  const before = current.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const after = proposed.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const kept = new Set(before.filter((l) => after.includes(l)));
  return [
    ...before.filter((l) => !kept.has(l)).map((text) => ({ sign: "-" as const, text })),
    ...after.filter((l) => !kept.has(l)).map((text) => ({ sign: "+" as const, text })),
  ];
}
