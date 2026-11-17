// Phase 3 wiring: layered rules and agents (applied to ~/.claude only when the user presses Apply),
// finding project folders on another Mac, moving scheduled runs between Macs, and brain sync.
import { app, ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC, type CapabilitiesState, type ImportableAgent } from "../shared/api";
import type { AgentDoc, ProjectView } from "../shared/types";
import type { BrainStore } from "./brain/store";
import type { BrainGit } from "./brain/git";
import { suggestFolders } from "./brain/locate";
import { BrainSync } from "./brain/sync";
import { CapabilityInstaller } from "./capabilities/install";
import { buildSessionContext } from "./capabilities/context";
import { readLoopsCache } from "./ghost/cache";
import * as v from "./validate";

const SYNC_INTERVAL_MS = 5 * 60_000;
const SYNC_AFTER_COMMIT_MS = 20_000;
const QUIT_SYNC_WAIT_MS = 20_000;
const RULES_MAX_CHARS = 20_000;
const AGENT_MAX_CHARS = 40_000;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SYNC_URL = /^(https:\/\/|git@|ssh:\/\/)[^\s]+$/;

export interface Phase3Deps {
  store: BrainStore;
  git: BrainGit;
  machineId: string;
  appData: string;
  projectView: (id: unknown) => ProjectView;
  send: (channel: string, ...args: unknown[]) => void;
}

const claudeDir = () => path.join(os.homedir(), ".claude");

/** Agents the user can bring into the brain: personal ones in ~/.claude/agents and each project's .claude/agents. */
function importableAgents(store: BrainStore, views: ProjectView[], owned: Set<string>): ImportableAgent[] {
  const out: ImportableAgent[] = [];
  const inBrain = new Set(store.listAgents().map((a) => a.content.trim()));
  const add = (dir: string, source: string) => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const full = path.join(dir, file);
      if (owned.has(full)) continue;
      // Hide files already in the brain (same text); same-named agents with other text stay importable.
      if (inBrain.has(fs.readFileSync(full, "utf8").trim())) continue;
      out.push({ path: full, name: file.slice(0, -3), source });
    }
  };
  add(path.join(claudeDir(), "agents"), "Your personal agents (~/.claude/agents)");
  for (const p of views) for (const f of p.localFolders.filter((x) => x.exists)) add(path.join(f.path, ".claude", "agents"), `${p.name} (${f.label})`);
  return out;
}

export function setupPhase3(deps: Phase3Deps): { stop: () => Promise<void>; systemPromptFor: (projectId: string, cwd?: string) => string | undefined } {
  const { store, git, machineId, appData } = deps;
  const installer = new CapabilityInstaller({
    claudeDir: claudeDir(),
    appData,
    nodeBinary: process.execPath,
    hookScript: path.join(app.getAppPath(), "dist", "hook", "ghostos-hook.js"),
  });
  const areaNames = () => Object.fromEntries(store.listAreas().map((a) => [a.id, a.name]));
  const views = () => store.listProjects().map((p) => deps.projectView(p.id));
  const changed = (reason: string) => {
    git.scheduleCommit(reason);
    deps.send(IPC.evBrainChanged);
    deps.send(IPC.evCapabilitiesChanged);
  };
  // Keep an applied setup current. Agent files follow edits made here; agents that arrive by sync are
  // only written when the user presses Update (they can carry tools and hooks into every Claude session).
  const refresh = (agents: boolean) => {
    try {
      if (installer.refresh(store.listAgents(), areaNames(), { agents })) deps.send(IPC.evCapabilitiesChanged);
    } catch (err) {
      console.warn(`[capabilities] refresh failed: ${(err as Error).message}`);
    }
  };
  const refreshInstall = () => refresh(true);
  const refreshHooks = () => refresh(false);
  refreshHooks();

  // ---------- rules and agents ----------
  ipcMain.handle(IPC.capabilitiesGet, (): CapabilitiesState => {
    const plan = installer.plan(store.listAgents(), areaNames());
    const owned = new Set(plan.files.filter((f) => f.state === "same").map((f) => f.path));
    return {
      globalRules: store.getRules(),
      areaRules: Object.fromEntries(store.listAreas().map((a) => [a.id, store.getRules({ area: a.id })])),
      agents: store.listAgents(),
      plan,
      importable: importableAgents(store, views(), owned),
    };
  });
  ipcMain.handle(IPC.rulesSave, (_e, scope: unknown, text: unknown) => {
    const raw = v.pick(scope, ["area", "projectId"] as const);
    if (typeof text !== "string") throw new Error("Rules must be text.");
    if (text.length > RULES_MAX_CHARS) throw new Error(`Rules can be up to ${RULES_MAX_CHARS.toLocaleString()} characters.`);
    const body = text;
    if (raw.projectId !== undefined) store.saveRules({ projectId: deps.projectView(raw.projectId).id }, body);
    else if (raw.area !== undefined) {
      const area = v.slugId(raw.area, "area id");
      if (!store.listAreas().some((a) => a.id === area)) throw new Error("That area no longer exists.");
      store.saveRules({ area }, body);
    } else store.saveRules({}, body);
    changed("edit rules");
  });
  ipcMain.handle(IPC.projectRulesGet, (_e, projectId: unknown) => store.getRules({ projectId: deps.projectView(projectId).id }));
  ipcMain.handle(IPC.sessionContextPreview, (_e, projectId: unknown) => {
    const view = deps.projectView(projectId);
    const project = store.getProject(view.id)!;
    return buildSessionContext(store, project, { folders: view.primaryPath ? [view.primaryPath] : [], loops: readLoopsCache(appData, project.id), machineId }) ?? "";
  });
  ipcMain.handle(IPC.agentSave, (_e, agent: unknown) => {
    const raw = v.pick(agent, ["name", "scope", "content"] as const);
    const saved = store.saveAgent({
      name: v.slugId(raw.name, "agent name"),
      scope: raw.scope === "global" ? "global" : v.slugId(raw.scope, "agent scope"),
      content: v.text(raw.content, "The agent", AGENT_MAX_CHARS),
    });
    changed(`save agent ${saved.name}`);
    refreshInstall();
    return saved;
  });
  ipcMain.handle(IPC.agentRemove, (_e, scope: unknown, name: unknown) => {
    store.deleteAgent(scope === "global" ? "global" : v.slugId(scope, "agent scope"), v.slugId(name, "agent name"));
    changed("remove agent");
    refreshInstall();
  });
  ipcMain.handle(IPC.agentImport, (_e, file: unknown, scope: unknown) => {
    // Only files offered by importableAgents (personal or project agent folders) can be imported.
    const allowed = importableAgents(store, views(), new Set()).find((a) => a.path === file);
    if (!allowed) throw new Error("That agent file can't be imported.");
    const doc: AgentDoc = {
      name: v.slugId(allowed.name.toLowerCase(), "agent name"),
      scope: scope === "global" ? "global" : v.slugId(scope, "agent scope"),
      content: fs.readFileSync(allowed.path, "utf8").slice(0, AGENT_MAX_CHARS),
    };
    store.saveAgent(doc);
    changed(`import agent ${doc.name}`);
    return doc;
  });
  ipcMain.handle(IPC.capabilitiesApply, () => {
    const plan = installer.apply(store.listAgents(), areaNames());
    deps.send(IPC.evCapabilitiesChanged);
    return plan;
  });
  ipcMain.handle(IPC.capabilitiesRemove, () => {
    installer.remove();
    deps.send(IPC.evCapabilitiesChanged);
  });

  // ---------- another Mac: find folders, take over runs ----------
  ipcMain.handle(IPC.projectSuggestFolders, async (_e, projectId: unknown) => {
    const project = store.getProject(deps.projectView(projectId).id)!;
    return suggestFolders(project, machineId);
  });
  ipcMain.handle(IPC.projectLinkFolder, (_e, projectId: unknown, folderIndex: unknown, folder: unknown) => {
    const project = store.getProject(deps.projectView(projectId).id)!;
    if (!Number.isInteger(folderIndex) || !project.folders[folderIndex as number]) throw new Error("Unknown folder.");
    if (typeof folder !== "string" || !path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      throw new Error("That folder doesn't exist.");
    }
    const real = fs.realpathSync(folder);
    const folders = project.folders.map((f, i) => (i === folderIndex ? { ...f, paths: { ...f.paths, [machineId]: real } } : f));
    store.updateProject(project.id, { folders });
    changed(`link folder for ${project.name} on this Mac`);
  });
  ipcMain.handle(IPC.runsMoveHere, (_e, projectId: unknown, runId: unknown) => {
    const project = deps.projectView(projectId);
    const def = store.listRuns(project.id).find((r) => r.id === v.shortId(runId, "run id"));
    if (!def) throw new Error("That run no longer exists.");
    // Not approved here: the user reviews it and presses "Approve to run on this Mac" like any synced run.
    const moved = { ...def, runOn: machineId, updatedAt: new Date().toISOString() };
    store.saveRun(moved);
    changed(`move run ${def.name} to this Mac`);
    deps.send(IPC.evRunsChanged, project.id);
  });

  // ---------- brain sync ----------
  const sync = new BrainSync(store.dir, git);
  try {
    sync.ensureAttributes();
  } catch (err) {
    console.warn(`[sync] couldn't write .gitattributes: ${(err as Error).message}`);
  }
  const runSync = async () => {
    try {
      if (!(await sync.remote())) return sync.status();
      const after = await sync.sync();
      deps.send(IPC.evSyncChanged, after);
      deps.send(IPC.evBrainChanged); // pulled changes may have arrived
      deps.send(IPC.evCapabilitiesChanged);
      refreshHooks(); // agents that arrive by sync wait for the user to press Update
      return after;
    } catch (err) {
      console.warn(`[sync] ${(err as Error).message}`);
      return sync.status();
    }
  };
  let afterCommit: NodeJS.Timeout | undefined;
  git.onCommitted(() => {
    clearTimeout(afterCommit);
    afterCommit = setTimeout(() => void runSync(), SYNC_AFTER_COMMIT_MS);
  });
  const syncTimer = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
  void runSync();

  ipcMain.handle(IPC.syncStatus, () => sync.status());
  ipcMain.handle(IPC.syncNow, () => runSync());
  ipcMain.handle(IPC.syncConnect, async (_e, url: unknown) => {
    if (typeof url !== "string" || !SYNC_URL.test(url.trim())) throw new Error("Use an https:// or git@ repository URL.");
    const status = await sync.connect(url.trim());
    deps.send(IPC.evSyncChanged, status);
    return status;
  });
  ipcMain.handle(IPC.syncCreateGithub, async (_e, name: unknown) => {
    if (typeof name !== "string" || !REPO_NAME.test(name)) throw new Error("Repository names start with a letter or digit and use letters, digits, dots, dashes and underscores.");
    await git.commitNow();
    const status = await sync.createGithubRepo(name);
    deps.send(IPC.evSyncChanged, status);
    return status;
  });

  return {
    /** Stops the timers and waits (briefly) for a sync in progress, so quitting never cuts off a rebase. */
    stop: async () => {
      clearInterval(syncTimer);
      clearTimeout(afterCommit);
      await Promise.race([sync.settle(), new Promise((r) => setTimeout(r, QUIT_SYNC_WAIT_MS))]);
    },
    systemPromptFor: (projectId: string, cwd?: string) => {
      const project = store.getProject(projectId);
      return project ? buildSessionContext(store, project, { folders: cwd ? [cwd] : [], loops: readLoopsCache(appData, project.id), machineId }) : undefined;
    },
  };
}
