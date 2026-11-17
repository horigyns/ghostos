// The API the preload script exposes to the renderer as window.ghost.
import type {
  VoiceView,
  AddSidenoteRequest,
  AgentDoc,
  CapabilityPlan,
  FolderSuggestion,
  SyncStatus,
  Area,
  BrainSettings,
  BriefProposal,
  GhostDigest,
  GhostState,
  ChatFolder,
  DesignSystem,
  DesignSystemView,
  ProjectOrganization,
  ChatEvent,
  RunDefinition,
  RunRecord,
  SearchHit,
  SessionSummaryDoc,
  Idea,
  LiveSession,
  MemoryNote,
  OpenSessionRequest,
  Project,
  ProjectView,
  SessionSummary,
  SessionView,
  Sidenote,
  UsageSnapshot,
} from "./types";

export interface BrainState {
  areas: Area[];
  projects: ProjectView[];
  ideas: Idea[];
  machineName: string;
  brainDir: string;
  /** problems reading brain files (shown to the user; the affected file is not overwritten) */
  warnings: string[];
  settings: BrainSettings;
  /** unread finished runs per project id */
  unreadRuns: Record<string, number>;
  /** projects with a brief update waiting for approval */
  pendingBriefs: string[];
  machineId: string;
}

export interface ImportableAgent {
  /** absolute path of the agent file */
  path: string;
  name: string;
  /** where it comes from, for display */
  source: string;
}

export interface CapabilitiesState {
  globalRules: string;
  areaRules: Record<string, string>;
  agents: AgentDoc[];
  plan: CapabilityPlan;
  importable: ImportableAgent[];
}

export interface RunInput {
  id?: string;
  projectId: string;
  name: string;
  prompt: string;
  schedule: RunDefinition["schedule"];
  model?: string;
  permissionMode: RunDefinition["permissionMode"];
  folder?: string;
  enabled: boolean;
}

export interface RunnerStatus {
  installed: boolean;
  lastTickAt?: number;
}

export interface MemoryState {
  brief: string;
  proposal?: BriefProposal;
  /** the brief was edited after the proposal was written */
  briefChangedSinceProposal: boolean;
  summaries: SessionSummaryDoc[];
  /** notes imported from Claude Code's auto-memory for this project */
  claudeMemory: MemoryNote[];
}

// ---------- importing from Claude ----------

export interface ImportMemoryItem {
  key: string;
  file: string;
  name: string;
  description: string;
  /** where the note comes from, for display */
  sourceLabel: string;
  /** project id, "me", or "" when GhostOS couldn't tell */
  target: string;
  /** "imported": the brain has this exact note; "changed": the brain has an older version */
  status: "new" | "imported" | "changed";
  /** looks like it contains a credential; not selected by default */
  secret: boolean;
  /** the project was matched by a folder-name prefix only (e.g. a worktree), so it isn't preselected */
  guessed: boolean;
  /** GhostOS's suggestion for the checkbox */
  selected: boolean;
}

export interface ImportRunItem {
  key: string;
  kind: "cloud-routine" | "desktop-task";
  name: string;
  promptPreview: string;
  scheduleText: string;
  /** still switched on in claude.ai or the desktop app */
  enabledThere: boolean;
  model?: string;
  connectors: string[];
  target: string;
  status: "new" | "imported";
  /** false when the schedule or instructions can't be brought over */
  importable: boolean;
  selected: boolean;
}

export interface ImportScan {
  memory: ImportMemoryItem[];
  runs: ImportRunItem[];
  /** where GhostOS looks for the claude.ai routines snapshot */
  routinesFile: string;
  /** when that snapshot was saved; absent when there is none */
  routinesSavedAt?: string;
}

export interface ImportSelection {
  memory?: { key: string; target: string }[];
  runs?: { key: string; target: string }[];
}

export interface ImportResult {
  notes: number;
  runs: number;
  skipped: string[];
}

export interface MemoryJobUpdate {
  projectId: string;
  sessionId: string;
  state: "queued" | "running" | "done" | "skipped" | "failed";
  message?: string;
}

export interface GhostApi {
  getState(): Promise<BrainState>;
  areas: {
    add(name: string): Promise<Area>;
    rename(id: string, name: string): Promise<void>;
    move(id: string, direction: -1 | 1): Promise<void>;
    remove(id: string): Promise<void>;
  };
  projects: {
    create(input: { name: string; area: string }): Promise<Project>;
    /** archived: true moves it out of the sidebar, Ghost and the scheduler; false restores it */
    update(id: string, patch: { name?: string; area?: string; description?: string; archived?: boolean }): Promise<Project>;
    /** removes an archived project from the brain (transcripts and folders on disk stay) */
    remove(id: string): Promise<void>;
    /** opens a folder picker; returns the updated project, or undefined if cancelled */
    addFolder(id: string): Promise<Project | undefined>;
    removeFolder(id: string, folderPath: string): Promise<Project>;
  };
  sessions: {
    listPast(projectId: string): Promise<SessionSummary[]>;
    live(): Promise<LiveSession[]>;
    /** history is omitted when the session was already open (keep its live events) */
    open(req: OpenSessionRequest): Promise<{ session: LiveSession; history?: ChatEvent[] }>;
    history(key: string): Promise<ChatEvent[]>;
    send(key: string, text: string): Promise<void>;
    stop(key: string): Promise<void>;
    close(key: string): Promise<void>;
    setView(key: string, view: SessionView): Promise<ChatEvent[] | undefined>;
    writeTerminal(key: string, data: string): void;
    resizeTerminal(key: string, cols: number, rows: number): void;
  };
  sidenotes: {
    list(projectId: string): Promise<Sidenote[]>;
    add(req: AddSidenoteRequest): Promise<Sidenote>;
    /** sends a saved note into its session, delivered after the current turn or with the next message */
    send(projectId: string, id: string): Promise<Sidenote>;
    /** takes back a queued note that hasn't been delivered yet */
    withdraw(projectId: string, id: string): Promise<Sidenote>;
    promote(projectId: string, id: string): Promise<Idea>;
  };
  runs: {
    list(projectId: string): Promise<{ definitions: RunDefinition[]; records: RunRecord[]; approved: Record<string, boolean> }>;
    /** approves a run (e.g. one synced from another Mac) to execute on this Mac */
    approve(projectId: string, runId: string): Promise<void>;
    save(input: RunInput): Promise<RunDefinition>;
    remove(projectId: string, runId: string): Promise<void>;
    runNow(projectId: string, runId: string): Promise<void>;
    markRead(projectId: string, recordId: string): Promise<void>;
  };
  files: {
    /** absolute paths of files the user picks, to hand to Claude */
    pick(): Promise<string[]>;
  };
  /** how the user writes: the voice guide and writing samples every session is told about */
  voice: {
    get(): Promise<VoiceView>;
    saveGuide(text: string): Promise<VoiceView>;
    /** picks Word, RTF, text or markdown files and keeps their text as samples */
    addFiles(): Promise<VoiceView>;
    pasteSample(name: string, text: string): Promise<VoiceView>;
    removeSample(file: string): Promise<VoiceView>;
    openSample(file: string): Promise<void>;
    reveal(): Promise<void>;
    /** Claude's draft of the guide from the samples, for the user to edit before saving */
    draft(): Promise<string>;
  };
  memory: {
    get(projectId: string): Promise<MemoryState>;
    saveBrief(projectId: string, text: string): Promise<void>;
    /** applies the pending proposal (optionally as edited) */
    acceptProposal(projectId: string, text?: string): Promise<void>;
    dismissProposal(projectId: string): Promise<void>;
    summarize(projectId: string, sessionId: string, cwd: string): Promise<void>;
    /** notes about you (scope "me") */
    aboutMe(): Promise<MemoryNote[]>;
    /** scope: a project id or "me" */
    removeNote(scope: string, file: string): Promise<void>;
  };
  organize: {
    get(projectId: string): Promise<ProjectOrganization>;
    createFolder(projectId: string, name: string): Promise<ChatFolder>;
    renameFolder(projectId: string, folderId: string, name: string): Promise<void>;
    /** its chats go back to the project's main list */
    deleteFolder(projectId: string, folderId: string): Promise<void>;
    /** folderId null = out of any folder */
    place(projectId: string, sessionId: string, folderId: string | null): Promise<void>;
    hide(projectId: string, sessionId: string, hidden: boolean): Promise<void>;
    /** moves the chat's transcript to the macOS Trash */
    trash(projectId: string, sessionId: string): Promise<void>;
  };
  design: {
    list(): Promise<DesignSystem[]>;
    get(id: string): Promise<DesignSystemView>;
    create(name: string): Promise<DesignSystemView>;
    save(id: string, patch: { name?: string; description?: string; areas?: string[]; projects?: string[] }): Promise<DesignSystemView>;
    saveGuide(id: string, text: string): Promise<void>;
    /** opens a file picker; copies the chosen files into the design system */
    addAssets(id: string): Promise<DesignSystemView>;
    removeAsset(id: string, file: string): Promise<void>;
    /** a data: URL for an image asset's thumbnail (undefined for other files or large ones) */
    assetPreview(id: string, file: string): Promise<string | undefined>;
    openAsset(id: string, file: string): Promise<void>;
    /** opens a file picker for a file in a project folder that defines the brand */
    addSource(id: string): Promise<DesignSystemView>;
    removeSource(id: string, index: number): Promise<void>;
    remove(id: string): Promise<void>;
    reveal(id: string): Promise<void>;
    /** Claude (read-only) drafts DESIGN.md from the linked projects' files; returns the draft */
    draft(id: string): Promise<string>;
  };
  outputs: {
    /** opens a file in a pop-out viewer (project files, or ones the open session wrote) */
    open(projectId: string, file: string, sessionKey?: string): Promise<void>;
  };
  ghost: {
    state(): Promise<GhostState>;
    /** scans every project now */
    scan(): Promise<GhostState>;
    decide(loopId: string, action: "done" | "dismiss" | "snooze-day" | "snooze-week" | "reopen"): Promise<void>;
    /** asks Claude for a digest of what's slipping (uses a little usage) */
    digest(): Promise<GhostDigest>;
  };
  importer: {
    /** what Claude has that GhostOS can bring in (reads only) */
    scan(): Promise<ImportScan>;
    apply(selection: ImportSelection): Promise<ImportResult>;
  };
  settings: {
    save(settings: BrainSettings): Promise<void>;
    runnerStatus(): Promise<RunnerStatus>;
    setRunner(enabled: boolean): Promise<RunnerStatus>;
  };
  search(query: string, projectId: string | null): Promise<SearchHit[]>;
  capabilities: {
    get(): Promise<CapabilitiesState>;
    /** scope {} = global rules; {area} = an area's rules; {projectId} = a project's rules */
    saveRules(scope: { area?: string; projectId?: string }, text: string): Promise<void>;
    projectRules(projectId: string): Promise<string>;
    /** exactly what a new session in the project starts with */
    previewContext(projectId: string): Promise<string>;
    saveAgent(agent: AgentDoc): Promise<AgentDoc>;
    removeAgent(scope: string, name: string): Promise<void>;
    importAgent(path: string, scope: string): Promise<AgentDoc>;
    /** writes GhostOS's hooks and agents into ~/.claude (backing up settings.json) */
    apply(): Promise<CapabilityPlan>;
    remove(): Promise<void>;
  };
  machine: {
    suggestFolders(projectId: string): Promise<FolderSuggestion[]>;
    linkFolder(projectId: string, folderIndex: number, path: string): Promise<void>;
    moveRunHere(projectId: string, runId: string): Promise<void>;
  };
  sync: {
    status(): Promise<SyncStatus>;
    now(): Promise<SyncStatus>;
    connect(url: string): Promise<SyncStatus>;
    createGithub(name: string): Promise<SyncStatus>;
  };
  ideas: {
    add(text: string, projectId: string | null): Promise<Idea>;
    update(id: string, patch: { projectId?: string | null; text?: string; status?: "open" | "archived" }): Promise<Idea>;
  };
  shell: {
    reveal(folder: string): Promise<void>;
    openInVSCode(folder: string): Promise<void>;
  };
  on: {
    sessionEvent(cb: (key: string, event: ChatEvent) => void): () => void;
    sessionState(cb: (session: LiveSession) => void): () => void;
    terminalData(cb: (key: string, data: string) => void): () => void;
    sessionHistory(cb: (key: string, history: ChatEvent[]) => void): () => void;
    usage(cb: (usage: UsageSnapshot) => void): () => void;
    brainChanged(cb: () => void): () => void;
    sidenotesChanged(cb: (projectId: string) => void): () => void;
    runsChanged(cb: (projectId: string) => void): () => void;
    memoryChanged(cb: (projectId: string) => void): () => void;
    memoryJob(cb: (update: MemoryJobUpdate) => void): () => void;
    capabilitiesChanged(cb: () => void): () => void;
    syncChanged(cb: (status: SyncStatus) => void): () => void;
    ghostChanged(cb: (state: GhostState) => void): () => void;
    organizeChanged(cb: (projectId: string) => void): () => void;
    designChanged(cb: () => void): () => void;
    /** a Ghost notification was clicked: show Ghost (for that project, when given) */
    ghostOpen(cb: (projectId: string | null) => void): () => void;
  };
}

/** IPC channel names, shared so main and preload can't drift apart. */
export const IPC = {
  getState: "brain:get-state",
  areaAdd: "area:add",
  areaRename: "area:rename",
  areaMove: "area:move",
  areaRemove: "area:remove",
  projectCreate: "project:create",
  projectUpdate: "project:update",
  projectDelete: "project:delete",
  projectAddFolder: "project:add-folder",
  projectRemoveFolder: "project:remove-folder",
  sessionsPast: "sessions:past",
  sessionsLive: "sessions:live",
  sessionOpen: "session:open",
  sessionHistory: "session:history",
  sessionSend: "session:send",
  sessionStop: "session:stop",
  sessionClose: "session:close",
  sessionSetView: "session:set-view",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  sidenoteList: "sidenote:list",
  sidenoteAdd: "sidenote:add",
  sidenoteSend: "sidenote:send",
  sidenoteWithdraw: "sidenote:withdraw",
  sidenotePromote: "sidenote:promote",
  runsList: "runs:list",
  runsSave: "runs:save",
  runsRemove: "runs:remove",
  runsRunNow: "runs:run-now",
  runsApprove: "runs:approve",
  runsMarkRead: "runs:mark-read",
  memoryGet: "memory:get",
  memorySaveBrief: "memory:save-brief",
  memoryAccept: "memory:accept",
  memoryDismiss: "memory:dismiss",
  memorySummarize: "memory:summarize",
  filesPick: "files:pick",
  voiceGet: "voice:get",
  voiceSaveGuide: "voice:save-guide",
  voiceAddFiles: "voice:add-files",
  voicePasteSample: "voice:paste-sample",
  voiceRemoveSample: "voice:remove-sample",
  voiceOpenSample: "voice:open-sample",
  voiceReveal: "voice:reveal",
  voiceDraft: "voice:draft",
  memoryAboutMe: "memory:about-me",
  memoryRemoveNote: "memory:remove-note",
  importScan: "import:scan",
  organizeGet: "organize:get",
  organizeCreateFolder: "organize:create-folder",
  organizeRenameFolder: "organize:rename-folder",
  organizeDeleteFolder: "organize:delete-folder",
  organizePlace: "organize:place",
  organizeHide: "organize:hide",
  sessionTrash: "session:trash",
  designList: "design:list",
  designGet: "design:get",
  designCreate: "design:create",
  designSave: "design:save",
  designSaveGuide: "design:save-guide",
  designAddAssets: "design:add-assets",
  designRemoveAsset: "design:remove-asset",
  designAssetPreview: "design:asset-preview",
  designOpenAsset: "design:open-asset",
  designAddSource: "design:add-source",
  designRemoveSource: "design:remove-source",
  designRemove: "design:remove",
  designReveal: "design:reveal",
  designDraft: "design:draft",
  outputOpen: "output:open",
  evOrganizeChanged: "ev:organize-changed",
  evDesignChanged: "ev:design-changed",
  ghostState: "ghost:state",
  ghostScan: "ghost:scan",
  ghostDecide: "ghost:decide",
  ghostDigest: "ghost:digest",
  evGhostChanged: "ev:ghost-changed",
  evGhostOpen: "ev:ghost-open",
  importApply: "import:apply",
  settingsSave: "settings:save",
  runnerStatus: "runner:status",
  runnerSet: "runner:set",
  search: "search:query",
  capabilitiesGet: "capabilities:get",
  rulesSave: "rules:save",
  projectRulesGet: "rules:project",
  sessionContextPreview: "rules:preview",
  agentSave: "agent:save",
  agentRemove: "agent:remove",
  agentImport: "agent:import",
  capabilitiesApply: "capabilities:apply",
  capabilitiesRemove: "capabilities:remove",
  projectSuggestFolders: "project:suggest-folders",
  projectLinkFolder: "project:link-folder",
  runsMoveHere: "runs:move-here",
  syncStatus: "sync:status",
  syncNow: "sync:now",
  syncConnect: "sync:connect",
  syncCreateGithub: "sync:create-github",
  evCapabilitiesChanged: "ev:capabilities-changed",
  evSyncChanged: "ev:sync-changed",
  evRunsChanged: "ev:runs-changed",
  evMemoryChanged: "ev:memory-changed",
  evMemoryJob: "ev:memory-job",
  ideaAdd: "idea:add",
  ideaUpdate: "idea:update",
  shellReveal: "shell:reveal",
  shellVSCode: "shell:vscode",
  evSessionEvent: "ev:session-event",
  evSessionState: "ev:session-state",
  evTerminalData: "ev:terminal-data",
  evSessionHistory: "ev:session-history",
  evUsage: "ev:usage",
  evBrainChanged: "ev:brain-changed",
  evSidenotesChanged: "ev:sidenotes-changed",
} as const;
