// "Your voice": the user's voice guide and writing samples (kept in the brain under me/), and drafting the guide
// from the samples. Every session gets the voice through the session context (capabilities/context.ts). Also the
// start screen's file picker.
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { IPC } from "../../shared/api";
import type { VoiceView } from "../../shared/types";
import type { BrainGit } from "../brain/git";
import type { BrainStore } from "../brain/store";
import * as v from "../validate";
import { draftVoiceGuide } from "./draft";

const run = promisify(execFile);
const GUIDE_MAX_CHARS = 60_000;
const SAMPLE_MAX_CHARS = 200_000;
const SAMPLE_FILE_MAX_BYTES = 20 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 30_000;
const PLAIN_TEXT = new Set([".md", ".markdown", ".txt"]);
/** Formats macOS's textutil turns into plain text (not HTML or web archives: converting those can load remote content). */
const CONVERTIBLE = new Set([".docx", ".doc", ".rtf", ".odt"]);

export interface VoiceDeps {
  store: BrainStore;
  git: BrainGit;
  appData: string;
  claudeBinary: string;
  env: () => NodeJS.ProcessEnv;
  window: () => BrowserWindow | null;
  send: (channel: string, ...args: unknown[]) => void;
}

/** A file's text: as is for markdown and text, through textutil for Word, RTF and the like. */
async function fileText(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (PLAIN_TEXT.has(ext)) return fs.readFileSync(file, "utf8");
  if (CONVERTIBLE.has(ext)) {
    const { stdout } = await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", file], { timeout: CONVERT_TIMEOUT_MS, maxBuffer: SAMPLE_FILE_MAX_BYTES });
    return stdout;
  }
  throw new Error(`${path.basename(file)}: use a Word, RTF, text or markdown file (for a PDF or Google Doc, paste the text instead).`);
}

export function setupVoice(deps: VoiceDeps): { stop: () => void } {
  const { store, git } = deps;
  const abort = new AbortController();
  let drafting = false;

  const view = (): VoiceView => ({
    guide: store.getVoiceGuide(),
    guidePath: store.voiceGuidePath(),
    samplesDir: store.writingSamplesDir(),
    samples: store.listWritingSamples(),
  });
  const changed = (reason: string) => {
    git.scheduleCommit(reason);
    deps.send(IPC.evCapabilitiesChanged); // session context previews change too
  };
  const addSample = (name: string, text: string): string => {
    const body = text.replace(/\r\n?/g, "\n").trim();
    if (!body) throw new Error(`${name} has no text.`);
    if (body.length > SAMPLE_MAX_CHARS) throw new Error(`${name} is too long for a sample (over ${SAMPLE_MAX_CHARS.toLocaleString()} characters).`);
    return store.addWritingSample(name, body);
  };

  ipcMain.handle(IPC.voiceGet, (): VoiceView => view());
  // Files to hand to Claude in a new chat (the start screen's "+ Add files"): only their paths go into the message.
  ipcMain.handle(IPC.filesPick, async (): Promise<string[]> => {
    const win = deps.window();
    const options = { title: "Add files to the chat", properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[] };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return picked.canceled ? [] : picked.filePaths;
  });
  ipcMain.handle(IPC.voiceSaveGuide, (_e, text: unknown): VoiceView => {
    if (typeof text !== "string" || text.length > GUIDE_MAX_CHARS) throw new Error("The guide is too long.");
    store.saveVoiceGuide(text);
    changed("edit voice guide");
    return view();
  });
  ipcMain.handle(IPC.voiceAddFiles, async (): Promise<VoiceView> => {
    const win = deps.window();
    const options = {
      title: "Add things you've written",
      properties: ["openFile", "multiSelections"] as ("openFile" | "multiSelections")[],
      filters: [{ name: "Writing", extensions: [...PLAIN_TEXT, ...CONVERTIBLE].map((e) => e.slice(1)) }],
    };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths.length) return view();
    const problems: string[] = [];
    let added = 0;
    for (const file of picked.filePaths) {
      try {
        if (!fs.statSync(file).isFile()) throw new Error(`${path.basename(file)} isn't a file.`);
        if (fs.statSync(file).size > SAMPLE_FILE_MAX_BYTES) throw new Error(`${path.basename(file)} is over 20 MB.`);
        const name = path.basename(file).replace(/\.[^.]+$/, PLAIN_TEXT.has(path.extname(file).toLowerCase()) ? path.extname(file) : ".md");
        addSample(name, await fileText(file));
        added++;
      } catch (err) {
        problems.push((err as Error).message);
      }
    }
    if (added) changed(`add ${added} writing sample(s)`);
    if (problems.length) throw new Error(`${added ? `Added ${added}. ` : ""}${problems.join(" ")}`);
    return view();
  });
  ipcMain.handle(IPC.voicePasteSample, (_e, name: unknown, text: unknown): VoiceView => {
    const title = v.name(name, "The sample's name");
    addSample(`${title}.md`, v.text(text, "The sample", SAMPLE_MAX_CHARS));
    changed("add writing sample");
    return view();
  });
  ipcMain.handle(IPC.voiceRemoveSample, (_e, file: unknown): VoiceView => {
    store.deleteWritingSample(String(file));
    changed(`remove writing sample ${String(file)}`);
    return view();
  });
  ipcMain.handle(IPC.voiceOpenSample, async (_e, file: unknown) => {
    // Only a regular .md or .txt file inside the samples folder (never a synced symlink), so this opens a text editor.
    const error = await shell.openPath(store.writingSamplePath(String(file)));
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC.voiceReveal, () => {
    const guide = store.voiceGuidePath();
    shell.showItemInFolder(fs.existsSync(guide) ? guide : path.dirname(guide));
  });
  ipcMain.handle(IPC.voiceDraft, async (): Promise<string> => {
    if (drafting) throw new Error("Claude is already drafting your voice guide.");
    drafting = true;
    try {
      const samples = store.listWritingSamples().map((s) => ({ file: s.file, content: store.readWritingSample(s.file) }));
      const jobs = path.join(deps.appData, "jobs");
      fs.mkdirSync(jobs, { recursive: true });
      return await draftVoiceGuide({
        samples,
        currentGuide: store.getVoiceGuide(),
        claudeBinary: deps.claudeBinary,
        env: deps.env(),
        cwd: jobs,
        signal: abort.signal,
      });
    } finally {
      drafting = false;
    }
  });

  return { stop: () => abort.abort() };
}
