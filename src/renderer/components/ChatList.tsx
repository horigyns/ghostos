import { useCallback, useEffect, useState } from "react";
import type { LiveSession, OpenSessionRequest, PermissionMode, ProjectOrganization, ProjectView, SessionSummary, SessionSummaryDoc } from "../../shared/types";
import { Menu, type MenuItem } from "./Menu";
import { usePrompt } from "./Prompt";
import { MODEL_CHOICES, modelLabel, PERMISSION_CHOICES } from "./sessionChoices";

const COLLAPSED_KEY = "ghostos.collapsedChatFolders";
const MINUTES_PER_HOUR = 60;
const HOURS_SHOWN = 48;

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function writeSet(key: string, set: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch {
    // UI preference only
  }
}

function timeAgo(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < MINUTES_PER_HOUR) return `${Math.max(minutes, 0)}m ago`;
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_SHOWN) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A chat in the list: a past transcript, a live session, or both. */
interface ChatEntry {
  sessionId?: string;
  title: string;
  cwd?: string;
  updatedAt: number;
  live?: LiveSession;
  past?: SessionSummary;
}

interface Props {
  project: ProjectView;
  /** live sessions in this project */
  sessions: LiveSession[];
  memoryVersion: number;
  /** shows a live chat */
  onSelect: (key: string) => void;
  onOpen: (req: OpenSessionRequest) => Promise<LiveSession | undefined>;
  onError: (err: unknown) => void;
}

/** Every chat in a project: live ones first, then loose chats, then folders. */
export function ChatList({ project, sessions, memoryVersion, onSelect, onOpen, onError }: Props) {
  const ask = usePrompt();
  const run = (fn: () => Promise<unknown>) => void fn().catch(onError);
  const [past, setPast] = useState<SessionSummary[]>([]);
  const [org, setOrg] = useState<ProjectOrganization>({ folders: [], placement: {}, hidden: [] });
  const [summaries, setSummaries] = useState<Map<string, SessionSummaryDoc>>(new Map());
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readSet(COLLAPSED_KEY));
  const [model, setModel] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("auto");

  const load = useCallback(async () => {
    const [list, organization, memory] = await Promise.all([
      window.ghost.sessions.listPast(project.id),
      window.ghost.organize.get(project.id),
      window.ghost.memory.get(project.id),
    ]);
    setPast(list);
    setOrg(organization);
    setSummaries(new Map(memory.summaries.map((s) => [s.sessionId, s])));
  }, [project.id]);

  useEffect(() => {
    load().catch(onError);
  }, [load, memoryVersion, sessions.length, onError]);
  useEffect(() => window.ghost.on.organizeChanged((id) => id === project.id && void load().catch(onError)), [load, project.id, onError]);

  const cwd = project.primaryPath;
  const newChat = (folderId?: string) => {
    if (!cwd) return onError(new Error("Add a folder to this project first (⋯ → Folders…); Claude needs a folder to work in."));
    run(async () => {
      const opened = await onOpen({ projectId: project.id, cwd, model: model || undefined, permissionMode });
      // A chat started from a folder goes into it (its session id is assigned when it opens).
      if (folderId && opened?.sessionId) await window.ghost.organize.place(project.id, opened.sessionId, folderId);
    });
  };
  const newFolder = async () => {
    const name = await ask("New folder name");
    if (name) run(() => window.ghost.organize.createFolder(project.id, name));
  };
  const toggleFolder = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    writeSet(COLLAPSED_KEY, next);
  };

  // Live sessions first (a brand-new chat has no transcript yet), then past transcripts.
  const hidden = new Set(org.hidden);
  const liveBySession = new Map(sessions.filter((s) => s.sessionId).map((s) => [s.sessionId!, s]));
  const entries: ChatEntry[] = [
    ...sessions
      .filter((s) => !s.sessionId || !past.some((p) => p.sessionId === s.sessionId))
      .map((s) => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd, updatedAt: Date.now(), live: s })),
    ...past.map((p) => ({ sessionId: p.sessionId, title: p.title, cwd: p.cwd, updatedAt: p.updatedAt, past: p, live: liveBySession.get(p.sessionId) })),
  ].filter((e) => showHidden || !e.sessionId || !hidden.has(e.sessionId));
  const folderOf = (e: ChatEntry) => (e.sessionId && org.folders.some((f) => f.id === org.placement[e.sessionId!]) ? org.placement[e.sessionId] : undefined);
  const loose = entries.filter((e) => !folderOf(e));

  const open = (e: ChatEntry) => {
    if (e.live) return onSelect(e.live.key);
    if (e.past) run(() => onOpen({ projectId: project.id, cwd: e.cwd || cwd || undefined, resumeSessionId: e.past!.sessionId, title: e.title, permissionMode }));
  };

  const rowMenu = (e: ChatEntry): MenuItem[] => {
    const id = e.sessionId;
    if (!id) return [{ caption: "Starting…" }];
    const isHidden = hidden.has(id);
    return [
      { heading: "Move to" },
      { label: `${!org.placement[id] ? "✓ " : ""}No folder`, onClick: () => run(() => window.ghost.organize.place(project.id, id, null)) },
      ...org.folders.map((f) => ({ label: `${org.placement[id] === f.id ? "✓ " : ""}${f.name}`, onClick: () => run(() => window.ghost.organize.place(project.id, id, f.id)) })),
      "-",
      ...(e.past && !summaries.has(id)
        ? [{ label: "Summarize", title: "Summarize this chat (Haiku) and propose brief updates", onClick: () => run(() => window.ghost.memory.summarize(project.id, id, e.past!.cwd)) }]
        : []),
      {
        label: isHidden ? "Show in project" : "Hide",
        title: isHidden ? "Show it in the project again" : "Remove from this project's lists (the transcript stays)",
        onClick: () => run(() => window.ghost.organize.hide(project.id, id, !isHidden)),
      },
      {
        label: "Delete…",
        danger: true,
        disabled: Boolean(e.live),
        title: e.live ? "Close the chat first" : "Move the transcript to the Trash",
        onClick: () =>
          window.confirm(`Delete "${e.title}"?\n\nIts transcript moves to the macOS Trash (you can put it back from there). Its summary in GhostOS stays.`) &&
          run(() => window.ghost.organize.trash(project.id, id)),
      },
    ];
  };

  const row = (e: ChatEntry) => {
    const summary = e.sessionId ? summaries.get(e.sessionId) : undefined;
    return (
      <div
        key={e.live?.key ?? e.sessionId}
        role="button"
        tabIndex={0}
        className={`list-row ${e.sessionId && hidden.has(e.sessionId) ? "is-hidden" : ""}`}
        onClick={() => open(e)}
        onKeyDown={(ev) => ev.key === "Enter" && open(e)}
      >
        <span className="g">{e.live ? <span className={`mark ${e.live.busy ? "busy" : "live"}`} title={e.live.busy ? "Claude is working" : "Open"} /> : "·"}</span>
        <span className="t ellipsis" title={e.title}>{e.title}</span>
        <span className="w">
          {e.live ? "open" : timeAgo(e.updatedAt)}
          <span className="hov">
            <Menu
              trigger={(toggle) => (
                <button className="icon-btn" title="Chat actions" onClick={toggle}>
                  ⋯
                </button>
              )}
              items={rowMenu(e)}
            />
          </span>
        </span>
        {summary && <span className="s ellipsis" title={summary.summary}>{summary.summary}</span>}
      </div>
    );
  };

  return (
    <div className="scroll">
      <div className="page">
        <section className="sec">
          <div className="sec-h">
            <h2>Chats</h2>
            <div className="act">
              {!!org.hidden.length && (
                <button className="link-btn" onClick={() => setShowHidden(!showHidden)}>
                  {showHidden ? "Hide removed" : `Show ${org.hidden.length} removed`}
                </button>
              )}
              <button className="link-btn" onClick={() => void newFolder()}>+ Folder</button>
              <Menu
                trigger={(toggle, isOpen) => (
                  <button className={`toggle ${isOpen ? "on" : ""}`} title="Model and permissions for new chats" onClick={toggle}>
                    {modelLabel(model)} · {PERMISSION_CHOICES.find((p) => p.value === permissionMode)?.label.toLowerCase()} ▾
                  </button>
                )}
                items={[
                  { heading: "Model" },
                  ...MODEL_CHOICES.map((m) => ({ label: `${m.value === model ? "✓ " : ""}${m.label}`, onClick: () => setModel(m.value) })),
                  "-",
                  { heading: "Permissions" },
                  ...PERMISSION_CHOICES.map((p) => ({ label: `${p.value === permissionMode ? "✓ " : ""}${p.label}`, onClick: () => setPermissionMode(p.value) })),
                ]}
              />
              <button className="primary sm" disabled={!cwd} onClick={() => newChat()}>
                New chat
              </button>
            </div>
          </div>
          {!cwd && <p className="faint todo-empty">This project has no folder on this Mac yet. Add one from ⋯ → Folders….</p>}
          {cwd && !entries.length && <p className="faint todo-empty">No chats in this project yet.</p>}
          {loose.map(row)}
          {org.folders.map((f) => {
            const list = entries.filter((e) => folderOf(e) === f.id);
            const isCollapsed = collapsed.has(f.id);
            return (
              <div key={f.id}>
                <div className="folder-h" onClick={() => toggleFolder(f.id)}>
                  <span className="tree-chevron">{isCollapsed ? "▸" : "▾"}</span>
                  {f.name}
                  <span className="c">{list.length}</span>
                  <span className="grow" />
                  <span className="hov">
                    <Menu
                      trigger={(toggle) => (
                        <button className="icon-btn" title="Folder actions" onClick={toggle}>
                          ⋯
                        </button>
                      )}
                      items={[
                        { label: "New chat here", disabled: !cwd, onClick: () => newChat(f.id) },
                        {
                          label: "Rename…",
                          onClick: async () => {
                            const name = await ask("Rename folder", f.name);
                            if (name && name !== f.name) run(() => window.ghost.organize.renameFolder(project.id, f.id, name));
                          },
                        },
                        "-",
                        {
                          label: "Remove folder",
                          danger: true,
                          onClick: () => window.confirm(`Remove the folder "${f.name}"? Its chats stay in the project.`) && run(() => window.ghost.organize.deleteFolder(project.id, f.id)),
                        },
                      ]}
                    />
                  </span>
                </div>
                {!isCollapsed && (
                  <div className="indent">{list.length ? list.map(row) : <p className="faint todo-empty">Empty. Move chats here with their ⋯ menu.</p>}</div>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
