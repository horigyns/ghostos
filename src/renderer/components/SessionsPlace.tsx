import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent, GhostState, LiveSession, ProjectView, RunDefinition, RunSchedule, SessionSummary, Sidenote, SidenoteMode } from "../../shared/types";
import { pendingQuestion, sessionLabel, sessionTone } from "../board";
import { Composer, FormattedText, OutputChip, toRows, type Row } from "./chatParts";
import { GhostMark } from "./GhostMark";
import { Menu, type MenuItem } from "./Menu";
import { SessionInfo } from "./SessionInfo";
import { MODEL_CHOICES, PERMISSION_CHOICES } from "./sessionChoices";
import { TerminalView } from "./TerminalView";

const SUMMARY_FALLBACK_CHARS = 320;
const CHANGED_SHOWN = 6;
const RECENT_PER_PROJECT = 3;
const RECENT_SHOWN = 10;
const EMPTY_MARK_PX = 72;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const GIT_KINDS = new Set(["uncommitted", "unpushed", "branches"]);
const NOTE_MODES: { mode: SidenoteMode; label: string; hint: string }[] = [
  { mode: "now", label: "Now", hint: "Claude sees it after its next tool step, without stopping." },
  { mode: "after", label: "After this turn", hint: "Arrives when Claude finishes this turn, or with your next message." },
  { mode: "later", label: "Save for later", hint: "Kept with this session to come back to. Not sent." },
];
const NOTE_STATUS: Record<Sidenote["status"], string> = { queued: "waiting", delivered: "delivered", saved: "saved" };

/** What happens to a note you just added, said plainly. */
function noteSent(mode: SidenoteMode, busy: boolean): string {
  if (mode === "later") return "Note saved with this session";
  if (mode === "after") return busy ? "Note queued; Claude sees it when this turn ends" : "Note queued; Claude sees it with your next message";
  return busy ? "Note sent; Claude sees it after its next step" : "Note queued; Claude sees it in its next turn";
}

/** Notes pinned to a message but not sent yet, per session, for as long as the window is open. */
const pinsBySession = new Map<string, Record<number, string>>();

type LogItem = { kind: "row"; row: Row; index: number } | { kind: "steps"; rows: Extract<Row, { kind: "tool" }>[]; index: number };

/** Folds runs of tool steps into one item each. */
function toLog(rows: Row[]): LogItem[] {
  const items: LogItem[] = [];
  rows.forEach((row, index) => {
    const last = items[items.length - 1];
    if (row.kind === "tool") {
      if (last?.kind === "steps") last.rows.push(row);
      else items.push({ kind: "steps", rows: [row], index });
    } else items.push({ kind: "row", row, index });
  });
  return items;
}

export function scheduleText(s: RunSchedule): string {
  switch (s.kind) {
    case "daily":
      return `daily ${s.time}`;
    case "weekly":
      return `${s.days.map((d) => DAY_NAMES[d]).join(" ")} ${s.time}`;
    case "interval":
      return `every ${s.everyMinutes} min`;
    case "cron":
      return `cron ${s.expr}`;
    case "once":
      return `once ${new Date(s.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
}

interface Props {
  session: LiveSession | undefined;
  events: ChatEvent[];
  project: ProjectView | null;
  projects: ProjectView[];
  ghost: GhostState | null;
  memoryVersion: number;
  runsVersion: number;
  sidenoteVersion: number;
  contextOpen: boolean;
  onOpenProject: (projectId: string) => void;
  onOpenChat: (projectId: string, chat: SessionSummary) => void;
  onNewSessionWith: (projectId: string, model: string) => void;
  onClose: (key: string) => Promise<void>;
  onHistory: (key: string, history: ChatEvent[]) => void;
  toast: (text: string) => void;
  onError: (err: unknown) => void;
}

/** Sessions: one Claude Code session in focus, as a work log, with its project's context on the right. */
export function SessionsPlace(props: Props) {
  const { session, project, contextOpen } = props;
  if (!session) return <NoSessions {...props} />;
  return (
    <div className="work" style={{ gridTemplateColumns: contextOpen && project ? "minmax(0, 1fr) 300px" : "minmax(0, 1fr)" }}>
      <WorkLog key={session.key} {...props} session={session} />
      {contextOpen && project && <ContextDrawer key={project.id} {...props} session={session} project={project} />}
    </div>
  );
}

function WorkLog({ session, events, project, ghost, memoryVersion, onOpenProject, onClose, onHistory, toast, onError }: Props & { session: LiveSession }) {
  const rows = useMemo(() => toRows(events), [events]);
  const log = useMemo(() => toLog(rows), [rows]);
  const logRef = useRef<HTMLDivElement>(null);
  const [summary, setSummary] = useState<string | undefined>();
  const [pins, setPins] = useState<Record<number, string>>(() => pinsBySession.get(session.key) ?? {});
  const [editing, setEditing] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const tone = sessionTone(session, events);

  useEffect(() => {
    pinsBySession.set(session.key, pins);
  }, [session.key, pins]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length, session.busy]);

  useEffect(() => {
    if (!session.sessionId) return;
    let cancelled = false;
    window.ghost.memory
      .get(session.projectId)
      .then((m) => !cancelled && setSummary(m.summaries.find((s) => s.sessionId === session.sessionId)?.summary))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [session.projectId, session.sessionId, memoryVersion, onError]);

  const lastAssistant = [...rows].reverse().find((r): r is Extract<Row, { kind: "assistant" }> => r.kind === "assistant")?.text;
  const fallback = lastAssistant ? (lastAssistant.length > SUMMARY_FALLBACK_CHARS ? `${lastAssistant.slice(0, SUMMARY_FALLBACK_CHARS).trimEnd()}…` : lastAssistant) : undefined;
  const changed = [...new Set(rows.flatMap((r) => (r.kind === "tool" && r.done && !r.isError && r.filePath ? [r.filePath] : [])))];
  const gitLoops = (ghost?.projects.find((g) => g.projectId === session.projectId)?.loops ?? []).filter(
    (l) => GIT_KINDS.has(l.kind) && l.folder && (session.cwd === l.folder || session.cwd.startsWith(`${l.folder}/`)),
  );
  const lastEnd = [...events].reverse().find((e): e is Extract<ChatEvent, { kind: "turn-end" }> => e.kind === "turn-end");
  const lastTurnFailed = !!lastEnd && !lastEnd.ok;
  const waiting = !session.busy && !!pendingQuestion(events);
  const open = session.busy
    ? { text: "running", cls: "accent-text" }
    : waiting
      ? { text: "your reply", cls: "warn-text" }
      : lastTurnFailed
        ? { text: "last turn failed", cls: "bad-text" }
        : { text: "nothing", cls: "dim" };

  const setView = async (view: "chat" | "terminal") => {
    try {
      // Two Claude processes can't share a session, so opening the terminal mid-reply means stopping the reply.
      if (view === "terminal" && session.busy) {
        const stopFirst = window.confirm("Claude is still working on this reply.\n\nStop the reply and open the terminal? The session continues there; only the unfinished reply is cut short.");
        if (!stopFirst) return;
        await window.ghost.sessions.stop(session.key);
      }
      const history = await window.ghost.sessions.setView(session.key, view);
      if (history) onHistory(session.key, history);
    } catch (err) {
      onError(err);
    }
  };

  const sendPin = (index: number, mode: SidenoteMode) => {
    const text = pins[index];
    if (!text) return;
    window.ghost.sidenotes
      .add({ projectId: session.projectId, sessionKey: session.key, text, mode })
      .then(() => {
        setPins(({ [index]: _sent, ...rest }) => rest);
        toast(noteSent(mode, session.busy));
      })
      .catch(onError);
  };

  const actions: MenuItem[] = [
    session.view === "chat"
      ? { label: "Show in terminal", title: "Claude Code's own terminal UI, same session", onClick: () => void setView("terminal") }
      : { label: "Show as work log", onClick: () => void setView("chat") },
    { label: "Close session", title: "Ends this Claude process; the transcript stays in the project's chats", onClick: () => void onClose(session.key) },
    "-",
    { caption: session.cwd.replace(/^\/Users\/[^/]+/, "~"), title: session.cwd },
  ];

  const header = (
    <div className="w-head">
      <h1 className="ellipsis">{session.title}</h1>
      {project && (
        <button className="link-btn" onClick={() => onOpenProject(project.id)}>
          {project.name}
        </button>
      )}
      <span className="grow" />
      <span className={`dot ${session.view === "terminal" ? "idle" : tone}`} />
      <span className="faint w-state">{session.view === "terminal" ? "terminal" : sessionLabel(tone)}</span>
      <SessionInfo session={session} onError={onError} />
      <Menu
        trigger={(toggle) => (
          <button className="icon-btn big" title="Session actions" onClick={toggle}>
            ⋯
          </button>
        )}
        items={actions}
      />
    </div>
  );

  if (session.view === "terminal") {
    return (
      <div className="log terminal-log">
        <div className="log-in fixed">{header}</div>
        <section className="session-area">
          <TerminalView sessionKey={session.key} />
        </section>
      </div>
    );
  }

  return (
    <div className="log">
      <div className="log-scroll" ref={logRef}>
        <div className="log-in">
          {header}
          <div className="result">
            <div className="h">Where this stands</div>
            <div className="s">{summary ?? fallback ?? "Nothing yet. Send the first message below."}</div>
            <div className="facts">
              <div className="fact">
                <span className="l">Changed</span>
                {changed.length ? (
                  <div className="chips">
                    {changed.slice(0, CHANGED_SHOWN).map((f) => (
                      <OutputChip key={f} session={session} file={f} onError={onError} />
                    ))}
                    {changed.length > CHANGED_SHOWN && <span className="faint">+{changed.length - CHANGED_SHOWN}</span>}
                  </div>
                ) : (
                  <span className="dim">nothing yet</span>
                )}
              </div>
              <div className="fact">
                <span className="l">Git</span>
                <span className="dim">{gitLoops.length ? gitLoops.map((l) => l.title).join(" · ") : ghost?.enabled ? "nothing pending" : "not tracked"}</span>
              </div>
              <div className="fact">
                <span className="l">Open</span>
                <span className={open.cls}>{open.text}</span>
              </div>
            </div>
          </div>
          {log.map((item) =>
            item.kind === "steps" ? (
              <Steps key={item.index} session={session} rows={item.rows} onError={onError} />
            ) : (
              <Fragment key={item.index}>
                <LogRow session={session} row={item.row} onError={onError}>
                  {item.row.kind === "assistant" && (
                    <>
                      <button
                        className="pin-btn"
                        title="Pin a note here"
                        onClick={() => {
                          setEditing(item.index);
                          setNote("");
                        }}
                      >
                        ✎
                      </button>
                      {editing === item.index && (
                        <div className="pin">
                          <span className="who">Note</span>
                          <input
                            autoFocus
                            value={note}
                            placeholder="Claude sees it after its next step…"
                            onChange={(e) => setNote(e.target.value)}
                            onBlur={() => setEditing(null)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && note.trim()) {
                                setPins((p) => ({ ...p, [item.index]: note.trim() }));
                                setEditing(null);
                              }
                              if (e.key === "Escape") setEditing(null);
                            }}
                          />
                        </div>
                      )}
                      {pins[item.index] && (
                        <div className="pin">
                          <span className="who">Note</span>
                          <span>{pins[item.index]}</span>
                          <span className="act">
                            {NOTE_MODES.map((m) => (
                              <button key={m.mode} className="link-btn" title={m.hint} onClick={() => sendPin(item.index, m.mode)}>
                                {m.mode === "now" ? "Send" : m.label}
                              </button>
                            ))}
                            <button className="link-btn" title="Drop this note" onClick={() => setPins(({ [item.index]: _dropped, ...rest }) => rest)}>
                              ×
                            </button>
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </LogRow>
              </Fragment>
            ),
          )}
          {session.busy && (
            <div className="working">
              <span className="dot busy" />
              Claude is working…
            </div>
          )}
        </div>
      </div>
      <div className="compose">
        <Composer session={session} placeholder={`Reply in ${session.title}…`} onError={onError} />
      </div>
    </div>
  );
}

function LogRow({ session, row, onError, children }: { session: LiveSession; row: Row; onError: (err: unknown) => void; children?: React.ReactNode }) {
  switch (row.kind) {
    case "user":
      return <div className="msg-user">{row.text}</div>;
    case "assistant":
      return (
        <div className="msg">
          <div className="msg-assistant">
            <FormattedText text={row.text} />
          </div>
          {children}
        </div>
      );
    case "outputs":
      return (
        <div className="outputs">
          {row.files.map((f) => (
            <OutputChip key={f} session={session} file={f} onError={onError} />
          ))}
        </div>
      );
    case "notice":
      return <div className="msg-notice">{row.text}</div>;
    case "error":
      return <div className="msg-error">{row.text}</div>;
    case "meta":
      return <div className="msg-meta">{row.text}</div>;
    case "tool":
      return null;
  }
}

function Steps({ session, rows, onError }: { session: LiveSession; rows: Extract<Row, { kind: "tool" }>[]; onError: (err: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const names = [...new Set(rows.map((r) => r.name))].join(", ");
  const running = rows.some((r) => !r.done);
  const failed = rows.some((r) => r.isError);
  return (
    <>
      <button className="steps" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {rows.length} step{rows.length === 1 ? "" : "s"} · {names}
        {running && <span className="dot busy" />}
        {failed && <span className="bad-text"> · {rows.filter((r) => r.isError).length} failed</span>}
      </button>
      {open && (
        <div className="steps-list">
          {rows.map((row, i) => (
            <div key={i} className={`msg-tool ${row.isError ? "error" : ""}`}>
              <span className="name">
                {row.done ? (row.isError ? "✕" : "✓") : "…"} {row.name}
              </span>
              <span className="summary">{row.summary}</span>
              {row.filePath && row.done && !row.isError && (
                <button className="ghost open-file" title="Open in a window" onClick={() => void window.ghost.outputs.open(session.projectId, row.filePath!, session.key).catch(onError)}>
                  Open ↗
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ContextDrawer({ session, project, ghost, memoryVersion, runsVersion, sidenoteVersion, onOpenProject, onNewSessionWith, toast, onError }: Props & { session: LiveSession; project: ProjectView }) {
  const [brief, setBrief] = useState<string | null>(null);
  const [notes, setNotes] = useState<Sidenote[]>([]);
  const [noteText, setNoteText] = useState("");
  const [noteMode, setNoteMode] = useState<SidenoteMode>("now");
  const [runs, setRuns] = useState<RunDefinition[]>([]);
  const run = (fn: () => Promise<unknown>) => void fn().catch(onError);

  useEffect(() => {
    let cancelled = false;
    window.ghost.memory
      .get(project.id)
      .then((m) => !cancelled && setBrief(m.brief.trim()))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [project.id, memoryVersion, onError]);

  useEffect(() => {
    let cancelled = false;
    window.ghost.runs
      .list(project.id)
      .then(({ definitions }) => !cancelled && setRuns(definitions))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [project.id, runsVersion, onError]);

  useEffect(() => {
    let cancelled = false;
    window.ghost.sidenotes
      .list(project.id)
      .then((list) => !cancelled && setNotes(list))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [project.id, sidenoteVersion, onError]);

  const sessionNotes = notes.filter((n) => session.sessionId && n.sessionId === session.sessionId).reverse();
  const addNote = () => {
    const text = noteText.trim();
    if (!text) return;
    run(async () => {
      await window.ghost.sidenotes.add({ projectId: project.id, sessionKey: session.key, text, mode: noteMode });
      setNoteText("");
      toast(noteSent(noteMode, session.busy));
    });
  };

  const todos = ghost?.enabled ? ghost.projects.find((g) => g.projectId === project.id)?.loops ?? [] : [];
  const permission = PERMISSION_CHOICES.find((p) => p.value === session.permissionMode)?.label.toLowerCase() ?? session.permissionMode;
  const modelItems: MenuItem[] = [
    { heading: "New session with" },
    ...MODEL_CHOICES.map((m): MenuItem => ({ label: m.label, on: (session.model ?? "") === m.value, onClick: () => onNewSessionWith(project.id, m.value) })),
    { caption: "A running session keeps its model" },
  ];

  return (
    <aside className="ctx">
      <div>
        <h3>
          <span className="ellipsis">{project.name}</span>
          <button className="link-btn" onClick={() => onOpenProject(project.id)}>
            Project ↗
          </button>
        </h3>
        <p>{brief === null ? "…" : brief || "No brief yet. It fills in as you finish sessions here."}</p>
      </div>
      <div>
        <h3>Notes</h3>
        <textarea
          className="note-input"
          rows={2}
          value={noteText}
          placeholder="A thought for Claude, without stopping it…"
          onChange={(e) => setNoteText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              addNote();
            }
          }}
        />
        <div className="note-add">
          <select value={noteMode} title={NOTE_MODES.find((m) => m.mode === noteMode)?.hint} onChange={(e) => setNoteMode(e.target.value as SidenoteMode)}>
            {NOTE_MODES.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.mode === "now" ? "Add now" : m.label}
              </option>
            ))}
          </select>
          <button className="primary sm" disabled={!noteText.trim()} onClick={addNote}>
            Add ⌘↵
          </button>
        </div>
        {sessionNotes.map((n) => (
          <div key={n.id} className="note">
            <div className="text">{n.text}</div>
            <div className="meta">
              <span className={`badge ${n.status}`}>{NOTE_STATUS[n.status]}</span>
              <span className="grow" />
              {n.status === "saved" && (
                <button className="link-btn" title="Send into the session" onClick={() => run(() => window.ghost.sidenotes.send(n.projectId, n.id))}>
                  Send
                </button>
              )}
              {n.status === "queued" && (
                <button className="link-btn" title="Take it back before Claude sees it" onClick={() => run(() => window.ghost.sidenotes.withdraw(n.projectId, n.id))}>
                  Hold
                </button>
              )}
              <button className="link-btn" title="Copy to this project's ideas" onClick={() => run(async () => (await window.ghost.sidenotes.promote(n.projectId, n.id), toast("Added to the project's ideas")))}>
                → Idea
              </button>
            </div>
          </div>
        ))}
      </div>
      <div>
        <h3>To-dos</h3>
        {todos.length ? (
          todos.map((t) => (
            <div key={t.id} className="li" title={t.detail}>
              <span className="faint">○</span>
              <span className="ellipsis">{t.title}</span>
            </div>
          ))
        ) : (
          <p className="faint">{ghost?.enabled ? "Nothing open." : "Ghost is off, so open loops aren't tracked."}</p>
        )}
      </div>
      <div>
        <h3>Runs</h3>
        {runs.length ? (
          runs.map((r) => (
            <div key={r.id} className="li">
              <span className={`dot ${r.enabled ? "ok" : "idle"}`} />
              <span className="ellipsis">{r.name}</span>
              <span className="r">{r.enabled ? scheduleText(r.schedule) : "off"}</span>
            </div>
          ))
        ) : (
          <p className="faint">No scheduled runs yet.</p>
        )}
      </div>
      <div>
        <h3>Folders</h3>
        {project.localFolders.length ? (
          project.localFolders.map((f) => (
            <div key={f.path} className={`li ${f.exists ? "" : "missing"}`} title={f.path}>
              <span className="mono ellipsis small">{f.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              <span className="r">
                <button className="link-btn" disabled={!f.exists} onClick={() => run(() => window.ghost.shell.reveal(f.path))}>
                  Finder
                </button>
                <button className="link-btn" disabled={!f.exists} onClick={() => run(() => window.ghost.shell.openInVSCode(f.path))}>
                  Code
                </button>
              </span>
            </div>
          ))
        ) : (
          <p className="faint">No folder on this Mac.</p>
        )}
      </div>
      <div>
        <h3>Model</h3>
        <div className="li">
          {session.model ?? "default"} · {permission}
          <span className="r">
            <Menu
              trigger={(toggle) => (
                <button className="link-btn" onClick={toggle}>
                  Change
                </button>
              )}
              items={modelItems}
            />
          </span>
        </div>
      </div>
    </aside>
  );
}

function NoSessions({ projects, onOpenChat, onError }: Props) {
  const [recent, setRecent] = useState<{ projectId: string; chat: SessionSummary }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all(projects.filter((p) => p.primaryPath).map((p) => window.ghost.sessions.listPast(p.id).then((list) => list.slice(0, RECENT_PER_PROJECT).map((chat) => ({ projectId: p.id, chat })))))
      .then((lists) => !cancelled && setRecent(lists.flat().sort((a, b) => b.chat.updatedAt - a.chat.updatedAt).slice(0, RECENT_SHOWN)))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [projects, onError]);
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
  return (
    <div className="scroll">
      <div className="no-sessions">
        <GhostMark size={EMPTY_MARK_PX} revealed={false} title="" />
        <div>No open sessions. ⌘K or ⌘N to start one.</div>
        {!!recent?.length && (
          <div className="recent">
            <h3>Recent</h3>
            {recent.map((r) => (
              <button key={r.chat.sessionId} className="p-row" onClick={() => onOpenChat(r.projectId, r.chat)}>
                <span className="t ellipsis">{r.chat.title}</span>
                <span className="s">{name(r.projectId)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
