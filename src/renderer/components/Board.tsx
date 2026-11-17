import { useEffect, useState } from "react";
import type { MemoryState } from "../../shared/api";
import type { ProjectView, RunDefinition } from "../../shared/types";
import { briefDiff, greeting, shortAge, type BoardItem } from "../board";
import { FormattedText } from "./chatParts";
import { GhostMark } from "./GhostMark";
import { loopPrompt } from "./sessionChoices";

const KIND_LABEL: Record<BoardItem["kind"], string> = { ask: "Question", run: "Run", brief: "Approval", stalled: "Stalled", git: "Git" };
const QUICK_REPLIES = ["Yes, go ahead", "No, leave it"];
const LOG_TAIL_LINES = 14;
const EMPTY_MARK_PX = 96;
const DAY_MS = 24 * 60 * 60_000;
/** after an action that changes the underlying state (a brief approved, a loop decided), hide the row until the
    app catches up; the item then goes away on its own, and comes back if the change didn't stick */
const SETTLE_MS = 10 * 60_000;
/** "done" for things that have no done state of their own (a question you'll answer elsewhere): hidden for good */
export const HIDE_FOREVER = Number.MAX_SAFE_INTEGER;
const GIT_KINDS = new Set(["uncommitted", "unpushed", "branches"]);

export interface BoardActions {
  /** shows a live session on Sessions */
  openLive: (key: string) => void;
  /** resumes a session by id and shows it */
  openSessionById: (projectId: string, sessionId: string, title: string) => void;
  /** starts a new session in a project folder and sends the text; false when it couldn't (the error is reported) */
  startSession: (projectId: string, text: string, cwd?: string) => Promise<boolean>;
  /** the Projects page, on a sub-view */
  showProject: (projectId: string, view?: "runs" | "memory") => void;
  /** hides an item from the board until a time (ms) */
  hide: (id: string, until: number) => void;
  toast: (text: string) => void;
  onError: (err: unknown) => void;
}

interface Props extends BoardActions {
  items: BoardItem[];
  /** items needing action in projects outside the scope */
  needsElsewhere: number;
  projects: ProjectView[];
  scope: ProjectView | null;
  now: number;
}

function tail(text: string, lines: number): string {
  const all = text.trimEnd().split("\n");
  return (all.length > lines ? ["…", ...all.slice(-lines)] : all).join("\n");
}

/** Board: everything that needs action or is unfinished, as a queue on the left and the selected item on the right. */
export function Board(props: Props) {
  const { items, projects, scope, now } = props;
  const [selected, setSelected] = useState<string | undefined>();
  const current = items.find((i) => i.id === selected) ?? items[0];
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? "";

  /** Takes an item off the board: hides it, moves the selection on, and says what happened. */
  const resolve = (item: BoardItem, message: string, until = HIDE_FOREVER) => {
    const i = items.indexOf(item);
    props.hide(item.id, until);
    setSelected((items[i + 1] ?? items[i - 1])?.id);
    props.toast(message);
  };

  /** Ghost keeps the decision (synced); the row is only hidden until Ghost's state catches up. */
  const decideLoop = (item: BoardItem, action: "done" | "snooze-day", message: string) => {
    if (!item.loop) return;
    window.ghost.ghost
      .decide(item.loop.id, action)
      .then(() => resolve(item, message, Date.now() + (action === "done" ? SETTLE_MS : DAY_MS)))
      .catch(props.onError);
  };

  const done = (item: BoardItem) => {
    // Git work is a fact about the repo, not something to mark done; it clears when the repo does.
    if (item.loop && GIT_KINDS.has(item.loop.kind)) return decideLoop(item, "snooze-day", "Snoozed until tomorrow");
    if (item.loop) return decideLoop(item, "done", "Marked done");
    if (item.run) {
      const runId = item.run.id;
      window.ghost.runs
        .markRead(item.projectId, runId)
        .then(() => resolve(item, "Marked read", Date.now() + SETTLE_MS))
        .catch(props.onError);
      return;
    }
    if (item.kind === "brief") return props.toast("Approve the update or keep the old brief.");
    resolve(item, "Marked done");
  };

  const snooze = (item: BoardItem) => {
    if (item.loop) return decideLoop(item, "snooze-day", "Snoozed until tomorrow");
    resolve(item, "Snoozed until tomorrow", Date.now() + DAY_MS);
  };

  const startAndResolve = (item: BoardItem, text: string, cwd?: string) =>
    void props.startSession(item.projectId, text, cwd).then((ok) => ok && resolve(item, "Session started", Date.now() + DAY_MS));

  const open = (item: BoardItem) => {
    if (item.ask) return props.openLive(item.ask.sessionKey);
    const sessionId = item.run?.sessionId ?? item.loop?.sessionId;
    if (sessionId) return props.openSessionById(item.projectId, sessionId, item.title);
    props.showProject(item.projectId, item.kind === "run" ? "runs" : item.kind === "brief" ? "memory" : undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      const focus = active?.tagName;
      if (focus === "INPUT" || focus === "TEXTAREA" || focus === "SELECT" || document.querySelector(".overlay")) return;
      // A focused button in the detail pane handles its own Enter; don't also open the session.
      if (focus === "BUTTON" && !active?.classList.contains("q-item")) return;
      const i = current ? items.indexOf(current) : -1;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelected(items[Math.min(i + 1, items.length - 1)]?.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected(items[Math.max(i - 1, 0)]?.id);
      } else if (current && e.key === "e") done(current);
      else if (current && e.key === "s") snooze(current);
      else if (current && e.key === "Enter") open(current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const needs = items.filter((i) => i.group === "needs");
  const unfinished = items.filter((i) => i.group === "unfinished");
  const row = (item: BoardItem) => (
    <button key={item.id} className={`q-item ${item.id === current?.id ? "sel" : ""}`} onClick={() => setSelected(item.id)} onDoubleClick={() => open(item)}>
      <span className={`dot ${item.tone}`} />
      <span className="t ellipsis">{item.title}</span>
      <span className="a">{item.timeless ? "" : shortAge(item.at, now)}</span>
      <span className="w ellipsis">
        {item.reason.lead} <b>{item.reason.name}</b>
        {item.reason.tail ? ` · ${item.reason.tail}` : ""}
      </span>
    </button>
  );

  return (
    <div className="board">
      <div className="queue">
        <div className="q-head">
          <h1>{greeting(new Date(now).getHours())}</h1>
          <span className="faint">
            Board · {scope?.name ?? "All projects"} · {needs.length} need action · {unfinished.length} unfinished
          </span>
          {scope && props.needsElsewhere > 0 && <span className="warn-text small-note">{props.needsElsewhere} more need action in other projects</span>}
        </div>
        <div className="q-list">
          {needs.length > 0 && <div className="q-sec">Needs action</div>}
          {needs.map(row)}
          {unfinished.length > 0 && <div className="q-sec">Unfinished</div>}
          {unfinished.map(row)}
          {!items.length && <div className="faint q-none">Nothing open{scope ? ` in ${scope.name}` : ""}. Every project is caught up.</div>}
        </div>
        <div className="q-keys">
          <span><b>j k</b>move</span>
          <span><b>↵</b>open</span>
          <span><b>e</b>done</span>
          <span><b>s</b>snooze</span>
        </div>
      </div>
      <div className="detail">
        {current ? (
          <div className="detail-in" key={current.id}>
            <div className="kicker">
              <span className={`dot ${current.tone}`} />
              <span className="k">{current.kind === "run" && current.tone === "bad" ? "Run failed" : KIND_LABEL[current.kind]}</span>
              <span>
                · {name(current.projectId)} · {current.source}
                {current.timeless ? "" : ` · ${shortAge(current.at, now)}`}
              </span>
            </div>
            <h2>{current.title}</h2>
            <Detail item={current} {...props} resolve={resolve} done={done} snooze={snooze} open={open} startAndResolve={startAndResolve} />
          </div>
        ) : (
          <div className="board-empty">
            <GhostMark size={EMPTY_MARK_PX} revealed={false} title="" />
            <div>Board is clear. ⌘K to start a session.</div>
          </div>
        )}
      </div>
    </div>
  );
}

interface DetailProps extends Props {
  item: BoardItem;
  /** starts a session and, only if it started, takes the item off the board */
  startAndResolve: (item: BoardItem, text: string, cwd?: string) => void;
  resolve: (item: BoardItem, message: string, until?: number) => void;
  done: (item: BoardItem) => void;
  snooze: (item: BoardItem) => void;
  open: (item: BoardItem) => void;
}

function Detail(props: DetailProps) {
  switch (props.item.kind) {
    case "ask":
      return <AskDetail {...props} />;
    case "run":
      return <RunDetail {...props} />;
    case "brief":
      return <BriefDetail {...props} />;
    case "stalled":
      return <StalledDetail {...props} />;
    case "git":
      return <GitDetail {...props} />;
  }
}

function AskDetail({ item, resolve, open, onError }: DetailProps) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const send = (text: string) => {
    if (!item.ask || !text.trim() || sending) return;
    setSending(true);
    window.ghost.sessions
      .send(item.ask.sessionKey, text.trim())
      // Your message ends the question; the short hide only covers the moment before the chat says so.
      .then(() => resolve(item, `Sent: ${text.trim()}`, Date.now() + SETTLE_MS))
      .catch((err) => {
        setSending(false);
        onError(err);
      });
  };
  return (
    <>
      <div className="quote scroll-quote">
        <FormattedText text={item.ask?.text ?? ""} />
      </div>
      <div className="acts">
        {QUICK_REPLIES.map((q) => (
          <button key={q} className="sm" disabled={sending} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <div className="reply">
        <input value={reply} placeholder="Reply to Claude…" onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send(reply)} />
        <button className="send" disabled={!reply.trim() || sending} onClick={() => send(reply)} title="Send">
          ↑
        </button>
      </div>
      <div className="acts">
        <button className="link-btn" onClick={() => open(item)}>
          Open session ↵
        </button>
      </div>
    </>
  );
}

function RunDetail({ item, resolve, done, startSession, startAndResolve, showProject, onError }: DetailProps) {
  const [busy, setBusy] = useState(false);
  const [def, setDef] = useState<RunDefinition | undefined>();
  const record = item.run;
  const runId = record?.runId;
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    window.ghost.runs
      .list(item.projectId)
      .then(({ definitions }) => !cancelled && setDef(definitions.find((d) => d.id === runId)))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [item.projectId, runId, onError]);

  // A failed run Ghost tracks after its result was read: there's no record here, only the loop.
  if (!record) {
    return (
      <>
        {item.loop?.detail && <div className="quote">{item.loop.detail}</div>}
        <div className="acts">
          <button className="primary sm" onClick={() => item.loop && startAndResolve(item, loopPrompt(item.loop), item.loop.cwd ?? item.loop.folder)}>
            Ask Claude to fix it
          </button>
          <button className="link-btn" onClick={() => showProject(item.projectId, "runs")}>
            Edit run
          </button>
          <button className="link-btn" onClick={() => done(item)}>
            It's done
          </button>
        </div>
      </>
    );
  }

  const failed = record.status === "failed";
  const skipped = record.status === "skipped";
  const log = [record.note, record.resultText ? tail(record.resultText, LOG_TAIL_LINES) : ""].filter(Boolean).join("\n\n");
  const markRead = () => window.ghost.runs.markRead(item.projectId, record.id);
  const fix = async () => {
    if (busy) return;
    setBusy(true);
    const task = def ? `\n\nThen do the run's task once to check it works:\n\n${def.prompt}` : "";
    const started = await startSession(item.projectId, `The scheduled run "${record.name}" failed${record.note ? `: ${record.note}` : ""}. Find out why and fix the cause.${task}`, def?.folder);
    setBusy(false);
    if (!started) return;
    await markRead().catch(onError);
    resolve(item, "Session started", Date.now() + SETTLE_MS);
  };
  const rerun = () => {
    if (busy) return;
    setBusy(true);
    window.ghost.runs
      .runNow(item.projectId, record.runId)
      .then(() => markRead())
      .then(() => resolve(item, "Rerun started", Date.now() + SETTLE_MS))
      .catch((err) => {
        setBusy(false);
        onError(err);
      });
  };

  return (
    <>
      {log && (
        <div className="block">
          <pre>{log}</pre>
        </div>
      )}
      <div className="quote">
        {failed
          ? record.note ?? "The run ended with an error before it finished."
          : skipped
            ? `Skipped: ${record.note ?? "the budget guard held it back."}`
            : `Finished ${new Date(record.endedAt ?? record.startedAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}.`}
      </div>
      <div className="acts">
        {failed ? (
          <>
            <button className="primary sm" disabled={busy} onClick={() => void fix()}>
              Ask Claude to fix and rerun
            </button>
            <button className="sm" disabled={busy} onClick={rerun}>
              Rerun as is
            </button>
          </>
        ) : (
          <button className="primary sm" onClick={() => done(item)}>
            Mark read
          </button>
        )}
        <button className="link-btn" onClick={() => showProject(item.projectId, "runs")}>
          Edit run
        </button>
      </div>
    </>
  );
}

function BriefDetail({ item, resolve, showProject, onError }: DetailProps) {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.ghost.memory
      .get(item.projectId)
      .then((m) => !cancelled && setMemory(m))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [item.projectId, onError]);

  const diff = memory?.proposal ? briefDiff(memory.brief, memory.proposal.text) : [];
  return (
    <>
      {memory?.briefChangedSinceProposal && <div className="warn-text">The brief was edited after this update was written. Approving replaces your edit.</div>}
      <div className="block">
        <pre>
          {!memory ? "Loading…" : diff.length ? diff.map((d, i) => <div key={i} className={d.sign === "+" ? "diff-add" : "diff-del"}>{`${d.sign} ${d.text}`}</div>) : "No line changes."}
        </pre>
      </div>
      <div className="acts">
        <button
          className="primary sm"
          disabled={!memory?.proposal}
          onClick={() =>
            window.ghost.memory
              .acceptProposal(item.projectId, memory?.proposal?.text)
              .then(() => resolve(item, "Brief updated", Date.now() + SETTLE_MS))
              .catch(onError)
          }
        >
          Approve
        </button>
        <button className="sm" onClick={() => showProject(item.projectId, "memory")}>
          Edit first
        </button>
        <button
          className="link-btn"
          onClick={() =>
            window.ghost.memory
              .dismissProposal(item.projectId)
              .then(() => resolve(item, "Kept the old brief", Date.now() + SETTLE_MS))
              .catch(onError)
          }
        >
          Keep the old brief
        </button>
      </div>
    </>
  );
}

function StalledDetail({ item, done, snooze, openSessionById, startAndResolve, onError }: DetailProps) {
  const loop = item.loop;
  const [where, setWhere] = useState<string | undefined>();
  useEffect(() => {
    if (!loop?.sessionId) return;
    let cancelled = false;
    window.ghost.memory
      .get(item.projectId)
      .then((m) => !cancelled && setWhere(m.summaries.find((s) => s.sessionId === loop.sessionId)?.summary))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [item.projectId, loop?.sessionId, onError]);

  const pickUp = () => {
    if (!loop) return;
    if (loop.sessionId) openSessionById(item.projectId, loop.sessionId, item.reason.name || item.title);
    else startAndResolve(item, loopPrompt(loop), loop.cwd);
  };
  return (
    <>
      <div className="quote">{where ?? loop?.detail ?? "No notes on where this was left."}</div>
      <div className="acts">
        <button className="primary sm" onClick={pickUp}>
          Pick up where you left off
        </button>
        <button className="sm" onClick={() => snooze(item)}>
          Tomorrow
        </button>
        <button className="link-btn" onClick={() => done(item)}>
          It's done
        </button>
      </div>
    </>
  );
}

function GitDetail({ item, snooze, startAndResolve }: DetailProps) {
  const loop = item.loop;
  if (!loop) return null;
  const folder = loop.folder?.replace(/^\/Users\/[^/]+/, "~");
  const push = loop.kind === "unpushed";
  const ask = () => {
    const text = push ? `${loop.title}. Check those commits are ready, then push them to the branch's remote. If something blocks the push, stop and tell me.` : loopPrompt(loop);
    startAndResolve(item, text, loop.folder);
  };
  return (
    <>
      <div className="block">
        <pre>{[loop.title, loop.detail, folder].filter(Boolean).join("\n")}</pre>
      </div>
      <div className="acts">
        <button className="primary sm" onClick={ask}>
          {push ? "Ask Claude to push" : "Ask Claude to look"}
        </button>
        <button className="link-btn" onClick={() => snooze(item)}>
          Not yet
        </button>
      </div>
    </>
  );
}
