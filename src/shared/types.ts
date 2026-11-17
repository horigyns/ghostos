// Types shared by the main process, preload and renderer.

/** The area that holds unsorted projects; it can't be removed. */
export const FALLBACK_AREA_ID = "random";

export interface Area {
  id: string;
  name: string;
}

/** A folder that belongs to a project. Paths are stored per machine so the brain can sync between Macs. */
export interface ProjectFolder {
  label?: string;
  /** git remote URL, when the folder is a repo; used to match the folder on another Mac */
  remote?: string;
  /** machine id -> absolute path on that machine */
  paths: Record<string, string>;
}

export interface Project {
  id: string;
  name: string;
  area: string;
  description?: string;
  /** archived (deprecated) projects leave the sidebar, Ghost and the scheduler; their history stays */
  archived?: boolean;
  archivedAt?: string;
  folders: ProjectFolder[];
  createdAt: string;
}

/** A project as seen from this machine. */
export interface ProjectView extends Project {
  localFolders: { label: string; path: string; exists: boolean }[];
  /** the folder new Claude sessions start in */
  primaryPath?: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: number;
  cwd: string;
}

export type SidenoteMode = "now" | "after" | "later";
export type SidenoteStatus = "queued" | "delivered" | "saved";

export interface Sidenote {
  id: string;
  projectId: string;
  /** Claude session the note belongs to; empty until the session has started */
  sessionId: string;
  text: string;
  mode: SidenoteMode;
  status: SidenoteStatus;
  createdAt: string;
  /** set on every change (see Idea.updatedAt) */
  updatedAt?: string;
  deliveredAt?: string;
}

export interface Idea {
  id: string;
  /** null = global inbox, not yet attached to a project */
  projectId: string | null;
  text: string;
  status: "open" | "archived";
  createdAt: string;
  /** set on every change; after two Macs' copies are merged, the newest version of an idea wins */
  updatedAt?: string;
}

export type PermissionMode = "auto" | "acceptEdits" | "plan" | "manual";

export interface UsageSnapshot {
  fiveHourPct?: number;
  fiveHourResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  observedAt: number;
}

/** Events a chat session streams to the renderer. */
export type ChatEvent =
  | { kind: "init"; sessionId: string; model?: string }
  | { kind: "user"; text: string }
  | { kind: "assistant-text"; text: string }
  /** filePath: the absolute file a Write/Edit/NotebookEdit touched, so its output can be opened */
  | { kind: "tool-use"; id: string; name: string; summary: string; filePath?: string }
  | { kind: "tool-result"; id: string; isError: boolean; preview: string }
  | { kind: "turn-end"; ok: boolean; error?: string; costUsd?: number; durationMs?: number }
  | { kind: "usage"; usage: UsageSnapshot }
  | { kind: "notice"; text: string }
  | { kind: "exit"; code: number | null }
  /** which MCP servers (claude.ai connectors, plugins, local) the session's Claude Code reached */
  | { kind: "connectors"; summary: ConnectorSummary };

export interface ConnectorSummary {
  connected: string[];
  needsAuth: string[];
  failed: string[];
  pending: string[];
}

export type SessionView = "chat" | "terminal";

export interface LiveSession {
  key: string;
  projectId: string;
  cwd: string;
  sessionId?: string;
  title: string;
  view: SessionView;
  busy: boolean;
  model?: string;
  permissionMode: PermissionMode;
  /** the MCP servers its current Claude Code process reached, once known */
  connectors?: ConnectorSummary;
}

export interface OpenSessionRequest {
  projectId: string;
  /** omit when resuming by id; the main process finds the folder the session ran in */
  cwd?: string;
  resumeSessionId?: string;
  title?: string;
  model?: string;
  permissionMode?: PermissionMode;
  /** "terminal" opens it straight in Claude Code's terminal UI (a coding session) */
  view?: SessionView;
}

// ---------- Phase 2: runs, budget, memory ----------

export type RunSchedule =
  | { kind: "daily"; time: string } // "HH:MM", local time
  | { kind: "weekly"; days: number[]; time: string } // days: 0 = Sunday … 6 = Saturday
  | { kind: "interval"; everyMinutes: number }
  /** five-field cron, evaluated in `tz` (an IANA zone) or this Mac's local time; used by imported claude.ai routines */
  | { kind: "cron"; expr: string; tz?: string }
  /** a single run at an ISO time */
  | { kind: "once"; at: string };

/** Where a run came from when it was imported from Claude (a claude.ai routine or a desktop scheduled task). */
export interface RunImport {
  kind: "cloud-routine" | "desktop-task";
  /** the routine's or task's id over there, so it is never imported twice */
  id: string;
  name: string;
  /** claude.ai connectors the routine used (Claude Code on this Mac reaches them through the same account) */
  connectors?: string[];
  importedAt: string;
}

/** A recurring Claude job defined for a project. Runs headless with `claude -p` on one machine. */
export interface RunDefinition {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  schedule: RunSchedule;
  model?: string;
  permissionMode: PermissionMode;
  /** folder to run in on the runner machine; defaults to the project's primary folder */
  folder?: string;
  /** machine id that runs it, so the same run never fires on two Macs */
  runOn: string;
  enabled: boolean;
  createdAt: string;
  /** last edit; slots before it never run, so changing a schedule doesn't fire a run at once */
  updatedAt?: string;
  importedFrom?: RunImport;
}

export type RunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface RunRecord {
  id: string;
  runId: string;
  projectId: string;
  name: string;
  trigger: "schedule" | "manual";
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  /** why a run was skipped or failed, or which model the budget guard switched to */
  note?: string;
  model?: string;
  sessionId?: string;
  resultText?: string;
  costUsd?: number;
  read: boolean;
  /** the process executing the run and its boot, so an interrupted run can be recognised */
  ownerPid?: number;
  ownerBootAt?: number;
  /** Claude's process (also its process-group id) */
  childPid?: number;
}

export interface BudgetSettings {
  /** background work (runs, summaries) pauses at or above this weekly usage */
  pauseAboveWeekPct: number;
  /** runs wait for the 5-hour window to reset at or above this */
  pauseAboveFiveHourPct: number;
  /** scheduled runs switch to the cheaper model at or above this weekly usage */
  downgradeAboveWeekPct: number;
  downgradeModel: "sonnet" | "haiku";
}

export type EnforcementLevel = "block" | "remind" | "off";

/** What GhostOS's hook does in Claude Code sessions inside GhostOS project folders (any surface). */
export interface EnforcementSettings {
  /** give each session its global, area and project rules and the project brief at start */
  sessionContext: boolean;
  /** before `git commit`, require that the code-reviewer agent ran since the last commit */
  reviewBeforeCommit: EnforcementLevel;
  /** after a turn that changed 5+ files, remind Claude to run the documenter agent (once per session) */
  documenterReminder: Exclude<EnforcementLevel, "block">;
  /** when a shell command fails in a project with docs/error-log, remind Claude to check it (once per session) */
  errorLogReminder: Exclude<EnforcementLevel, "block">;
}

/** How Ghost, the supervisor over all projects, watches for unfinished and stalled work. */
export interface GhostSettings {
  enabled: boolean;
  /** a project with open loops and no activity for this many days counts as stalled */
  stallDays: number;
  /** macOS notifications for stalled projects */
  notifications: boolean;
  /** after a stalled project's notification, wait this many days before reminding again */
  remindEveryDays: number;
  /** no notifications between these hours (local, 0-23); equal values turn quiet hours off */
  quietFrom: number;
  quietTo: number;
  /** summarize finished Claude sessions from VS Code, the terminal and the desktop app (Haiku, budget-guarded) */
  autoSummarize: boolean;
  /** a daily digest from Claude of what's slipping, at this local time ("HH:MM"); empty = off */
  digestTime: string;
}

export interface BrainSettings {
  budget: BudgetSettings;
  /** false = Claude proposes brief updates for approval; true = updates apply automatically */
  autoApplyBriefs: boolean;
  enforcement: EnforcementSettings;
  ghost: GhostSettings;
}

/** A subagent definition kept in the brain: for every project (global) or for one area's projects. */
export interface AgentDoc {
  /** file name without .md, also the agent name Claude sees */
  name: string;
  /** "global" or an area id */
  scope: string;
  /** the full markdown file, including its frontmatter */
  content: string;
}

export interface CapabilityFile {
  path: string;
  /** "write": GhostOS will create or update it; "same": already up to date; "conflict": a file GhostOS doesn't own is in the way */
  state: "write" | "same" | "conflict" | "remove";
  note?: string;
}

export interface CapabilityPlan {
  applied: boolean;
  files: CapabilityFile[];
  /** hook events GhostOS adds to ~/.claude/settings.json */
  hookEvents: string[];
}

export interface SyncStatus {
  remote?: string;
  lastSyncAt?: number;
  error?: string;
  /** commits waiting to be pushed */
  ahead: number;
}

export interface FolderSuggestion {
  folderIndex: number;
  label: string;
  path: string;
  reason: "git remote" | "folder name";
}

export interface SessionSummaryDoc {
  sessionId: string;
  projectId: string;
  title: string;
  summary: string;
  decisions: string[];
  openThreads: string[];
  createdAt: string;
}

export interface BriefProposal {
  text: string;
  sessionId: string;
  createdAt: string;
  /** hash of the brief the proposal was written against, to warn when it changed since */
  baseHash?: string;
}

export interface SearchHit {
  kind: "session" | "sidenote" | "idea" | "brief" | "summary" | "run";
  projectId: string | null;
  sessionId?: string;
  cwd?: string;
  title: string;
  snippet: string;
  at?: number;
}

export interface AddSidenoteRequest {
  projectId: string;
  sessionKey: string;
  text: string;
  mode: SidenoteMode;
}

/** A note from Claude Code's auto-memory (~/.claude/projects/<folder>/memory), kept in the brain so it syncs. */
export interface MemoryNote {
  /** file name, e.g. "timezone.md" */
  file: string;
  name: string;
  description: string;
  content: string;
}

/** Brain scope for memory notes: a project id, or "me" for notes about the user. */
export const ME_SCOPE = "me";

// ---------- Ghost: the supervisor that keeps work from falling through the cracks ----------

export type LoopKind = "thread" | "uncommitted" | "unpushed" | "branches" | "run-failed" | "sidenote";

/** One piece of unfinished work Ghost is tracking. Worked out fresh on every scan from what GhostOS already knows. */
export interface GhostLoop {
  /** stable across scans, so snoozing or closing it sticks */
  id: string;
  projectId: string;
  kind: LoopKind;
  title: string;
  detail?: string;
  /** the last time anyone worked on it (ISO) */
  lastActivityAt: string;
  /** to open it: a session to resume, or a folder */
  sessionId?: string;
  cwd?: string;
  folder?: string;
}

/** What the user (or a later session summary) decided about a loop. Stored in the brain, synced. */
export interface GhostDecision {
  /** the loop id */
  id: string;
  status: "done" | "dismissed" | "snoozed" | "open";
  snoozeUntil?: string;
  /** "user", or "summary" when a later session's summary said the thread was finished */
  by: "user" | "summary";
  /** the session whose summary closed it */
  sessionId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface GhostProjectStatus {
  projectId: string;
  /** latest activity across sessions, commits, runs (ISO); absent when nothing is known */
  lastActivityAt?: string;
  /** whole days since then */
  idleDays?: number;
  stalled: boolean;
  loops: GhostLoop[];
}

export interface GhostDigest {
  text: string;
  createdAt: string;
  model: string;
}

export interface GhostState {
  enabled: boolean;
  scanning: boolean;
  lastScanAt?: string;
  /** projects with open loops, stalled first */
  projects: GhostProjectStatus[];
  /** loops hidden by a snooze, for the "snoozed" list */
  snoozed: { loop: GhostLoop; until: string }[];
  digest?: GhostDigest;
  digestRunning: boolean;
  /** sessions summarized for Ghost in the last scan, and how many wait in the queue */
  summarizedLastScan: number;
  stallDays: number;
}

// ---------- organizing a project's chats ----------

/** A folder the user made inside a project to group its chats (GhostOS's own; it doesn't touch the disk). */
export interface ChatFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectOrganization {
  folders: ChatFolder[];
  /** session id -> chat folder id */
  placement: Record<string, string>;
  /** sessions removed from the project's lists (their transcripts stay) */
  hidden: string[];
}

// ---------- design systems ----------

/** A file in a project folder that is the source of truth for part of a design system (e.g. tailwind.config.js). */
export interface DesignSource {
  projectId: string;
  /** the project folder's label; with relPath it resolves on each Mac */
  folderLabel: string;
  relPath: string;
}

/** A brand's design system, kept in the brain and given to Claude in the areas and projects it applies to. */
export interface DesignSystem {
  id: string;
  name: string;
  description?: string;
  /** area ids and project ids it applies to */
  areas: string[];
  projects: string[];
  sources: DesignSource[];
  createdAt: string;
  updatedAt?: string;
}

export interface DesignAsset {
  file: string;
  bytes: number;
}

export interface DesignSystemView extends DesignSystem {
  /** DESIGN.md: brand, logo rules, colors, type, voice */
  guide: string;
  guidePath: string;
  assetsDir: string;
  assets: DesignAsset[];
  /** sources resolved on this Mac */
  resolvedSources: (DesignSource & { path?: string; exists: boolean })[];
}

// ---------- the user's writing voice ----------

/** A piece the user wrote, kept so Claude can match how they write. */
export interface WritingSample {
  file: string;
  bytes: number;
  excerpt: string;
}

export interface VoiceView {
  /** the voice guide (me/voice.md): how the user writes */
  guide: string;
  guidePath: string;
  samplesDir: string;
  samples: WritingSample[];
}
