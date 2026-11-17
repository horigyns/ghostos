import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Area, LiveSession, PermissionMode, ProjectView, SessionSummary } from "../../shared/types";
import { MODEL_CHOICES, PERMISSION_CHOICES } from "./sessionChoices";

const CHATS_PER_PROJECT = 4;
const SESSIONS_IDLE = 6;
const SESSIONS_SEARCHING = 12;
/** a query longer than this offers to start a session with it */
const SENTENCE_MIN = 6;

export interface Command {
  label: string;
  kbd?: string;
  run: () => void;
}

interface Props {
  projects: ProjectView[];
  areas: Area[];
  live: LiveSession[];
  /** the scoped project: sessions are limited to it and new sessions start in it */
  scope: ProjectView | null;
  /** where a typed sentence starts a session when nothing is scoped */
  defaultProject: ProjectView | null;
  commands: Command[];
  /** model and permission mode for new sessions (from here, the Board and ⌘N) */
  prefs: { model: string; permissionMode: PermissionMode };
  onPrefs: (prefs: { model: string; permissionMode: PermissionMode }) => void;
  onNewSession: (projectId: string, text: string) => void;
  onOpenLive: (key: string) => void;
  onOpenChat: (projectId: string, chat: SessionSummary) => void;
  onScope: (projectId: string) => void;
  onError: (err: unknown) => void;
  onClose: () => void;
}

interface Item {
  id: string;
  label: ReactNode;
  meta: string;
  pick: () => void;
}

/** ⌘K: go to a session or project, run a command, or type a sentence to start a session. */
export function CommandPalette({ projects, areas, live, scope, defaultProject, commands, prefs, onPrefs, onNewSession, onOpenLive, onOpenChat, onScope, onError, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [recent, setRecent] = useState<{ projectId: string; chat: SessionSummary }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const sources = projects.filter((p) => p.primaryPath && (!scope || p.id === scope.id));
    Promise.all(sources.map((p) => window.ghost.sessions.listPast(p.id).then((list) => list.slice(0, CHATS_PER_PROJECT).map((chat) => ({ projectId: p.id, chat })))))
      .then((lists) => !cancelled && setRecent(lists.flat().sort((a, b) => b.chat.updatedAt - a.chat.updatedAt)))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [projects, scope, onError]);

  const items = useMemo((): Item[] => {
    const areaName = (id: string) => areas.find((a) => a.id === id)?.name ?? "";
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (hay: string) => words.every((w) => hay.toLowerCase().includes(w));
    const target = scope ?? defaultProject;

    const sentence: Item[] =
      query.trim().length > SENTENCE_MIN && target
        ? [
            {
              id: "new",
              label: (
                <span>
                  New session: <span className="accent-text">“{query.trim()}”</span>
                </span>
              ),
              meta: `in ${target.name}`,
              pick: () => onNewSession(target.id, query.trim()),
            },
          ]
        : [];

    const scopedLive = live.filter((s) => !scope || s.projectId === scope.id);
    const liveIds = new Set(scopedLive.map((s) => s.sessionId).filter(Boolean));
    const sessions: Item[] = [
      ...scopedLive
        .filter((s) => matches(`${s.title} ${projectName(s.projectId)}`))
        .map((s): Item => ({ id: `l:${s.key}`, label: s.title, meta: `Session · ${projectName(s.projectId)}`, pick: () => onOpenLive(s.key) })),
      ...recent
        .filter((r) => !liveIds.has(r.chat.sessionId) && matches(`${r.chat.title} ${projectName(r.projectId)}`))
        .map((r): Item => ({ id: `c:${r.chat.sessionId}`, label: r.chat.title, meta: `Session · ${projectName(r.projectId)}`, pick: () => onOpenChat(r.projectId, r.chat) })),
    ].slice(0, words.length ? SESSIONS_SEARCHING : SESSIONS_IDLE);

    const projectItems: Item[] = projects
      .filter((p) => matches(`${p.name} ${areaName(p.area)}`))
      .map((p) => ({ id: `p:${p.id}`, label: p.name, meta: `Scope · ${areaName(p.area)}`, pick: () => onScope(p.id) }));

    const commandItems: Item[] = commands.filter((c) => matches(c.label)).map((c) => ({ id: `x:${c.label}`, label: c.label, meta: c.kbd ?? "Command", pick: c.run }));

    // Starting a session spends usage, so it never sits first unless nothing else matches.
    const rest = [...sessions, ...projectItems, ...commandItems];
    return rest.length ? [...rest, ...sentence] : sentence;
  }, [query, projects, areas, live, recent, scope, defaultProject, commands, onNewSession, onOpenLive, onOpenChat, onScope]);

  const pick = (item: Item) => {
    onClose();
    item.pick();
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette cmd" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Go to, search, or run a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, items.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === "Enter" && !e.nativeEvent.isComposing && items[Math.min(index, items.length - 1)]) pick(items[Math.min(index, items.length - 1)]);
          }}
        />
        <div className="palette-list">
          {items.map((item, i) => (
            <button key={item.id} className={`palette-item ${i === index ? "selected" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => pick(item)}>
              <span className="ellipsis">{item.label}</span>
              <span className="faint">{item.meta}</span>
            </button>
          ))}
          {!items.length && <div className="faint" style={{ padding: 10 }}>Nothing matches.</div>}
        </div>
        <div className="palette-foot faint">
          <span className="nowrap">↵ open · type a sentence to start a session</span>
          <span className="grow" />
          <span className="nowrap" title="For sessions started from ⌘K, ⌘N and the Board">New sessions</span>
          <select className="mini-select" value={prefs.model} onChange={(e) => onPrefs({ ...prefs, model: e.target.value })}>
            {MODEL_CHOICES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select className="mini-select" value={prefs.permissionMode} onChange={(e) => onPrefs({ ...prefs, permissionMode: e.target.value as PermissionMode })}>
            {PERMISSION_CHOICES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
