import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrainState, MemoryJobUpdate } from "../shared/api";
import type { ChatEvent, GhostState, LiveSession, OpenSessionRequest, PermissionMode, RunRecord, SearchHit, SessionSummary, UsageSnapshot } from "../shared/types";
import { boardItems, type BoardItem } from "./board";
import { Board } from "./components/Board";
import { CapabilitiesDialog, type CapabilitiesTab } from "./components/CapabilitiesDialog";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { DesignDialog } from "./components/DesignDialog";
import { IdeaCapture } from "./components/IdeaCapture";
import { ImportDialog } from "./components/ImportDialog";
import { ProjectsPlace, type ProjectPage } from "./components/ProjectsPlace";
import { RunningStrip } from "./components/RunningStrip";
import { SearchPalette } from "./components/SearchPalette";
import { SessionsPlace } from "./components/SessionsPlace";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar, type Place } from "./components/TopBar";
import { appendTerminalData, clearTerminal } from "./terminalBuffer";

const TOAST_MS = 6_000;
const INFO_TOAST_MS = 3_000;
const CLOCK_MS = 60_000;
const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;
const PLACE_KEY = "ghostos.place";
const CONTEXT_OPEN_KEY = "ghostos.contextOpen";
const LAST_PROJECT_KEY = "ghostos.lastProject";
const HIDDEN_KEY = "ghostos.boardHidden";
const NEW_SESSION_KEY = "ghostos.newSession";
/** board items hidden longer ago than this are forgotten, so the list doesn't grow forever */
const HIDDEN_KEEP_MS = 30 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const PLACES: Place[] = ["board", "sessions", "projects"];

interface Toast {
  text: string;
  kind: "error" | "info";
}

const JOB_MESSAGES: Partial<Record<MemoryJobUpdate["state"], string>> = {
  running: "Summarizing the session for the project brief…",
  done: "Session summarized. See the project's Memory.",
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable; these are only conveniences remembered between launches
  }
}

function readHidden(): Record<string, number> {
  try {
    const parsed = JSON.parse(read(HIDDEN_KEY) ?? "{}") as Record<string, number>;
    const cutoff = Date.now() - HIDDEN_KEEP_MS;
    return Object.fromEntries(Object.entries(parsed).filter(([, until]) => typeof until === "number" && until > cutoff));
  } catch {
    return {};
  }
}

export interface NewSessionPrefs {
  /** "" = the user's default model */
  model: string;
  permissionMode: PermissionMode;
}

function readPrefs(): NewSessionPrefs {
  try {
    const parsed = JSON.parse(read(NEW_SESSION_KEY) ?? "{}") as Partial<NewSessionPrefs>;
    return { model: typeof parsed.model === "string" ? parsed.model : "", permissionMode: parsed.permissionMode ?? "auto" };
  } catch {
    return { model: "", permissionMode: "auto" };
  }
}

function relative(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (ms < DAY_MS) return "today";
  const days = Math.floor(ms / DAY_MS);
  return days === 1 ? "yesterday" : days < 14 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

export function App() {
  const [state, setState] = useState<BrainState | null>(null);
  const [place, setPlace] = useState<Place>(() => (PLACES.includes(read(PLACE_KEY) as Place) ? (read(PLACE_KEY) as Place) : "board"));
  /** not remembered between launches, so a forgotten scope never hides work on the next start */
  const [scope, setScope] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(() => read(CONTEXT_OPEN_KEY) !== "false");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() => read(LAST_PROJECT_KEY));
  const [projectPage, setProjectPage] = useState<ProjectPage>("overview");
  const [live, setLive] = useState<LiveSession[]>([]);
  const [events, setEvents] = useState<Record<string, ChatEvent[]>>({});
  const [activityAt, setActivityAt] = useState<Record<string, number>>({});
  const [hidden, setHidden] = useState<Record<string, number>>(readHidden);
  /** newest unread run per project, for the Board */
  const [unreadRunInfo, setUnreadRunInfo] = useState<Record<string, RunRecord>>({});
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [now, setNow] = useState(Date.now);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState<CapabilitiesTab | false>(false);
  const [importOpen, setImportOpen] = useState(false);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  /** undefined = closed; "" = open on the first design system */
  const [designOpen, setDesignOpen] = useState<string | undefined>(undefined);
  const [capabilitiesVersion, setCapabilitiesVersion] = useState(0);
  const [runsVersion, setRunsVersion] = useState(0);
  const [sidenoteVersion, setSidenoteVersion] = useState(0);
  /** model and permission mode for sessions started from the Board, ⌘K and ⌘N */
  const [newPrefs, setNewPrefs] = useState<NewSessionPrefs>(readPrefs);
  const [memoryVersion, setMemoryVersion] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** the toast on screen, so a passing "done" message never covers an error */
  const toastShown = useRef<Toast | null>(null);
  const shownWarnings = useRef(new Set<string>());
  /** sessions closed here; a last state event from a shutting-down process must not bring them back */
  const closedKeys = useRef(new Set<string>());

  const showToast = useCallback((next: Toast, ms = TOAST_MS) => {
    clearTimeout(toastTimer.current);
    toastShown.current = next;
    setToast(next);
    toastTimer.current = setTimeout(() => {
      toastShown.current = null;
      setToast(null);
    }, ms);
  }, []);
  const info = useCallback((text: string) => {
    if (toastShown.current?.kind !== "error") showToast({ text, kind: "info" }, INFO_TOAST_MS);
  }, [showToast]);

  const report = useCallback(
    (err: unknown) => {
      const text = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);
      showToast({ text, kind: "error" });
    },
    [showToast],
  );

  const reload = useCallback(async () => {
    try {
      const next = await window.ghost.getState();
      setState(next);
      setLoadError(null);
      // Tell the user once about any brain file that couldn't be read.
      const fresh = next.warnings.filter((w) => !shownWarnings.current.has(w));
      fresh.forEach((w) => shownWarnings.current.add(w));
      if (fresh.length) report(new Error(fresh.join(" ")));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [report]);

  useEffect(() => {
    void reload();
    void window.ghost.ghost.state().then(setGhost).catch(() => undefined);
    // After a window reload, sessions may still be running in the main process: restore their history.
    void window.ghost.sessions.live().then(async (sessions) => {
      setLive(sessions);
      for (const s of sessions) {
        const history = await window.ghost.sessions.history(s.key).catch(() => []);
        setEvents((prev) => ({ ...prev, [s.key]: prev[s.key]?.length ? prev[s.key] : history }));
      }
    });
    const touch = (key: string) => setActivityAt((prev) => ({ ...prev, [key]: Date.now() }));
    const offs = [
      window.ghost.on.brainChanged(() => void reload()),
      window.ghost.on.sessionEvent((key, event) => {
        if (closedKeys.current.has(key)) return;
        setEvents((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), event] }));
        touch(key);
      }),
      window.ghost.on.sessionState((session) =>
        setLive((prev) => {
          if (closedKeys.current.has(session.key)) return prev;
          const i = prev.findIndex((s) => s.key === session.key);
          // A new terminal process starts with a fresh screen.
          if (i >= 0 && prev[i].view !== session.view) clearTerminal(session.key);
          return i < 0 ? [...prev, session] : prev.map((s) => (s.key === session.key ? session : s));
        }),
      ),
      window.ghost.on.sessionHistory((key, history) => setEvents((prev) => ({ ...prev, [key]: history }))),
      window.ghost.on.terminalData(appendTerminalData),
      window.ghost.on.usage(setUsage),
      window.ghost.on.runsChanged(() => setRunsVersion((v) => v + 1)),
      window.ghost.on.sidenotesChanged(() => setSidenoteVersion((v) => v + 1)),
      window.ghost.on.memoryChanged(() => setMemoryVersion((v) => v + 1)),
      window.ghost.on.capabilitiesChanged(() => setCapabilitiesVersion((v) => v + 1)),
      window.ghost.on.ghostChanged(setGhost),
      // A notification about a stalled project: show the Board on that project.
      window.ghost.on.ghostOpen((focus) => {
        setPlace("board");
        if (focus) setScope(focus);
      }),
      window.ghost.on.memoryJob((update) => {
        const text = JOB_MESSAGES[update.state];
        if (text) showToast({ text, kind: "info" });
        else if (update.state === "failed") showToast({ text: update.message ?? "Summary failed.", kind: "error" });
        else if (update.state === "skipped" && update.message?.startsWith("Skipped to save")) showToast({ text: update.message, kind: "info" });
      }),
    ];
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      offs.forEach((off) => off());
      clearInterval(clock);
    };
  }, [reload, showToast]);

  useEffect(() => write(PLACE_KEY, place), [place]);
  useEffect(() => write(CONTEXT_OPEN_KEY, String(contextOpen)), [contextOpen]);
  useEffect(() => write(LAST_PROJECT_KEY, projectId), [projectId]);
  useEffect(() => write(HIDDEN_KEY, JSON.stringify(hidden)), [hidden]);
  useEffect(() => write(NEW_SESSION_KEY, JSON.stringify(newPrefs)), [newPrefs]);

  // Keep the selected project and the scope pointing at projects that exist.
  useEffect(() => {
    if (!state) return;
    if (!projectId || !state.projects.some((p) => p.id === projectId)) setProjectId(state.projects.find((p) => !p.archived)?.id ?? null);
    if (scope && !state.projects.some((p) => p.id === scope && !p.archived)) setScope(null);
  }, [state, projectId, scope]);

  // The newest unread run of each project that has some, so the Board can show it and say whether it failed.
  useEffect(() => {
    if (!state) return;
    let cancelled = false;
    const ids = Object.keys(state.unreadRuns).filter((id) => state.projects.some((p) => p.id === id && !p.archived));
    Promise.all(
      ids.map((id) =>
        window.ghost.runs
          .list(id)
          .then(({ records }) => [id, records.filter((r) => !r.read && r.status !== "running").sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]] as const)
          .catch(() => [id, undefined] as const),
      ),
    ).then((pairs) => {
      if (cancelled) return;
      const next: Record<string, RunRecord> = {};
      for (const [id, record] of pairs) if (record) next[id] = record;
      setUnreadRunInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, [state, runsVersion]);

  // Keyboard: ⌘1-3 places, ⌘K palette, ⌘. context, ⌘N new session, ⌘I idea, ⌘F search, ⌘, settings.
  const newSessionRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const open: Record<string, () => void> = {
        "1": () => setPlace("board"),
        "2": () => setPlace("sessions"),
        "3": () => setPlace("projects"),
        k: () => setPaletteOpen(true),
        ".": () => setContextOpen((v) => !v),
        n: () => newSessionRef.current(),
        i: () => setIdeaOpen(true),
        f: () => setSearchOpen(true),
        ",": () => setSettingsOpen(true),
      };
      const action = open[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeProjects = useMemo(() => state?.projects.filter((p) => !p.archived) ?? [], [state]);
  const lastActive = useMemo(() => Object.fromEntries((ghost?.projects ?? []).map((g) => [g.projectId, relative(g.lastActivityAt)])), [ghost]);
  const items = useMemo(
    () =>
      state
        ? boardItems({ projects: state.projects, live, events, activityAt, unreadRuns: unreadRunInfo, pendingBriefs: state.pendingBriefs, ghost, hidden, scope, now })
        : [],
    [state, live, events, activityAt, unreadRunInfo, ghost, hidden, scope, now],
  );
  // Items you hid here (done or snoozed) that would otherwise show, so they can be brought back. Loops are left
  // out: Ghost lists its own snoozed loops.
  const hiddenItems = useMemo((): BoardItem[] => {
    if (!state) return [];
    const shown = new Set(items.map((i) => i.id));
    return boardItems({ projects: state.projects, live, events, activityAt, unreadRuns: unreadRunInfo, pendingBriefs: state.pendingBriefs, ghost: null, hidden: {}, scope, now }).filter(
      (i) => !shown.has(i.id) && hidden[i.id] > now,
    );
  }, [state, items, live, events, activityAt, unreadRunInfo, hidden, scope, now]);

  // The badge and the mark count every project, so a scope never hides that something is waiting elsewhere.
  const allNeeds = useMemo(
    () =>
      scope && state
        ? boardItems({ projects: state.projects, live, events, activityAt, unreadRuns: unreadRunInfo, pendingBriefs: state.pendingBriefs, ghost, hidden, scope: null, now }).filter((i) => i.group === "needs").length
        : items.filter((i) => i.group === "needs").length,
    [scope, state, live, events, activityAt, unreadRunInfo, ghost, hidden, now, items],
  );
  const needs = allNeeds;
  const needsElsewhere = allNeeds - items.filter((i) => i.group === "needs").length;

  // The session on Sessions: the one you picked, else the most recently active one.
  const focused = live.find((s) => s.key === focusedKey) ?? [...live].sort((a, b) => (activityAt[b.key] ?? 0) - (activityAt[a.key] ?? 0))[0];
  const scopeProject = activeProjects.find((p) => p.id === scope) ?? null;
  const recentProject =
    scopeProject ??
    activeProjects.find((p) => p.id === focused?.projectId && p.primaryPath) ??
    [...activeProjects].filter((p) => p.primaryPath).sort((a, b) => (ghost?.projects.find((g) => g.projectId === b.id)?.lastActivityAt ?? "").localeCompare(ghost?.projects.find((g) => g.projectId === a.id)?.lastActivityAt ?? ""))[0] ??
    null;

  const openLive = (key: string) => {
    setFocusedKey(key);
    setPlace("sessions");
  };

  const openSession = async (req: OpenSessionRequest): Promise<LiveSession | undefined> => {
    try {
      const { session, history } = await window.ghost.sessions.open(req);
      closedKeys.current.delete(session.key);
      setLive((prev) => (prev.some((s) => s.key === session.key) ? prev : [...prev, session]));
      // An already-open session keeps its live events; only a newly opened one gets transcript history.
      if (history) setEvents((prev) => ({ ...prev, [session.key]: history }));
      setActivityAt((prev) => ({ ...prev, [session.key]: Date.now() }));
      openLive(session.key);
      return session;
    } catch (err) {
      report(err);
      return undefined;
    }
  };

  /** A new session in a project's folder (or the one given), with a first message if there is one. */
  const startSession = async (targetId: string, text: string, cwd?: string, model?: string): Promise<boolean> => {
    const target = state?.projects.find((p) => p.id === targetId);
    const folder = cwd ?? target?.primaryPath;
    if (!folder) {
      report(new Error(`${target?.name ?? "That project"} has no folder on this Mac. Add one in Projects (⋯ → Folders…).`));
      return false;
    }
    const session = await openSession({ projectId: targetId, cwd: folder, model: (model ?? newPrefs.model) || undefined, permissionMode: newPrefs.permissionMode });
    if (!session) return false;
    if (!text) return true;
    try {
      await window.ghost.sessions.send(session.key, text);
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  };
  newSessionRef.current = () => {
    if (!recentProject) return report(new Error("Add a project with a folder first (Projects → + next to an area)."));
    void startSession(recentProject.id, "");
  };

  /** Opens a session by id in a project (from a run, summary, loop or search result). */
  const openSessionById = (targetProjectId: string, sessionId: string, title: string) => {
    const open = live.find((l) => l.sessionId === sessionId);
    if (open) return openLive(open.key);
    void openSession({ projectId: targetProjectId, resumeSessionId: sessionId, title });
  };

  /** Opens a past chat: shows it if it's live, else resumes it. */
  const openChat = (id: string, chat: SessionSummary) => {
    const open = live.find((l) => l.sessionId === chat.sessionId);
    if (open) openLive(open.key);
    else void openSession({ projectId: id, cwd: chat.cwd, resumeSessionId: chat.sessionId, title: chat.title });
  };

  const showProject = (id: string, page: ProjectPage = "overview") => {
    setProjectId(id);
    setProjectPage(page);
    setPlace("projects");
  };

  const openHit = (hit: SearchHit) => {
    setSearchOpen(false);
    if (!hit.projectId) return setIdeaOpen(true);
    const opensSession = hit.kind === "session" || hit.kind === "summary" || hit.kind === "run" || hit.kind === "sidenote";
    if (opensSession && hit.sessionId && SESSION_ID.test(hit.sessionId)) openSessionById(hit.projectId, hit.sessionId, hit.title.replace(/^(Summary|Run) · /, ""));
    else showProject(hit.projectId, hit.kind === "brief" ? "memory" : "chats");
  };

  const newCodingSession = (id: string) => {
    const target = state?.projects.find((p) => p.id === id);
    if (!target?.primaryPath) return report(new Error("Add a folder to this project first; Claude needs a folder to work in."));
    void openSession({ projectId: id, cwd: target.primaryPath, view: "terminal" });
  };

  const closeSession = async (key: string) => {
    closedKeys.current.add(key);
    try {
      await window.ghost.sessions.close(key);
      clearTerminal(key);
      setLive((prev) => prev.filter((s) => s.key !== key));
      setEvents((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (focusedKey === key) setFocusedKey(null);
    } catch (err) {
      closedKeys.current.delete(key);
      report(err);
    }
  };

  const replaceHistory = (key: string, history: ChatEvent[]) => setEvents((prev) => ({ ...prev, [key]: history }));
  const hide = (id: string, until: number) => setHidden((prev) => ({ ...prev, [id]: until }));
  const unhide = (id: string) =>
    setHidden((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  const turnOnGhost = () =>
    void window.ghost.settings
      .save({ ...state!.settings, ghost: { ...state!.settings.ghost, enabled: true } })
      .then(() => window.ghost.ghost.scan())
      .then(() => info("Ghost is on and looking across your projects"))
      .catch(report);
  const changeScope = (id: string | null) => {
    setScope(id);
    if (id) info(`Scope: ${state?.projects.find((p) => p.id === id)?.name ?? ""}`);
  };

  if (!state) {
    return (
      <div className="empty">
        {loadError ? (
          <>
            <p>GhostOS couldn't load your brain folder.</p>
            <p className="mono">{loadError}</p>
            <button onClick={() => void reload()}>Try again</button>
          </>
        ) : (
          "Loading GhostOS…"
        )}
      </div>
    );
  }

  const commands: Command[] = [
    { label: "New session", kbd: "⌘N", run: () => newSessionRef.current() },
    { label: "Capture an idea", kbd: "⌘I", run: () => setIdeaOpen(true) },
    { label: "Search inside chats", kbd: "⌘F", run: () => setSearchOpen(true) },
    { label: "Rules & about you", run: () => setCapabilitiesOpen("rules") },
    { label: "Design systems", run: () => setDesignOpen("") },
    { label: "Import from Claude", run: () => setImportOpen(true) },
    { label: "Look for unfinished work now", run: () => void window.ghost.ghost.scan().then(() => info("Looked across every project")).catch(report) },
    { label: "Settings", kbd: "⌘,", run: () => setSettingsOpen(true) },
  ];

  const selectedProject = state.projects.find((p) => p.id === projectId) ?? null;
  const focusedProject = focused ? state.projects.find((p) => p.id === focused.projectId) ?? null : null;

  return (
    <div className="app">
      <TopBar
        place={place}
        needs={needs}
        scope={scopeProject}
        projects={activeProjects}
        areas={state.areas}
        lastActive={lastActive}
        contextOpen={contextOpen}
        hasSession={!!focused}
        onPlace={setPlace}
        onScope={changeScope}
        onOpenPalette={() => setPaletteOpen(true)}
        onToggleContext={() => setContextOpen((v) => !v)}
      />
      <main className="place">
        {place === "board" && (
          <Board
            items={items}
            projects={state.projects}
            scope={scopeProject}
            now={now}
            openLive={openLive}
            openSessionById={openSessionById}
            startSession={startSession}
            needsElsewhere={needsElsewhere}
            hiddenItems={hiddenItems}
            hiddenUntil={hidden}
            ghost={ghost}
            unhide={unhide}
            onTurnOnGhost={turnOnGhost}
            showProject={(id, page) => showProject(id, page)}
            hide={hide}
            toast={info}
            onError={report}
          />
        )}
        {place === "sessions" && (
          <SessionsPlace
            session={focused}
            events={focused ? events[focused.key] ?? [] : []}
            project={focusedProject}
            projects={activeProjects}
            ghost={ghost}
            memoryVersion={memoryVersion}
            runsVersion={runsVersion}
            sidenoteVersion={sidenoteVersion}
            contextOpen={contextOpen}
            onOpenProject={(id) => showProject(id)}
            onOpenChat={openChat}
            onNewSessionWith={(id, model) => void startSession(id, "", undefined, model)}
            onClose={closeSession}
            onHistory={replaceHistory}
            toast={info}
            onError={report}
          />
        )}
        {place === "projects" && (
          <ProjectsPlace
            state={state}
            selected={selectedProject}
            view={projectPage}
            scope={scope}
            lastActive={lastActive}
            live={live}
            memoryVersion={memoryVersion}
            runsVersion={runsVersion}
            capabilitiesVersion={capabilitiesVersion}
            onSelect={(id) => showProject(id)}
            onView={setProjectPage}
            onScope={changeScope}
            onOpenLive={openLive}
            onOpenChat={openChat}
            onOpenSession={openSession}
            onOpenSessionById={openSessionById}
            onNewCodingSession={newCodingSession}
            onOpenDesign={(id) => setDesignOpen(id ?? "")}
            onError={report}
          />
        )}
      </main>
      <RunningStrip live={live} events={events} projects={state.projects} activeKey={place === "sessions" ? focused?.key ?? null : null} usage={usage} onOpen={openLive} />
      {paletteOpen && (
        <CommandPalette
          projects={activeProjects}
          areas={state.areas}
          live={live}
          scope={scopeProject}
          defaultProject={recentProject}
          commands={commands}
          prefs={newPrefs}
          onPrefs={setNewPrefs}
          onNewSession={(id, text) => void startSession(id, text)}
          onOpenLive={openLive}
          onOpenChat={openChat}
          onScope={changeScope}
          onError={report}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {ideaOpen && <IdeaCapture projects={activeProjects} defaultProjectId={scope ?? focused?.projectId ?? null} onClose={() => setIdeaOpen(false)} onError={report} />}
      {searchOpen && <SearchPalette projects={activeProjects} currentProjectId={scope} onOpen={openHit} onClose={() => setSearchOpen(false)} />}
      {settingsOpen && <SettingsDialog settings={state.settings} onClose={() => setSettingsOpen(false)} onError={report} />}
      {capabilitiesOpen && (
        <CapabilitiesDialog
          areas={state.areas}
          settings={state.settings}
          version={capabilitiesVersion}
          initialTab={capabilitiesOpen}
          onClose={() => setCapabilitiesOpen(false)}
          onError={report}
        />
      )}
      {designOpen !== undefined && (
        <DesignDialog areas={state.areas} projects={state.projects} initialId={designOpen || undefined} onClose={() => setDesignOpen(undefined)} onError={report} />
      )}
      {importOpen && (
        <ImportDialog
          projects={activeProjects}
          onClose={() => setImportOpen(false)}
          onDone={(result) => {
            setImportOpen(false);
            const skipped = result.skipped.length ? ` ${result.skipped.length} skipped: ${result.skipped.join("; ")}.` : "";
            showToast({ kind: "info", text: `Imported ${result.notes} notes and ${result.runs} runs (runs are off until you switch them on).${skipped}` });
          }}
          onError={report}
        />
      )}
      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
