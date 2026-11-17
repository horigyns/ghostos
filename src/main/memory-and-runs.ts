// Phase 2 wiring: scheduled runs (in-app ticking + the launchd runner), the budget guard's usage
// cache, project memory (summaries and briefs), settings and search. Registered by index.ts.
import { app, ipcMain } from "electron";
import crypto from "node:crypto";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { IPC, type ImportResult, type ImportScan, type MemoryState, type RunnerStatus } from "../shared/api";
import { ME_SCOPE, type BrainSettings, type EnforcementSettings, type MemoryNote, type ProjectView, type RunDefinition, type RunSchedule, type SearchHit, type UsageSnapshot } from "../shared/types";
import type { BrainStore } from "./brain/store";
import type { BrainGit } from "./brain/git";
import { runFolder } from "./brain/view";
import { MemoryService, hashText } from "./memory/service";
import { applyClaudeImports, defaultImportPaths, scanClaudeImports } from "./import/claude-import";
import { ghostSettings, setupGhost } from "./ghost-wiring";
import type { GhostService } from "./ghost/service";
import { backgroundAllowed } from "./runs/budget";
import { executeRun, isRunActive, reconcileInterruptedRuns, stopActiveRuns } from "./runs/executor";
import { installRunner, runnerInstalled, runnerUpToDate, uninstallRunner } from "./runs/launchd";
import { LocalState } from "./runs/local-state";
import { validateSchedule } from "./runs/schedule";
import { tick } from "./runs/tick";
import type { SessionManager } from "./sessions/manager";
import * as v from "./validate";

const TICK_MS = 60_000;
const SEARCH_TIMEOUT_MS = 60_000;
const PERCENT_MAX = 100;
const BRIEF_MAX_CHARS = 40_000;

export interface Phase2Deps {
  store: BrainStore;
  git: BrainGit;
  sessions: SessionManager;
  machineId: string;
  appData: string;
  claudeBinary: string;
  env: () => NodeJS.ProcessEnv;
  views: () => ProjectView[];
  projectView: (id: unknown) => ProjectView;
  send: (channel: string, ...args: unknown[]) => void;
  focusWindow: () => void;
}


const LEVELS = ["block", "remind", "off"] as const;
const REMIND_LEVELS = ["remind", "off"] as const;

function enforcementSettings(input: unknown, current: EnforcementSettings): EnforcementSettings {
  if (input === undefined) return current;
  const raw = v.pick(input, ["sessionContext", "reviewBeforeCommit", "documenterReminder", "errorLogReminder"] as const);
  const level = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    value === undefined ? fallback : allowed.includes(value as T) ? (value as T) : (() => { throw new Error("Unknown enforcement level."); })();
  return {
    sessionContext: raw.sessionContext === undefined ? current.sessionContext : raw.sessionContext === true,
    reviewBeforeCommit: level(raw.reviewBeforeCommit, LEVELS, current.reviewBeforeCommit),
    documenterReminder: level(raw.documenterReminder, REMIND_LEVELS, current.documenterReminder),
    errorLogReminder: level(raw.errorLogReminder, REMIND_LEVELS, current.errorLogReminder),
  };
}

function percent(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > PERCENT_MAX) throw new Error(`${what} must be 1–100.`);
  return Math.round(value);
}

export function setupPhase2(deps: Phase2Deps): { stop: () => Promise<void> } {
  const { store, git, sessions, machineId, appData } = deps;
  const local = new LocalState(appData);
  const runnerScript = path.join(app.getAppPath(), "dist", "runner", "index.js");

  const brainChanged = (reason: string, projectId?: string) => {
    git.scheduleCommit(reason);
    deps.send(IPC.evBrainChanged);
    if (projectId) deps.send(IPC.evRunsChanged, projectId);
  };

  // Usage reported by any chat feeds the budget guard (shared with the background runner).
  sessions.on("usage", (usage: UsageSnapshot) => local.recordUsage(usage));

  // Ghost is created after the summarizer (it queues summaries); the summarizer asks it for tracked threads.
  let ghost: GhostService | undefined;
  const memory = new MemoryService({
    store,
    local,
    claudeBinary: deps.claudeBinary,
    env: deps.env,
    jobsDir: path.join(appData, "jobs"),
    onStatus: (status) => deps.send(IPC.evMemoryJob, status),
    onChanged: (projectId, reason) => {
      git.scheduleCommit(reason);
      deps.send(IPC.evMemoryChanged, projectId);
      deps.send(IPC.evBrainChanged);
      ghost?.recompute(); // a new summary can add or close open threads
    },
    trackedThreads: (projectId) => ghost?.trackedThreads(projectId) ?? [],
    onThreadsResolved: (_projectId, sessionId, loopIds) => ghost?.threadsResolved(sessionId, loopIds),
  });
  const ghostWiring = setupGhost({
    store,
    appData,
    // Archived projects are out of Ghost's sight.
    views: () => deps.views().filter((p) => !p.archived),
    liveSessionIds: () => new Set(sessions.list().map((s) => s.sessionId).filter((id): id is string => Boolean(id))),
    // Screenshot runs (GHOSTOS_CAPTURE) never spend usage on summaries or digests.
    usageAllowed: () => !process.env.GHOSTOS_CAPTURE && backgroundAllowed(local.getUsage(), store.getSettings().budget, Date.now()),
    enqueueSummary: (job) => memory.enqueue({ ...job, manual: false }),
    onDecided: (reason) => git.scheduleCommit(reason),
    claude: { binary: deps.claudeBinary, env: deps.env, jobsDir: path.join(appData, "jobs") },
    send: deps.send,
    focusWindow: deps.focusWindow,
  });
  ghost = ghostWiring.ghost;
  // A chat that actually did something gets summarized when its tab closes.
  sessions.on("closed", (live, hadTurn) => {
    if (hadTurn && live.sessionId) memory.enqueue({ projectId: live.projectId, sessionId: live.sessionId, cwd: live.cwd, manual: false });
  });

  // ---------- scheduler: tick every minute while the app is open ----------
  const tickCtx = {
    store,
    local,
    claudeBinary: deps.claudeBinary,
    get env() {
      return deps.env();
    },
    machineId,
    folderFor: (def: RunDefinition) => runFolder(def, store.getProject(def.projectId), machineId),
    onBrainChanged: (reason: string) => brainChanged(reason),
  };
  let ticking = false;
  const runTick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await tick(tickCtx);
    } catch (err) {
      console.warn(`[runs] tick failed: ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  };
  const tickTimer = setInterval(() => {
    void runTick();
    refreshRunner();
  }, TICK_MS);

  // Notice run results written by the background runner.
  const seenHistory = new Map<string, number>();
  const watchTimer = setInterval(() => {
    for (const p of store.listProjects()) {
      const mtime = store.historyMtime(p.id);
      if (seenHistory.has(p.id) && seenHistory.get(p.id) !== mtime) {
        deps.send(IPC.evRunsChanged, p.id);
        deps.send(IPC.evBrainChanged);
      }
      seenHistory.set(p.id, mtime);
    }
  }, TICK_MS / 4);

  // Runs left "running" by a process that died (quit hard, reboot) are closed with a note.
  if (reconcileInterruptedRuns(store)) brainChanged("close interrupted runs");

  // Keep the launchd runner pointed at this build (paths change when the app moves), but only reload it
  // when its configuration changed and it isn't in the middle of a run (a reload would stop the run).
  const refreshRunner = () => {
    if (!runnerInstalled() || runnerUpToDate(process.execPath, runnerScript, appData) || local.lockHeldByOther()) return;
    installRunner(process.execPath, runnerScript, appData).catch((err) => console.warn(`[runner] refresh failed: ${(err as Error).message}`));
  };
  refreshRunner();

  // ---------- runs ----------
  const runDef = (projectId: unknown, runId: unknown): RunDefinition => {
    const project = deps.projectView(projectId);
    const id = v.shortId(runId, "run id");
    const def = store.listRuns(project.id).find((r) => r.id === id);
    if (!def) throw new Error("That run no longer exists.");
    return def;
  };

  ipcMain.handle(IPC.runsList, (_e, projectId: unknown) => {
    const project = deps.projectView(projectId);
    const definitions = store.listRuns(project.id);
    const approved = Object.fromEntries(definitions.map((d) => [d.id, local.isApproved(d)]));
    return { definitions, records: store.listRunRecords(project.id), approved };
  });
  ipcMain.handle(IPC.runsApprove, (_e, projectId: unknown, runId: unknown) => {
    const def = runDef(projectId, runId);
    local.approve(def);
    deps.send(IPC.evRunsChanged, def.projectId);
  });
  ipcMain.handle(IPC.runsSave, (_e, input: unknown) => {
    const raw = v.pick(input, ["id", "projectId", "name", "prompt", "schedule", "model", "permissionMode", "folder", "enabled"] as const);
    const project = deps.projectView(raw.projectId);
    const existing = raw.id === undefined ? undefined : runDef(project.id, raw.id);
    const folderChanged = (raw.folder || undefined) !== existing?.folder;
    if (folderChanged && raw.folder !== undefined && raw.folder !== "" && !v.isInProject(project, raw.folder, true)) {
      throw new Error("A run's folder must be inside one of the project's folders.");
    }
    const def: RunDefinition = {
      id: existing?.id ?? crypto.randomBytes(4).toString("hex"),
      projectId: project.id,
      name: v.name(raw.name, "Run name"),
      prompt: v.text(raw.prompt, "The run's instructions"),
      schedule: validateSchedule(raw.schedule as RunSchedule),
      model: v.model(raw.model),
      permissionMode: v.permissionMode(raw.permissionMode),
      folder: typeof raw.folder === "string" && raw.folder ? raw.folder : undefined,
      runOn: existing?.runOn ?? machineId,
      enabled: raw.enabled !== false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importedFrom: existing?.importedFrom,
    };
    store.saveRun(def);
    // Saved here, so it is approved to run here; any wait from before the edit no longer applies.
    local.approve(def);
    local.setRunState(def.id, { deferUntil: undefined });
    brainChanged(`${existing ? "update" : "add"} run ${def.name}`, project.id);
    return def;
  });
  ipcMain.handle(IPC.runsRemove, (_e, projectId: unknown, runId: unknown) => {
    const def = runDef(projectId, runId);
    store.deleteRun(def.projectId, def.id);
    brainChanged(`remove run ${def.name}`, def.projectId);
  });
  ipcMain.handle(IPC.runsRunNow, (_e, projectId: unknown, runId: unknown) => {
    const def = runDef(projectId, runId);
    if (isRunActive(store, def)) throw new Error(`"${def.name}" is already running.`);
    const folder = runFolder(def, store.getProject(def.projectId), machineId);
    // Started deliberately by the user, so the budget guard doesn't block it. Runs in the background.
    void executeRun({ ...tickCtx, env: deps.env() }, { ...def, folder }, { trigger: "manual" })
      .then(() => deps.send(IPC.evRunsChanged, def.projectId))
      .catch((err) => console.warn(`[runs] manual run failed: ${(err as Error).message}`));
  });
  ipcMain.handle(IPC.runsMarkRead, (_e, projectId: unknown, recordId: unknown) => {
    const project = deps.projectView(projectId);
    const id = v.shortId(recordId, "record id");
    if (!store.listRunRecords(project.id).some((r) => r.id === id)) throw new Error("That run record no longer exists.");
    store.appendRunRecord(project.id, { id, read: true });
    brainChanged("mark run read", project.id);
  });

  // ---------- memory ----------
  ipcMain.handle(IPC.memoryGet, (_e, projectId: unknown): MemoryState => {
    const project = deps.projectView(projectId);
    const brief = store.getBrief(project.id);
    const proposal = store.getBriefProposal(project.id);
    return {
      brief,
      proposal,
      briefChangedSinceProposal: Boolean(proposal?.baseHash && proposal.baseHash !== hashText(brief)),
      summaries: store.listSessionSummaries(project.id),
      claudeMemory: store.listClaudeMemory(project.id),
    };
  });
  ipcMain.handle(IPC.memoryAboutMe, (): MemoryNote[] => store.listClaudeMemory(ME_SCOPE));
  ipcMain.handle(IPC.memoryRemoveNote, (_e, scope: unknown, file: unknown) => {
    const target = scope === ME_SCOPE ? ME_SCOPE : deps.projectView(scope).id;
    if (typeof file !== "string") throw new Error("Invalid note.");
    store.deleteClaudeMemory(target, file);
    git.scheduleCommit(`remove memory note ${file}`);
    deps.send(IPC.evMemoryChanged, target);
  });

  // ---------- importing what Claude already has ----------
  const importPaths = defaultImportPaths(appData);
  ipcMain.handle(IPC.importScan, (): ImportScan => scanClaudeImports(importPaths, store, machineId));
  ipcMain.handle(IPC.importApply, (_e, selection: unknown): ImportResult => {
    const raw = v.pick(selection, ["memory", "runs"] as const);
    const list = (value: unknown) => (Array.isArray(value) ? value.map((x) => v.pick(x, ["key", "target"] as const) as { key: string; target: string }) : []);
    const { createdRuns, ...result } = applyClaudeImports(importPaths, store, machineId, { memory: list(raw.memory), runs: list(raw.runs) });
    // Imported here by the user, so they may run here; they arrive switched off.
    for (const def of createdRuns) local.approve(def);
    git.scheduleCommit(`import from Claude: ${result.notes} notes, ${result.runs} runs`);
    deps.send(IPC.evBrainChanged);
    for (const p of store.listProjects()) {
      deps.send(IPC.evMemoryChanged, p.id);
      deps.send(IPC.evRunsChanged, p.id);
    }
    deps.send(IPC.evMemoryChanged, ME_SCOPE);
    return result;
  });
  ipcMain.handle(IPC.memorySaveBrief, (_e, projectId: unknown, text: unknown) => {
    const project = deps.projectView(projectId);
    store.saveBrief(project.id, typeof text === "string" ? text.slice(0, BRIEF_MAX_CHARS) : "");
    git.scheduleCommit(`edit brief ${project.name}`);
    deps.send(IPC.evMemoryChanged, project.id);
  });
  ipcMain.handle(IPC.memoryAccept, (_e, projectId: unknown, text: unknown) => {
    const project = deps.projectView(projectId);
    const proposal = store.getBriefProposal(project.id);
    if (!proposal) throw new Error("There's no proposed update anymore.");
    store.saveBrief(project.id, (typeof text === "string" && text.trim() ? text : proposal.text).slice(0, BRIEF_MAX_CHARS));
    store.saveBriefProposal(project.id, undefined);
    git.scheduleCommit(`accept brief update ${project.name}`);
    deps.send(IPC.evMemoryChanged, project.id);
    deps.send(IPC.evBrainChanged);
  });
  ipcMain.handle(IPC.memoryDismiss, (_e, projectId: unknown) => {
    const project = deps.projectView(projectId);
    store.saveBriefProposal(project.id, undefined);
    git.scheduleCommit(`dismiss brief update ${project.name}`);
    deps.send(IPC.evMemoryChanged, project.id);
    deps.send(IPC.evBrainChanged);
  });
  ipcMain.handle(IPC.memorySummarize, (_e, projectId: unknown, sessionId: unknown, cwd: unknown) => {
    const project = deps.projectView(projectId);
    if (!v.isInProject(project, cwd, true)) throw new Error("That session isn't in this project's folders.");
    memory.enqueue({ projectId: project.id, sessionId: v.sessionId(sessionId), cwd, manual: true });
  });

  // ---------- settings ----------
  const runnerStatus = (): RunnerStatus => ({ installed: runnerInstalled(), lastTickAt: local.lastTickAt() });
  ipcMain.handle(IPC.settingsSave, (_e, input: unknown) => {
    const raw = v.pick(input, ["budget", "autoApplyBriefs", "enforcement", "ghost"] as const);
    const budget = v.pick(raw.budget, ["pauseAboveWeekPct", "pauseAboveFiveHourPct", "downgradeAboveWeekPct", "downgradeModel"] as const);
    if (budget.downgradeModel !== "sonnet" && budget.downgradeModel !== "haiku") throw new Error("The cheaper model must be Sonnet or Haiku.");
    const pause = percent(budget.pauseAboveWeekPct, "Pause threshold");
    const downgrade = percent(budget.downgradeAboveWeekPct, "Downgrade threshold");
    if (downgrade >= pause) throw new Error("Switch to the cheaper model below the pause threshold, or it never takes effect.");
    const settings: BrainSettings = {
      budget: {
        pauseAboveWeekPct: pause,
        pauseAboveFiveHourPct: percent(budget.pauseAboveFiveHourPct, "5-hour threshold"),
        downgradeAboveWeekPct: downgrade,
        downgradeModel: budget.downgradeModel,
      },
      autoApplyBriefs: raw.autoApplyBriefs === true,
      enforcement: enforcementSettings(raw.enforcement, store.getSettings().enforcement),
      ghost: ghostSettings(raw.ghost, store.getSettings().ghost),
    };
    const ghostWasOn = store.getSettings().ghost.enabled;
    store.saveSettings(settings);
    if (settings.ghost.enabled !== ghostWasOn) void ghost?.scan();
    else ghost?.recompute();
    git.scheduleCommit("update settings");
    deps.send(IPC.evBrainChanged);
  });
  ipcMain.handle(IPC.runnerStatus, runnerStatus);
  ipcMain.handle(IPC.runnerSet, async (_e, enabled: unknown) => {
    if (enabled === true) await installRunner(process.execPath, runnerScript, appData);
    else await uninstallRunner();
    return runnerStatus();
  });

  // ---------- search ----------
  let searchWorker: Worker | undefined;
  ipcMain.handle(IPC.search, (_e, query: unknown, projectId: unknown): Promise<SearchHit[]> => {
    const text = v.text(query, "Search");
    const scope = projectId === null || projectId === undefined ? deps.views().filter((p) => !p.archived) : [deps.projectView(projectId)];
    const workerData = {
      query: text,
      brainDir: store.dir,
      projects: scope.map((p) => ({ id: p.id, name: p.name, folders: p.localFolders.filter((f) => f.exists).map((f) => f.path) })),
    };
    // A new search replaces the previous one.
    void searchWorker?.terminate();
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "search-worker.js"), { workerData });
      searchWorker = worker;
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Search took too long."));
      }, SEARCH_TIMEOUT_MS);
      worker.once("message", (msg: { ok: boolean; hits?: SearchHit[]; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (msg.ok) resolve(msg.hits ?? []);
        else reject(new Error(msg.error));
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.once("exit", () => {
        clearTimeout(timer);
        if (searchWorker === worker) searchWorker = undefined;
        reject(new Error("Search was replaced by a newer one."));
      });
    });
  });

  return {
    stop: async () => {
      clearInterval(tickTimer);
      clearInterval(watchTimer);
      memory.stop(); // before sessions close, so quitting doesn't queue summaries
      ghostWiring.stop();
      void searchWorker?.terminate();
      await stopActiveRuns("Stopped because GhostOS quit.");
    },
  };
}

/** Extra BrainState fields for Phase 2. */
export function phase2State(store: BrainStore, projectIds: string[]) {
  const unreadRuns: Record<string, number> = {};
  const pendingBriefs: string[] = [];
  for (const id of projectIds) {
    const unread = store.listRunRecords(id).filter((r) => !r.read && r.status !== "running").length;
    if (unread) unreadRuns[id] = unread;
    if (store.getBriefProposal(id)) pendingBriefs.push(id);
  }
  return { settings: store.getSettings(), unreadRuns, pendingBriefs };
}
