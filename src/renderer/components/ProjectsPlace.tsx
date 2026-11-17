import { useEffect, useState } from "react";
import type { BrainState } from "../../shared/api";
import { FALLBACK_AREA_ID, type LiveSession, type OpenSessionRequest, type ProjectView, type RunDefinition, type SessionSummary, type SessionSummaryDoc } from "../../shared/types";
import { ChatList } from "./ChatList";
import { MemoryPanel } from "./MemoryPanel";
import { Menu } from "./Menu";
import { ProjectMenu } from "./ProjectMenu";
import { usePrompt } from "./Prompt";
import { RunsPanel } from "./RunsPanel";
import { scheduleText } from "./SessionsPlace";

export type ProjectPage = "overview" | "chats" | "runs" | "memory";
const DRAG_TYPE = "application/x-ghostos-project";
const ARCHIVE_OPEN_KEY = "ghostos.archiveOpen";
const CHATS_SHOWN = 6;
const SUMMARIES_SHOWN = 5;
const SUB_TITLE: Record<Exclude<ProjectPage, "overview">, string> = { chats: "Chats", runs: "Runs", memory: "Memory" };

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // storage unavailable; the archive list just opens closed next time
  }
}

function ago(ms: number): string {
  const days = Math.floor((Date.now() - ms) / (24 * 60 * 60_000));
  if (days <= 0) return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return days === 1 ? "yesterday" : `${days}d ago`;
}

interface Props {
  state: BrainState;
  selected: ProjectView | null;
  view: ProjectPage;
  scope: string | null;
  /** relative last activity per project id */
  lastActive: Record<string, string>;
  live: LiveSession[];
  memoryVersion: number;
  runsVersion: number;
  capabilitiesVersion: number;
  onSelect: (projectId: string) => void;
  onView: (view: ProjectPage) => void;
  onScope: (projectId: string | null) => void;
  onOpenLive: (key: string) => void;
  onOpenChat: (projectId: string, chat: SessionSummary) => void;
  onOpenSession: (req: OpenSessionRequest) => Promise<LiveSession | undefined>;
  onOpenSessionById: (projectId: string, sessionId: string, title: string) => void;
  onNewCodingSession: (projectId: string) => void;
  onOpenDesign: (id?: string) => void;
  onError: (err: unknown) => void;
}

/** Projects: the library of projects by area on the left, the selected one's brief, chats, runs and memory on the right. */
export function ProjectsPlace(props: Props) {
  const { state, selected, lastActive, onSelect, onError } = props;
  const ask = usePrompt();
  const run = (fn: () => Promise<unknown>) => void fn().catch(onError);
  const [dropArea, setDropArea] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(() => readFlag(ARCHIVE_OPEN_KEY));
  const archived = state.projects.filter((p) => p.archived);

  const addProject = async (areaId: string) => {
    const name = await ask("New project name");
    if (name) run(async () => onSelect((await window.ghost.projects.create({ name, area: areaId })).id));
  };
  const addArea = async () => {
    const name = await ask("New area name");
    if (name) run(() => window.ghost.areas.add(name));
  };
  const renameArea = async (id: string, current: string) => {
    const name = await ask("Rename area", current);
    if (name && name !== current) run(() => window.ghost.areas.rename(id, name));
  };
  const removeArea = (id: string, name: string) => {
    const fallback = state.areas.find((a) => a.id === FALLBACK_AREA_ID)?.name ?? "the first area";
    if (window.confirm(`Remove the area "${name}"? Its projects move to ${fallback}.`)) run(() => window.ghost.areas.remove(id));
  };
  const deleteProject = (id: string, name: string) => {
    const ok = window.confirm(
      `Delete "${name}" from GhostOS for good?\n\nIts runs, run history, notes, summaries, brief and chat folders are removed from the brain (the brain's git history keeps a copy). Claude's chat transcripts and the project's folders on disk are not touched.`,
    );
    if (ok) run(() => window.ghost.projects.remove(id));
  };

  return (
    <div className="shelf">
      <div className="shelf-l">
        {state.areas.map((area, index) => {
          const projects = state.projects.filter((p) => p.area === area.id && !p.archived);
          return (
            <div
              key={area.id}
              className={`shelf-grp ${dropArea === area.id ? "drop-target" : ""}`}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                setDropArea(area.id);
              }}
              onDragLeave={() => setDropArea((current) => (current === area.id ? null : current))}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(DRAG_TYPE);
                setDropArea(null);
                if (id) run(() => window.ghost.projects.update(id, { area: area.id }));
              }}
            >
              <div className="grp-label">
                <span className="ellipsis">{area.name}</span>
                <span className="grow" />
                <button className="icon-btn hov" title={`New project in ${area.name}`} onClick={() => void addProject(area.id)}>
                  +
                </button>
                <span className="hov">
                  <Menu
                    trigger={(toggle) => (
                      <button className="icon-btn" title="Area actions" onClick={toggle}>
                        ⋯
                      </button>
                    )}
                    items={[
                      { label: "Rename…", onClick: () => void renameArea(area.id, area.name) },
                      { label: "Move up", disabled: index === 0, onClick: () => run(() => window.ghost.areas.move(area.id, -1)) },
                      { label: "Move down", disabled: index === state.areas.length - 1, onClick: () => run(() => window.ghost.areas.move(area.id, 1)) },
                      ...(area.id !== FALLBACK_AREA_ID ? (["-", { label: "Remove area", danger: true, onClick: () => removeArea(area.id, area.name) }] as const) : []),
                    ]}
                  />
                </span>
              </div>
              {projects.map((p) => (
                <button
                  key={p.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, p.id)}
                  className={`p-nav ${p.id === selected?.id ? "on" : ""} ${p.primaryPath ? "" : "missing"}`}
                  title={p.primaryPath ?? "No folder on this Mac yet"}
                  onClick={() => onSelect(p.id)}
                >
                  <span className="ellipsis">{p.name}</span>
                  <span className="r">{lastActive[p.id]}</span>
                </button>
              ))}
              {!projects.length && <div className="faint shelf-none">No projects</div>}
            </div>
          );
        })}
        {archived.length > 0 && (
          <div className="shelf-grp">
            <button
              className="grp-label as-btn"
              onClick={() => {
                setArchiveOpen(!archiveOpen);
                writeFlag(ARCHIVE_OPEN_KEY, !archiveOpen);
              }}
            >
              Archived · {archived.length}
            </button>
            {archiveOpen &&
              archived.map((p) => (
                <div key={p.id} className={`p-nav archived ${p.id === selected?.id ? "on" : ""}`} role="button" onClick={() => onSelect(p.id)} title="Open (restore it to work in it)">
                  <span className="ellipsis">{p.name}</span>
                  <span className="r hov">
                    <button className="link-btn" title="Back into its area" onClick={(e) => (e.stopPropagation(), run(() => window.ghost.projects.update(p.id, { archived: false })))}>
                      Restore
                    </button>
                    <button className="link-btn danger" title="Remove from GhostOS for good" onClick={(e) => (e.stopPropagation(), deleteProject(p.id, p.name))}>
                      Delete
                    </button>
                  </span>
                </div>
              ))}
          </div>
        )}
        <div className="shelf-foot">
          <button className="link-btn" onClick={() => void addArea()}>
            + Area
          </button>
          <span className="faint ellipsis" title={state.brainDir}>
            {state.machineName} · {state.brainDir.replace(/^\/Users\/[^/]+/, "~")}
          </span>
        </div>
      </div>
      <div className="shelf-r">
        {selected ? (
          <ProjectDetail key={selected.id} {...props} project={selected} />
        ) : (
          <div className="empty">No projects yet. Add one with + next to an area.</div>
        )}
      </div>
    </div>
  );
}

function ProjectDetail({ project, state, view, scope, live, memoryVersion, runsVersion, capabilitiesVersion, onView, onScope, onOpenLive, onOpenChat, onOpenSession, onOpenSessionById, onNewCodingSession, onOpenDesign, onError }: Props & { project: ProjectView }) {
  const scoped = scope === project.id;
  const projectLive = live.filter((s) => s.projectId === project.id);
  const head = (
    <div className="shelf-h">
      {view === "overview" ? (
        <h1 className="ellipsis">{project.name}</h1>
      ) : (
        <h1 className="ellipsis crumbs">
          <button className="link-btn crumb-back" onClick={() => onView("overview")}>
            {project.name}
          </button>
          <span className="faint">›</span> {SUB_TITLE[view]}
        </h1>
      )}
      <span className="grow" />
      {!project.archived && (
        <button className={`sm ${scoped ? "primary" : ""}`} onClick={() => onScope(scoped ? null : project.id)} title="Filter Board and ⌘K to this project">
          {scoped ? "Scoped to this" : "Scope Board to this"}
        </button>
      )}
      <ProjectMenu project={project} areas={state.areas} machineId={state.machineId} onNewCodingSession={() => onNewCodingSession(project.id)} onOpenDesign={onOpenDesign} onError={onError} />
    </div>
  );

  return (
    <div className="shelf-in">
      {head}
      {project.archived && (
        <div className="archived-banner">
          Archived{project.archivedAt ? ` on ${new Date(project.archivedAt).toLocaleDateString()}` : ""}. Its runs don't run and Ghost doesn't track it.
        </div>
      )}
      {view === "overview" && <Overview project={project} state={state} live={projectLive} memoryVersion={memoryVersion} runsVersion={runsVersion} onView={onView} onOpenLive={onOpenLive} onOpenChat={onOpenChat} onError={onError} />}
      {view === "chats" && <ChatList project={project} sessions={projectLive} memoryVersion={memoryVersion} onSelect={onOpenLive} onOpen={onOpenSession} onError={onError} />}
      {view === "runs" && <RunsPanel project={project} machineId={state.machineId} version={runsVersion} onOpenSession={(sessionId, title) => onOpenSessionById(project.id, sessionId, title)} onError={onError} />}
      {view === "memory" && (
        <MemoryPanel
          project={project}
          version={memoryVersion}
          autoApply={state.settings.autoApplyBriefs}
          capabilitiesVersion={capabilitiesVersion}
          onOpenSession={(sessionId, title) => onOpenSessionById(project.id, sessionId, title)}
          onError={onError}
        />
      )}
    </div>
  );
}

interface OverviewProps {
  project: ProjectView;
  state: BrainState;
  live: LiveSession[];
  memoryVersion: number;
  runsVersion: number;
  onView: (view: ProjectPage) => void;
  onOpenLive: (key: string) => void;
  onOpenChat: (projectId: string, chat: SessionSummary) => void;
  onError: (err: unknown) => void;
}

function Overview({ project, state, live, memoryVersion, runsVersion, onView, onOpenLive, onOpenChat, onError }: OverviewProps) {
  const [brief, setBrief] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<SessionSummaryDoc[]>([]);
  const [chats, setChats] = useState<SessionSummary[]>([]);
  const [runs, setRuns] = useState<RunDefinition[]>([]);
  const [ideaText, setIdeaText] = useState("");
  const run = (fn: () => Promise<unknown>) => void fn().catch(onError);

  useEffect(() => {
    let cancelled = false;
    window.ghost.memory
      .get(project.id)
      .then((m) => {
        if (cancelled) return;
        setBrief(m.brief.trim());
        setSummaries([...m.summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [project.id, memoryVersion, onError]);

  useEffect(() => {
    if (!project.primaryPath) return setChats([]);
    let cancelled = false;
    window.ghost.sessions
      .listPast(project.id)
      .then((list) => !cancelled && setChats(list))
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [project.id, project.primaryPath, live.length, onError]);

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

  const liveIds = new Set(live.map((l) => l.sessionId).filter(Boolean));
  const ideas = state.ideas.filter((i) => i.projectId === project.id && i.status === "open").reverse();
  const addIdea = () => {
    if (!ideaText.trim()) return;
    run(async () => {
      await window.ghost.ideas.add(ideaText.trim(), project.id);
      setIdeaText("");
    });
  };

  return (
    <>
      <p className="shelf-brief">{brief === null ? "…" : brief || "No brief yet. It fills in as you finish sessions here."}</p>
      <div className="cols">
        <div className="col">
          <h3>
            Chats
            <button className="link-btn" onClick={() => onView("chats")}>
              All →
            </button>
          </h3>
          {live.map((s) => (
            <button key={s.key} className="p-row" onClick={() => onOpenLive(s.key)}>
              <span className="t ellipsis">{s.title}</span>
              <span className="s">{s.busy ? "working…" : "open"}</span>
            </button>
          ))}
          {chats
            .filter((c) => !liveIds.has(c.sessionId))
            .slice(0, CHATS_SHOWN)
            .map((c) => (
              <button key={c.sessionId} className="p-row" onClick={() => onOpenChat(project.id, c)}>
                <span className="t ellipsis">{c.title}</span>
                <span className="s">{ago(c.updatedAt)}</span>
              </button>
            ))}
          {!live.length && !chats.length && <div className="faint col-none">{project.primaryPath ? "No chats yet." : "Add a folder (⋯ → Folders…) to start chats."}</div>}
        </div>
        <div className="col">
          <h3>
            Runs
            <button className="link-btn" onClick={() => onView("runs")}>
              Manage →
            </button>
          </h3>
          {runs.length ? (
            runs.map((r) => (
              <button key={r.id} className="p-row" onClick={() => onView("runs")}>
                <span className="t ellipsis">{r.name}</span>
                <span className="s">{r.enabled ? scheduleText(r.schedule) : "off"}</span>
              </button>
            ))
          ) : (
            <div className="faint col-none">No scheduled runs yet.</div>
          )}
        </div>
        <div className="col">
          <h3>
            Memory
            <button className="link-btn" onClick={() => onView("memory")}>
              Open →
            </button>
          </h3>
          {summaries.length ? (
            summaries.slice(0, SUMMARIES_SHOWN).map((s) => (
              <button key={s.sessionId} className="p-row" onClick={() => onView("memory")} title={s.summary}>
                <span className="t ellipsis">{s.title}</span>
                <span className="s clamp">{s.summary}</span>
              </button>
            ))
          ) : (
            <div className="faint col-none">No summaries yet.</div>
          )}
        </div>
      </div>
      <div className="col ideas">
        <h3>Ideas</h3>
        <input value={ideaText} placeholder="New idea  (Enter to add · ⌘I from anywhere)" onChange={(e) => setIdeaText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addIdea()} />
        {ideas.map((idea) => (
          <div key={idea.id} className="idea-row">
            <span className="grow">{idea.text}</span>
            <button className="icon-btn hov" title="Done" onClick={() => run(() => window.ghost.ideas.update(idea.id, { status: "archived" }))}>
              ✓
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
