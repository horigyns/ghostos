// GhostOS main process: sets up the brain, Claude sessions and sidenote delivery, then serves the
// renderer over IPC. Every value arriving from the renderer is validated (see validate.ts).
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { IPC, type BrainState } from "../shared/api";
import type { ProjectView, SessionView, SidenoteMode } from "../shared/types";
import { BrainStore } from "./brain/store";
import { BrainGit, remoteOf } from "./brain/git";
import { loadMachine } from "./brain/machine";
import { toView } from "./brain/view";
import { loadConfig } from "./config";
import { phase2State, setupPhase2 } from "./memory-and-runs";
import { setupPhase3 } from "./rules-and-sync";
import { setupWorkspace } from "./workspace-wiring";
import { setupVoice } from "./voice/wiring";
import { isRunActive } from "./runs/executor";
import { seedProjects } from "./brain/seed";
import { cleanEnv, findClaudeBinary } from "./claude/env";
import { listSessions, locateSession } from "./claude/transcripts";
import { SessionManager } from "./sessions/manager";
import { Inbox, writeSessionSettings } from "./sidenotes/inbox";
import { SidenoteService } from "./sidenotes/service";
import * as v from "./validate";

const DELIVERY_POLL_MS = 1_500;
const WINDOW_WIDTH = 1440;
const WINDOW_HEIGHT = 900;
const WINDOW_MIN_WIDTH = 1000;
/** the window controls, centered in the renderer's 44px top bar */
const TRAFFIC_LIGHTS = { x: 14, y: 16 };
const WINDOW_MIN_HEIGHT = 600;
const SIDENOTE_MODES: readonly SidenoteMode[] = ["now", "after", "later"];
const IDEA_STATUSES = ["open", "archived"] as const;

let mainWindow: BrowserWindow | undefined;

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

async function main(): Promise<void> {
  // One instance only: two would edit the same brain files and lose each other's changes.
  // Dev/test aid: a separate app-data folder (and so a separate instance lock) for screenshot runs.
  if (process.env.GHOSTOS_USER_DATA) app.setPath("userData", process.env.GHOSTOS_USER_DATA);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  await app.whenReady();
  const appData = app.getPath("userData");
  const config = loadConfig(appData);
  const machine = loadMachine(appData);

  const store = new BrainStore(config.brainDir);
  const isNewBrain = store.ensure();
  const git = new BrainGit(config.brainDir);
  await git.init();
  if (isNewBrain) {
    const count = await seedProjects(store, machine.id);
    git.scheduleCommit(`first run, ${count} projects`);
  }
  const changed = (reason: string) => {
    git.scheduleCommit(reason);
    send(IPC.evBrainChanged);
  };

  const inboxDir = path.join(appData, "inbox");
  const inbox = new Inbox(inboxDir);
  const settingsFile = path.join(appData, "claude-session-settings.json");
  const hookScript = path.join(app.getAppPath(), "dist", "hook", "sidenote-hook.js");
  writeSessionSettings(settingsFile, process.execPath, hookScript, inboxDir);
  const sidenotes = new SidenoteService(store, inbox);

  const claudeBinary = findClaudeBinary();
  // Marks GhostOS's own Claude processes, so the global hook doesn't add the context they already have.
  const sessionEnv = () => cleanEnv({ GHOSTOS_SESSION: "1" });
  let contextFor: (projectId: string, cwd?: string) => string | undefined = () => undefined;
  const sessions = new SessionManager({
    claudeBinary,
    settingsFile,
    env: sessionEnv,
    // Rules and brief for the project; filled in once Phase 3 wiring is set up below.
    systemPromptFor: (projectId, cwd) => contextFor(projectId, cwd),
  });
  sessions.on("event", (key, event) => send(IPC.evSessionEvent, key, event));
  sessions.on("state", (live) => send(IPC.evSessionState, live));
  sessions.on("termData", (key, data) => send(IPC.evTerminalData, key, data));
  sessions.on("history", (key, history) => send(IPC.evSessionHistory, key, history));
  sessions.on("usage", (usage) => send(IPC.evUsage, usage));

  const deliveryTimer = setInterval(() => {
    try {
      for (const projectId of sidenotes.applyDeliveries(inbox.collectDeliveries())) {
        git.scheduleCommit("sidenotes delivered");
        send(IPC.evSidenotesChanged, projectId);
      }
    } catch (err) {
      console.warn(`[sidenotes] delivery check failed: ${(err as Error).message}`);
    }
  }, DELIVERY_POLL_MS);

  const allViews = () => store.listProjects().map((p) => toView(p, machine.id));
  const projectView = (id: unknown): ProjectView => {
    const project = store.getProject(v.slugId(id, "project id"));
    if (!project) throw new Error("That project no longer exists.");
    return toView(project, machine.id);
  };
  const areaId = (id: unknown): string => {
    const checked = v.slugId(id, "area id");
    if (!store.listAreas().some((a) => a.id === checked)) throw new Error("That area no longer exists.");
    return checked;
  };

  // ---------- brain ----------
  ipcMain.handle(IPC.getState, (): BrainState => ({
    areas: store.listAreas(),
    projects: allViews(),
    ideas: store.listIdeas(),
    machineName: machine.name,
    brainDir: config.brainDir,
    warnings: store.warnings(),
    machineId: machine.id,
    ...phase2State(store, store.listActiveProjects().map((p) => p.id)),
  }));
  ipcMain.handle(IPC.areaAdd, (_e, areaName: unknown) => {
    const area = store.addArea(v.name(areaName, "Area name"));
    changed(`add area ${area.name}`);
    return area;
  });
  ipcMain.handle(IPC.areaRename, (_e, id: unknown, areaName: unknown) => {
    store.renameArea(areaId(id), v.name(areaName, "Area name"));
    changed(`rename area ${areaName}`);
  });
  ipcMain.handle(IPC.areaMove, (_e, id: unknown, direction: unknown) => {
    if (direction !== -1 && direction !== 1) throw new Error("Invalid direction.");
    store.moveArea(areaId(id), direction);
    changed("reorder areas");
  });
  ipcMain.handle(IPC.areaRemove, (_e, id: unknown) => {
    store.removeArea(areaId(id));
    changed(`remove area ${id}`);
  });
  ipcMain.handle(IPC.projectCreate, (_e, input: unknown) => {
    const { name: projectName, area } = v.pick(input, ["name", "area"] as const);
    const project = store.createProject({ name: v.name(projectName, "Project name"), area: areaId(area) });
    changed(`add project ${project.name}`);
    return project;
  });
  ipcMain.handle(IPC.projectUpdate, (_e, id: unknown, patch: unknown) => {
    const raw = v.pick(patch, ["name", "area", "description", "archived"] as const);
    const clean: { name?: string; area?: string; description?: string; archived?: boolean; archivedAt?: string } = {};
    if (raw.archived !== undefined) {
      if (typeof raw.archived !== "boolean") throw new Error("Invalid archive state.");
      clean.archived = raw.archived || undefined;
      clean.archivedAt = raw.archived ? new Date().toISOString() : undefined;
    }
    if (raw.name !== undefined) clean.name = v.name(raw.name, "Project name");
    if (raw.area !== undefined) clean.area = areaId(raw.area);
    if (raw.description !== undefined) clean.description = v.text(raw.description, "Description");
    const project = store.updateProject(projectView(id).id, clean);
    changed(raw.archived === undefined ? `update project ${project.name}` : `${raw.archived ? "archive" : "restore"} project ${project.name}`);
    return project;
  });
  // Only an archived project can be deleted (archive first, then delete from the Archived list).
  ipcMain.handle(IPC.projectDelete, (_e, id: unknown) => {
    const project = projectView(id);
    if (!project.archived) throw new Error("Archive the project first; only archived projects can be deleted.");
    if (sessions.list().some((s) => s.projectId === project.id)) throw new Error("Close the project's open chats first.");
    if (store.listRuns(project.id).some((r) => isRunActive(store, r))) throw new Error("One of the project's runs is still going; wait for it to finish.");
    store.deleteProject(project.id);
    changed(`delete project ${project.name}`);
  });
  ipcMain.handle(IPC.projectAddFolder, async (_e, id: unknown) => {
    const project = projectView(id);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: `Add a folder to ${project.name}`,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const folder = result.filePaths[0];
    const updated = store.addFolder(project.id, machine.id, folder, await remoteOf(folder));
    changed(`add folder to ${updated.name}`);
    return updated;
  });
  ipcMain.handle(IPC.projectRemoveFolder, (_e, id: unknown, folder: unknown) => {
    const project = projectView(id);
    if (!project.localFolders.some((f) => f.path === folder)) throw new Error("That folder isn't part of this project.");
    const updated = store.removeFolder(project.id, machine.id, folder as string);
    changed(`remove folder from ${updated.name}`);
    return updated;
  });

  // ---------- sessions ----------
  ipcMain.handle(IPC.sessionsPast, (_e, projectId: unknown) =>
    listSessions(projectView(projectId).localFolders.filter((f) => f.exists).map((f) => f.path)),
  );
  ipcMain.handle(IPC.sessionsLive, () => sessions.list());
  ipcMain.handle(IPC.sessionOpen, async (_e, req: unknown) => {
    const raw = v.pick(req, ["projectId", "cwd", "resumeSessionId", "title", "model", "permissionMode", "view"] as const);
    const project = projectView(raw.projectId);
    let cwd = raw.cwd;
    if (cwd === undefined && raw.resumeSessionId !== undefined) {
      // Opening a session from a run or search result: find the folder it ran in.
      const found = locateSession(v.sessionId(raw.resumeSessionId), project.localFolders.filter((f) => f.exists).map((f) => f.path));
      if (!found) throw new Error("That session's transcript isn't on this Mac.");
      cwd = found.cwd;
    }
    // Past sessions may have run in a subfolder of a project folder; new chats start in a project folder.
    if (!v.isInProject(project, cwd, true)) throw new Error("That folder isn't part of this project.");
    const opened = sessions.open({
      projectId: project.id,
      cwd,
      resumeSessionId: raw.resumeSessionId === undefined ? undefined : v.sessionId(raw.resumeSessionId),
      title: raw.title === undefined ? undefined : v.name(raw.title, "Title").slice(0, 200),
      model: v.model(raw.model),
      permissionMode: v.permissionMode(raw.permissionMode),
    });
    // A new coding session opens straight in Claude Code's terminal UI (never an existing chat). If that fails, the
    // session stays open in the chat view, so the window still gets its tab.
    if (raw.view === "terminal" && raw.resumeSessionId === undefined) {
      try {
        await sessions.setView(opened.session.key, "terminal");
      } catch (err) {
        console.warn(`[sessions] couldn't open the terminal view: ${(err as Error).message}`);
      }
    }
    return opened;
  });
  ipcMain.handle(IPC.sessionHistory, (_e, key: unknown) => sessions.history(String(key)));
  ipcMain.handle(IPC.sessionSend, (_e, key: unknown, message: unknown) => sessions.send(String(key), v.text(message, "Message")));
  ipcMain.handle(IPC.sessionStop, (_e, key: unknown) => sessions.stop(String(key)));
  ipcMain.handle(IPC.sessionClose, (_e, key: unknown) => sessions.close(String(key)));
  ipcMain.handle(IPC.sessionSetView, (_e, key: unknown, view: unknown) => {
    if (view !== "chat" && view !== "terminal") throw new Error("Unknown view.");
    return sessions.setView(String(key), view as SessionView);
  });
  ipcMain.on(IPC.terminalWrite, (_e, key: unknown, data: unknown) => {
    if (typeof data === "string") sessions.writeTerminal(String(key), data);
  });
  ipcMain.on(IPC.terminalResize, (_e, key: unknown, cols: unknown, rows: unknown) => {
    if (Number.isInteger(cols) && Number.isInteger(rows)) sessions.resizeTerminal(String(key), cols as number, rows as number);
  });

  // ---------- sidenotes and ideas ----------
  ipcMain.handle(IPC.sidenoteList, (_e, projectId: unknown) => store.listSidenotes(projectView(projectId).id));
  ipcMain.handle(IPC.sidenoteAdd, (_e, req: unknown) => {
    const raw = v.pick(req, ["projectId", "sessionKey", "text", "mode"] as const);
    const project = projectView(raw.projectId);
    const live = sessions.get(String(raw.sessionKey));
    if (!live?.sessionId || live.projectId !== project.id) throw new Error("Open a chat in this project first; sidenotes belong to a chat.");
    if (!SIDENOTE_MODES.includes(raw.mode as SidenoteMode)) throw new Error("Unknown sidenote mode.");
    const note = sidenotes.add({
      projectId: project.id,
      sessionId: live.sessionId,
      text: v.text(raw.text, "A sidenote"),
      mode: raw.mode as SidenoteMode,
    });
    git.scheduleCommit("add sidenote");
    send(IPC.evSidenotesChanged, project.id);
    return note;
  });
  ipcMain.handle(IPC.sidenoteSend, (_e, projectId: unknown, id: unknown) => {
    const project = projectView(projectId);
    const note = sidenotes.send(project.id, v.shortId(id, "sidenote id"));
    git.scheduleCommit("send sidenote");
    send(IPC.evSidenotesChanged, project.id);
    return note;
  });
  ipcMain.handle(IPC.sidenoteWithdraw, (_e, projectId: unknown, id: unknown) => {
    const project = projectView(projectId);
    const note = sidenotes.withdraw(project.id, v.shortId(id, "sidenote id"));
    git.scheduleCommit("withdraw sidenote");
    send(IPC.evSidenotesChanged, project.id);
    return note;
  });
  ipcMain.handle(IPC.sidenotePromote, (_e, projectId: unknown, id: unknown) => {
    const idea = sidenotes.promote(projectView(projectId).id, v.shortId(id, "sidenote id"));
    changed("sidenote to idea");
    return idea;
  });
  const ideaProject = (value: unknown): string | null => (value === null || value === "" ? null : projectView(value).id);
  ipcMain.handle(IPC.ideaAdd, (_e, ideaText: unknown, projectId: unknown) => {
    const idea = store.addIdea(v.text(ideaText, "An idea"), ideaProject(projectId));
    changed("add idea");
    return idea;
  });
  ipcMain.handle(IPC.ideaUpdate, (_e, id: unknown, patch: unknown) => {
    const raw = v.pick(patch, ["projectId", "text", "status"] as const);
    const clean: { projectId?: string | null; text?: string; status?: "open" | "archived" } = {};
    if (raw.projectId !== undefined) clean.projectId = ideaProject(raw.projectId);
    if (raw.text !== undefined) clean.text = v.text(raw.text, "An idea");
    if (raw.status !== undefined) {
      if (!IDEA_STATUSES.includes(raw.status as "open")) throw new Error("Unknown idea status.");
      clean.status = raw.status as "open" | "archived";
    }
    const idea = store.updateIdea(v.shortId(id, "idea id"), clean);
    changed("update idea");
    return idea;
  });

  // ---------- shell (only folders that belong to a project) ----------
  ipcMain.handle(IPC.shellReveal, async (_e, folder: unknown) => {
    const error = await shell.openPath(v.projectFolder(allViews(), folder));
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC.shellVSCode, (_e, folder: unknown) => {
    const checked = v.projectFolder(allViews(), folder);
    return new Promise<void>((resolve, reject) =>
      execFile("open", ["-a", "Visual Studio Code", checked], (err) => (err ? reject(new Error(err.message)) : resolve())),
    );
  });

  const phase2 = setupPhase2({
    store,
    git,
    sessions,
    machineId: machine.id,
    appData,
    claudeBinary,
    env: sessionEnv,
    views: allViews,
    projectView,
    send,
    focusWindow: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
  });

  const workspace = setupWorkspace({
    store,
    git,
    sessions,
    machineId: machine.id,
    appData,
    claudeBinary,
    env: sessionEnv,
    views: allViews,
    projectView,
    send,
    window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
  });

  const voice = setupVoice({
    store,
    git,
    appData,
    claudeBinary,
    env: sessionEnv,
    send,
    window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  });

  const phase3 = setupPhase3({ store, git, machineId: machine.id, appData, projectView, send });
  contextFor = phase3.systemPromptFor;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    title: "GhostOS",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: TRAFFIC_LIGHTS,
    backgroundColor: "#15161a",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links in chat open in the browser; the app window itself never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // Closing the window quits the app, which stops running Claude turns, so ask first.
  mainWindow.on("close", (event) => {
    if (process.env.GHOSTOS_CAPTURE || !sessions.anyBusy()) return;
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: "question",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      message: "Claude is still working in a session.",
      detail: "Quitting stops it. The session can be resumed later.",
    });
    if (choice === 1) event.preventDefault();
  });
  await mainWindow.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
  const capturePath = process.env.GHOSTOS_CAPTURE;
  if (capturePath) captureAndQuit(mainWindow, capturePath);

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(deliveryTimer);
    workspace.stop(); // stops a design draft in progress
    voice.stop(); // and a voice guide draft
    const phase3Stopped = phase3.stop(); // waits for a sync in progress
    const phase2Stopped = phase2.stop(); // stops summaries first, so closing sessions doesn't queue new ones
    void Promise.allSettled([phase3Stopped, phase2Stopped, sessions.closeAll()])
      .then(() => git.commitNow())
      .then(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
}

/**
 * Dev/test aid: GHOSTOS_CAPTURE=<file.png> npm start renders the window, prints any renderer
 * console errors, saves a screenshot of the window only, and quits.
 */
const CAPTURE_DELAY_MS = 3_000;
function captureAndQuit(win: BrowserWindow, file: string): void {
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") console.log(`[renderer ${event.level}] ${event.message}`);
  });
  setTimeout(async () => {
    // GHOSTOS_CAPTURE_CLICK="Runs" clicks the first button with that text before capturing (to check a tab or dialog);
    // "Rules & agents>Agents" clicks one after the other; "wait:20" waits 20 seconds (e.g. for Ghost's scan).
    for (const click of (process.env.GHOSTOS_CAPTURE_CLICK ?? "").split(">").filter(Boolean)) {
      const wait = /^wait:(\d+)$/.exec(click);
      if (wait) {
        await new Promise((r) => setTimeout(r, Number(wait[1]) * 1000));
        continue;
      }
      // "expand:<projectId>" expands a project in the sidebar (stored like a click would), then reloads the page.
      const expand = /^expand:([a-z0-9-]+)$/.exec(click);
      if (expand) {
        await win.webContents.executeJavaScript(`localStorage.setItem("ghostos.expandedProjects", ${JSON.stringify(JSON.stringify([expand[1]]))})`);
        win.webContents.reload();
        await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS));
        continue;
      }
      // "=Text" clicks the button whose text is exactly that.
      const exact = click.startsWith("=");
      const text = JSON.stringify(exact ? click.slice(1) : click);
      await win.webContents.executeJavaScript(
        `[...document.querySelectorAll("button")].reverse().find((b) => ${exact ? `b.textContent.trim() === ${text}` : `b.textContent.trim().startsWith(${text})`})?.click()`,
      );
      await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS / 2));
    }
    const image = await win.webContents.capturePage();
    fs.writeFileSync(file, image.toPNG());
    console.log(`[capture] saved ${file}`);
    app.quit();
  }, CAPTURE_DELAY_MS);
}

main().catch((err) => {
  console.error("GhostOS failed to start:", err);
  dialog.showErrorBox("GhostOS failed to start", String((err as Error)?.stack ?? err));
  app.exit(1);
});
