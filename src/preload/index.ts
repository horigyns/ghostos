// Exposes a narrow, typed API to the renderer. The renderer has no Node access of its own.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type GhostApi } from "../shared/api";

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const invoke = ipcRenderer.invoke.bind(ipcRenderer);

const api: GhostApi = {
  getState: () => invoke(IPC.getState),
  areas: {
    add: (name) => invoke(IPC.areaAdd, name),
    rename: (id, name) => invoke(IPC.areaRename, id, name),
    move: (id, direction) => invoke(IPC.areaMove, id, direction),
    remove: (id) => invoke(IPC.areaRemove, id),
  },
  projects: {
    create: (input) => invoke(IPC.projectCreate, input),
    update: (id, patch) => invoke(IPC.projectUpdate, id, patch),
    remove: (id) => invoke(IPC.projectDelete, id),
    addFolder: (id) => invoke(IPC.projectAddFolder, id),
    removeFolder: (id, folder) => invoke(IPC.projectRemoveFolder, id, folder),
  },
  sessions: {
    listPast: (projectId) => invoke(IPC.sessionsPast, projectId),
    live: () => invoke(IPC.sessionsLive),
    open: (req) => invoke(IPC.sessionOpen, req),
    history: (key) => invoke(IPC.sessionHistory, key),
    send: (key, text) => invoke(IPC.sessionSend, key, text),
    stop: (key) => invoke(IPC.sessionStop, key),
    close: (key) => invoke(IPC.sessionClose, key),
    setView: (key, view) => invoke(IPC.sessionSetView, key, view),
    writeTerminal: (key, data) => ipcRenderer.send(IPC.terminalWrite, key, data),
    resizeTerminal: (key, cols, rows) => ipcRenderer.send(IPC.terminalResize, key, cols, rows),
  },
  sidenotes: {
    list: (projectId) => invoke(IPC.sidenoteList, projectId),
    add: (req) => invoke(IPC.sidenoteAdd, req),
    send: (projectId, id) => invoke(IPC.sidenoteSend, projectId, id),
    withdraw: (projectId, id) => invoke(IPC.sidenoteWithdraw, projectId, id),
    promote: (projectId, id) => invoke(IPC.sidenotePromote, projectId, id),
  },
  runs: {
    list: (projectId) => invoke(IPC.runsList, projectId),
    save: (input) => invoke(IPC.runsSave, input),
    remove: (projectId, runId) => invoke(IPC.runsRemove, projectId, runId),
    runNow: (projectId, runId) => invoke(IPC.runsRunNow, projectId, runId),
    approve: (projectId, runId) => invoke(IPC.runsApprove, projectId, runId),
    markRead: (projectId, recordId) => invoke(IPC.runsMarkRead, projectId, recordId),
  },
  files: {
    pick: () => invoke(IPC.filesPick),
  },
  voice: {
    get: () => invoke(IPC.voiceGet),
    saveGuide: (text) => invoke(IPC.voiceSaveGuide, text),
    addFiles: () => invoke(IPC.voiceAddFiles),
    pasteSample: (name, text) => invoke(IPC.voicePasteSample, name, text),
    removeSample: (file) => invoke(IPC.voiceRemoveSample, file),
    openSample: (file) => invoke(IPC.voiceOpenSample, file),
    reveal: () => invoke(IPC.voiceReveal),
    draft: () => invoke(IPC.voiceDraft),
  },
  memory: {
    get: (projectId) => invoke(IPC.memoryGet, projectId),
    saveBrief: (projectId, text) => invoke(IPC.memorySaveBrief, projectId, text),
    acceptProposal: (projectId, text) => invoke(IPC.memoryAccept, projectId, text),
    dismissProposal: (projectId) => invoke(IPC.memoryDismiss, projectId),
    summarize: (projectId, sessionId, cwd) => invoke(IPC.memorySummarize, projectId, sessionId, cwd),
    aboutMe: () => invoke(IPC.memoryAboutMe),
    removeNote: (scope, file) => invoke(IPC.memoryRemoveNote, scope, file),
  },
  organize: {
    get: (projectId) => invoke(IPC.organizeGet, projectId),
    createFolder: (projectId, name) => invoke(IPC.organizeCreateFolder, projectId, name),
    renameFolder: (projectId, folderId, name) => invoke(IPC.organizeRenameFolder, projectId, folderId, name),
    deleteFolder: (projectId, folderId) => invoke(IPC.organizeDeleteFolder, projectId, folderId),
    place: (projectId, sessionId, folderId) => invoke(IPC.organizePlace, projectId, sessionId, folderId),
    hide: (projectId, sessionId, hidden) => invoke(IPC.organizeHide, projectId, sessionId, hidden),
    trash: (projectId, sessionId) => invoke(IPC.sessionTrash, projectId, sessionId),
  },
  design: {
    list: () => invoke(IPC.designList),
    get: (id) => invoke(IPC.designGet, id),
    create: (name) => invoke(IPC.designCreate, name),
    save: (id, patch) => invoke(IPC.designSave, id, patch),
    saveGuide: (id, text) => invoke(IPC.designSaveGuide, id, text),
    addAssets: (id) => invoke(IPC.designAddAssets, id),
    removeAsset: (id, file) => invoke(IPC.designRemoveAsset, id, file),
    assetPreview: (id, file) => invoke(IPC.designAssetPreview, id, file),
    openAsset: (id, file) => invoke(IPC.designOpenAsset, id, file),
    addSource: (id) => invoke(IPC.designAddSource, id),
    removeSource: (id, index) => invoke(IPC.designRemoveSource, id, index),
    remove: (id) => invoke(IPC.designRemove, id),
    reveal: (id) => invoke(IPC.designReveal, id),
    draft: (id) => invoke(IPC.designDraft, id),
  },
  outputs: {
    open: (projectId, file, sessionKey) => invoke(IPC.outputOpen, projectId, file, sessionKey),
  },
  ghost: {
    state: () => invoke(IPC.ghostState),
    scan: () => invoke(IPC.ghostScan),
    decide: (loopId, action) => invoke(IPC.ghostDecide, loopId, action),
    digest: () => invoke(IPC.ghostDigest),
  },
  importer: {
    scan: () => invoke(IPC.importScan),
    apply: (selection) => invoke(IPC.importApply, selection),
  },
  settings: {
    save: (settings) => invoke(IPC.settingsSave, settings),
    runnerStatus: () => invoke(IPC.runnerStatus),
    setRunner: (enabled) => invoke(IPC.runnerSet, enabled),
  },
  search: (query, projectId) => invoke(IPC.search, query, projectId),
  capabilities: {
    get: () => invoke(IPC.capabilitiesGet),
    saveRules: (scope, text) => invoke(IPC.rulesSave, scope, text),
    projectRules: (projectId) => invoke(IPC.projectRulesGet, projectId),
    previewContext: (projectId) => invoke(IPC.sessionContextPreview, projectId),
    saveAgent: (agent) => invoke(IPC.agentSave, agent),
    removeAgent: (scope, name) => invoke(IPC.agentRemove, scope, name),
    importAgent: (file, scope) => invoke(IPC.agentImport, file, scope),
    apply: () => invoke(IPC.capabilitiesApply),
    remove: () => invoke(IPC.capabilitiesRemove),
  },
  machine: {
    suggestFolders: (projectId) => invoke(IPC.projectSuggestFolders, projectId),
    linkFolder: (projectId, folderIndex, folder) => invoke(IPC.projectLinkFolder, projectId, folderIndex, folder),
    moveRunHere: (projectId, runId) => invoke(IPC.runsMoveHere, projectId, runId),
  },
  sync: {
    status: () => invoke(IPC.syncStatus),
    now: () => invoke(IPC.syncNow),
    connect: (url) => invoke(IPC.syncConnect, url),
    createGithub: (name) => invoke(IPC.syncCreateGithub, name),
  },
  ideas: {
    add: (text, projectId) => invoke(IPC.ideaAdd, text, projectId),
    update: (id, patch) => invoke(IPC.ideaUpdate, id, patch),
  },
  shell: {
    reveal: (folder) => invoke(IPC.shellReveal, folder),
    openInVSCode: (folder) => invoke(IPC.shellVSCode, folder),
  },
  on: {
    sessionEvent: (cb) => listen(IPC.evSessionEvent, cb),
    sessionState: (cb) => listen(IPC.evSessionState, cb),
    terminalData: (cb) => listen(IPC.evTerminalData, cb),
    sessionHistory: (cb) => listen(IPC.evSessionHistory, cb),
    usage: (cb) => listen(IPC.evUsage, cb),
    brainChanged: (cb) => listen(IPC.evBrainChanged, cb),
    sidenotesChanged: (cb) => listen(IPC.evSidenotesChanged, cb),
    runsChanged: (cb) => listen(IPC.evRunsChanged, cb),
    memoryChanged: (cb) => listen(IPC.evMemoryChanged, cb),
    memoryJob: (cb) => listen(IPC.evMemoryJob, cb),
    capabilitiesChanged: (cb) => listen(IPC.evCapabilitiesChanged, cb),
    syncChanged: (cb) => listen(IPC.evSyncChanged, cb),
    ghostChanged: (cb) => listen(IPC.evGhostChanged, cb),
    organizeChanged: (cb) => listen(IPC.evOrganizeChanged, cb),
    designChanged: (cb) => listen(IPC.evDesignChanged, cb),
    ghostOpen: (cb) => listen(IPC.evGhostOpen, cb),
  },
};

contextBridge.exposeInMainWorld("ghost", api);
