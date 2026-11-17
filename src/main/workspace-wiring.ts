// Phase 5 wiring: organizing a project's chats (folders, hiding, moving a transcript to the Trash), design systems
// linked to areas and projects, and pop-out viewer windows for outputs.
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IPC } from "../shared/api";
import type { ChatFolder, DesignSource, DesignSystem, DesignSystemView, ProjectOrganization, ProjectView } from "../shared/types";
import type { BrainGit } from "./brain/git";
import type { BrainStore, OrganizeChange } from "./brain/store";
import { claudeProjectsDir, locateSession } from "./claude/transcripts";
import { designSystemView } from "./design/design";
import { draftDesignGuide } from "./design/draft";
import type { SessionManager } from "./sessions/manager";
import { openViewer } from "./viewer/window";
import * as v from "./validate";

const FOLDER_ID_BYTES = 4;
/** A transcript written to more recently than this may belong to a session still running elsewhere. */
const RECENTLY_ACTIVE_MS = 60_000;
const ASSET_MAX_BYTES = 25 * 1024 * 1024;
const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
const GUIDE_MAX_CHARS = 100_000;
const DESIGN_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
const PREVIEW_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export interface WorkspaceDeps {
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
  window: () => BrowserWindow | undefined;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Folders whose files a viewer never shows (keys, credentials, app data), even if a chat wrote there. */
const PRIVATE_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".netrc", "Library"].map((d) => path.join(os.homedir(), d));
export function isPrivatePath(file: string): boolean {
  return PRIVATE_DIRS.some((d) => file === d || file.startsWith(d + path.sep));
}

/** The project folder (on this Mac) that contains `file`, as a design source; the deepest folder wins. */
export function sourceFor(views: ProjectView[], file: string): DesignSource | undefined {
  const target = real(file);
  let best: (DesignSource & { depth: number }) | undefined;
  for (const p of views) {
    for (const f of p.localFolders.filter((x) => x.exists)) {
      const root = real(f.path);
      if (!target.startsWith(root + path.sep)) continue;
      const depth = root.length;
      if (!best || depth > best.depth) best = { projectId: p.id, folderLabel: f.label, relPath: path.relative(root, target), depth };
    }
  }
  return best && { projectId: best.projectId, folderLabel: best.folderLabel, relPath: best.relPath };
}

export function setupWorkspace(deps: WorkspaceDeps): { stop: () => void } {
  const { store, git, sessions, machineId } = deps;
  const abort = new AbortController();
  const scratch = path.join(deps.appData, "viewer");

  const organizeChanged = (projectId: string, reason: string) => {
    git.scheduleCommit(reason);
    deps.send(IPC.evOrganizeChanged, projectId);
  };
  const designChanged = (reason: string) => {
    git.scheduleCommit(reason);
    deps.send(IPC.evDesignChanged);
    deps.send(IPC.evCapabilitiesChanged); // session context previews change too
  };
  const folderId = (value: unknown) => {
    if (typeof value !== "string" || !/^[a-f0-9]{8}$/.test(value)) throw new Error("Invalid folder.");
    return value;
  };
  const record = (projectId: unknown, changes: OrganizeChange[], reason: string) => {
    const project = deps.projectView(projectId);
    store.addOrganizationRecords(project.id, changes);
    organizeChanged(project.id, reason);
    return project.id;
  };
  const existingFolder = (projectId: unknown, id: unknown): ChatFolder => {
    const folder = store.getOrganization(deps.projectView(projectId).id).folders.find((f) => f.id === folderId(id));
    if (!folder) throw new Error("That folder no longer exists.");
    return folder;
  };

  // ---------- chat folders inside a project ----------
  ipcMain.handle(IPC.organizeGet, (_e, projectId: unknown): ProjectOrganization => store.getOrganization(deps.projectView(projectId).id));
  ipcMain.handle(IPC.organizeCreateFolder, (_e, projectId: unknown, name: unknown): ChatFolder => {
    const folder: ChatFolder = { id: crypto.randomBytes(FOLDER_ID_BYTES).toString("hex"), name: v.name(name, "Folder name").trim(), createdAt: new Date().toISOString() };
    record(projectId, [{ kind: "folder", folderId: folder.id, name: folder.name, createdAt: folder.createdAt }], `add chat folder ${folder.name}`);
    return folder;
  });
  ipcMain.handle(IPC.organizeRenameFolder, (_e, projectId: unknown, id: unknown, name: unknown) => {
    const folder = existingFolder(projectId, id);
    const next = v.name(name, "Folder name").trim();
    record(projectId, [{ kind: "folder", folderId: folder.id, name: next, createdAt: folder.createdAt }], `rename chat folder ${next}`);
  });
  ipcMain.handle(IPC.organizeDeleteFolder, (_e, projectId: unknown, id: unknown) => {
    const folder = existingFolder(projectId, id);
    // Its chats go back to the project's main list.
    record(projectId, [{ kind: "folder", folderId: folder.id, name: folder.name, deleted: true, createdAt: folder.createdAt }], "remove chat folder");
  });
  ipcMain.handle(IPC.organizePlace, (_e, projectId: unknown, sessionId: unknown, id: unknown) => {
    const sid = v.sessionId(sessionId);
    const target = id === null ? null : existingFolder(projectId, id).id;
    record(projectId, [{ kind: "place", sessionId: sid, folderId: target }], "move chat");
  });
  ipcMain.handle(IPC.organizeHide, (_e, projectId: unknown, sessionId: unknown, hidden: unknown) => {
    record(projectId, [{ kind: "hide", sessionId: v.sessionId(sessionId), hidden: hidden === true }], hidden === true ? "hide chat" : "show chat");
  });
  // Moves a chat's transcript (and its folder of tool output) to the macOS Trash, recoverable from there.
  // Never a chat open in a GhostOS tab, or one written to in the last minute (it may be open in VS Code or a terminal).
  ipcMain.handle(IPC.sessionTrash, async (_e, projectId: unknown, sessionId: unknown) => {
    const project = deps.projectView(projectId);
    const sid = v.sessionId(sessionId);
    if (sessions.isOpen(sid)) throw new Error("Close that chat's tab first.");
    const found = locateSession(sid, project.localFolders.filter((f) => f.exists).map((f) => f.path));
    if (!found) throw new Error("That chat's transcript isn't on this Mac.");
    const transcripts = fs.realpathSync(claudeProjectsDir());
    const file = fs.realpathSync(found.file);
    if (!file.startsWith(transcripts + path.sep) || path.basename(file) !== `${sid}.jsonl`) throw new Error("That isn't a Claude transcript.");
    if (Date.now() - fs.statSync(file).mtimeMs < RECENTLY_ACTIVE_MS) throw new Error("That chat was active in the last minute; it may be open elsewhere. Try again later.");
    await shell.trashItem(file);
    const sidecar = path.join(path.dirname(file), sid);
    if (fs.existsSync(sidecar) && fs.lstatSync(sidecar).isDirectory()) await shell.trashItem(sidecar);
    record(project.id, [{ kind: "place", sessionId: sid, folderId: null }, { kind: "hide", sessionId: sid, hidden: false }], "move chat to Trash");
  });

  // ---------- design systems ----------
  const designId = (value: unknown) => {
    if (typeof value !== "string" || !DESIGN_ID.test(value)) throw new Error("Invalid design system.");
    if (!store.listDesignSystems().some((d) => d.id === value)) throw new Error("That design system no longer exists.");
    return value;
  };
  const getDesign = (id: string): DesignSystem => store.listDesignSystems().find((d) => d.id === id)!;
  const view = (id: string): DesignSystemView => designSystemView(store, getDesign(id), machineId);

  ipcMain.handle(IPC.designList, (): DesignSystem[] => store.listDesignSystems());
  ipcMain.handle(IPC.designGet, (_e, id: unknown): DesignSystemView => view(designId(id)));
  ipcMain.handle(IPC.designCreate, (_e, name: unknown): DesignSystemView => {
    const ds = store.createDesignSystem(v.name(name, "Name"));
    designChanged(`add design system ${ds.name}`);
    return view(ds.id);
  });
  ipcMain.handle(IPC.designSave, (_e, id: unknown, patch: unknown): DesignSystemView => {
    const ds = getDesign(designId(id));
    const raw = v.pick(patch, ["name", "description", "areas", "projects"] as const);
    const areaIds = new Set(store.listAreas().map((a) => a.id));
    const projectIds = new Set(store.listProjects().map((p) => p.id));
    const ids = (value: unknown, known: Set<string>) => {
      if (!Array.isArray(value)) throw new Error("Invalid links.");
      return [...new Set(value.filter((x): x is string => typeof x === "string" && known.has(x)))];
    };
    const next: DesignSystem = {
      ...ds,
      name: raw.name === undefined ? ds.name : v.name(raw.name, "Name").trim(),
      description: raw.description === undefined ? ds.description : typeof raw.description === "string" ? raw.description.slice(0, 500) : undefined,
      areas: raw.areas === undefined ? ds.areas : ids(raw.areas, areaIds),
      projects: raw.projects === undefined ? ds.projects : ids(raw.projects, projectIds),
    };
    store.saveDesignSystem(next);
    designChanged(`update design system ${next.name}`);
    return view(next.id);
  });
  ipcMain.handle(IPC.designSaveGuide, (_e, id: unknown, text: unknown) => {
    const did = designId(id);
    if (typeof text !== "string" || text.length > GUIDE_MAX_CHARS) throw new Error("The guide is too long.");
    store.saveDesignGuide(did, text);
    designChanged(`edit design guide ${did}`);
  });
  ipcMain.handle(IPC.designAddAssets, async (_e, id: unknown): Promise<DesignSystemView> => {
    const did = designId(id);
    const win = deps.window();
    const picked = win
      ? await dialog.showOpenDialog(win, { title: "Add files to the design system", properties: ["openFile", "multiSelections"] })
      : await dialog.showOpenDialog({ title: "Add files to the design system", properties: ["openFile", "multiSelections"] });
    if (picked.canceled) return view(did);
    const files = picked.filePaths.filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
    const tooBig = files.filter((f) => fs.statSync(f).size > ASSET_MAX_BYTES);
    if (tooBig.length) throw new Error(`Too large to keep in the brain (over 25 MB): ${tooBig.map((f) => path.basename(f)).join(", ")}`);
    for (const f of files) store.addDesignAsset(did, f);
    designChanged(`add ${files.length} design asset(s)`);
    return view(did);
  });
  ipcMain.handle(IPC.designRemoveAsset, (_e, id: unknown, file: unknown) => {
    const did = designId(id);
    store.removeDesignAsset(did, String(file));
    designChanged("remove design asset");
  });
  ipcMain.handle(IPC.designAssetPreview, (_e, id: unknown, file: unknown): string | undefined => {
    const full = store.designAssetPath(designId(id), String(file));
    const type = PREVIEW_TYPES[path.extname(full).toLowerCase()];
    if (!type || !fs.existsSync(full) || fs.statSync(full).size > PREVIEW_MAX_BYTES) return undefined;
    return `data:${type};base64,${fs.readFileSync(full).toString("base64")}`;
  });
  ipcMain.handle(IPC.designOpenAsset, (_e, id: unknown, file: unknown) => openViewer(store.designAssetPath(designId(id), String(file)), scratch));
  ipcMain.handle(IPC.designAddSource, async (_e, id: unknown): Promise<DesignSystemView> => {
    const did = designId(id);
    const win = deps.window();
    const options = { title: "Choose a file in a project folder that defines the brand (theme, tokens, logo component)", properties: ["openFile" as const] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return view(did);
    const source = sourceFor(deps.views(), picked.filePaths[0]);
    if (!source) throw new Error("Pick a file inside one of your projects' folders, so the link works on the other Mac too.");
    const ds = getDesign(did);
    if (!ds.sources.some((s) => s.projectId === source.projectId && s.relPath === source.relPath)) ds.sources.push(source);
    store.saveDesignSystem(ds);
    designChanged("add design source");
    return view(did);
  });
  ipcMain.handle(IPC.designRemoveSource, (_e, id: unknown, index: unknown) => {
    const ds = getDesign(designId(id));
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= ds.sources.length) throw new Error("Invalid source.");
    ds.sources.splice(index, 1);
    store.saveDesignSystem(ds);
    designChanged("remove design source");
  });
  ipcMain.handle(IPC.designRemove, (_e, id: unknown) => {
    const did = designId(id);
    store.deleteDesignSystem(did);
    designChanged(`remove design system ${did}`);
  });
  ipcMain.handle(IPC.designReveal, (_e, id: unknown) => shell.showItemInFolder(store.designGuidePath(designId(id))));
  const drafting = new Set<string>();
  ipcMain.handle(IPC.designDraft, async (_e, id: unknown): Promise<string> => {
    const did = designId(id);
    if (drafting.has(did)) throw new Error("Claude is already drafting this guide.");
    drafting.add(did);
    try {
      return await draft(did);
    } finally {
      drafting.delete(did);
    }
  });
  const draft = async (did: string): Promise<string> => {
    const ds = view(did);
    // Folders of the linked projects, and of projects in linked areas, on this Mac.
    const linked = deps.views().filter((p) => ds.projects.includes(p.id) || ds.areas.includes(p.area));
    const folders = [...new Set(linked.flatMap((p) => p.localFolders.filter((f) => f.exists).map((f) => f.path)))];
    return draftDesignGuide({ ds, folders, claudeBinary: deps.claudeBinary, env: deps.env(), signal: abort.signal });
  };

  // ---------- pop-out viewers ----------
  ipcMain.handle(IPC.outputOpen, async (_e, projectId: unknown, file: unknown, sessionKey: unknown) => {
    const project = deps.projectView(projectId);
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Invalid file.");
    const resolved = path.resolve(file);
    // Only files in the project's folders, or ones an open session of it wrote successfully.
    const allowed =
      v.isInProject(project, resolved, true) ||
      (typeof sessionKey === "string" && sessions.get(sessionKey)?.projectId === project.id && sessions.wroteFile(sessionKey, resolved));
    if (!allowed) throw new Error("GhostOS only opens files in this project's folders or ones its chats wrote.");
    if (isPrivatePath(fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved)) throw new Error("GhostOS doesn't open files from private folders (keys, credentials, Library).");
    await openViewer(resolved, scratch);
  });

  // Leftover rendered pages from an earlier run.
  fs.rmSync(scratch, { recursive: true, force: true });
  return { stop: () => abort.abort() };
}
