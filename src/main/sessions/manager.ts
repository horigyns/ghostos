// Keeps track of the Claude sessions open in GhostOS. Each session has a chat process and,
// when the user flips to the terminal view, a pseudo-terminal running Claude Code's own UI.
// Only one of the two runs at a time, since both would write to the same session.
import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChatEvent, LiveSession, OpenSessionRequest, SessionView, UsageSnapshot } from "../../shared/types";
import { ChatSession } from "./chat";
import { TerminalSession } from "./terminal";
import { findTranscript, loadHistory } from "../claude/transcripts";

const TITLE_MAX_CHARS = 60;
const NEW_CHAT_TITLE = "New chat";

interface Entry {
  live: LiveSession;
  chat: ChatSession;
  term?: TerminalSession;
  /** set while switching between chat and terminal, so overlapping clicks can't start two processes */
  switching?: Promise<unknown>;
  /** at least one turn completed in GhostOS, so the session is worth summarizing when closed */
  hadTurn: boolean;
}

export interface SessionManagerOptions {
  claudeBinary: string;
  settingsFile: string;
  env: () => NodeJS.ProcessEnv;
  /** extra system prompt for a project's sessions (its brief) */
  systemPromptFor?: (projectId: string, cwd?: string) => string | undefined;
}

export interface SessionManagerEvents {
  event: [string, ChatEvent];
  state: [LiveSession];
  termData: [string, string];
  /** the chat view's history was replaced (e.g. after the terminal view exited) */
  history: [string, ChatEvent[]];
  usage: [UsageSnapshot];
  /** a session was closed; hadTurn says whether anything happened in it */
  closed: [LiveSession, boolean];
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: SessionManagerOptions) {
    super();
  }

  list(): LiveSession[] {
    return [...this.entries.values()].map((e) => e.live);
  }

  get(key: string): LiveSession | undefined {
    return this.entries.get(key)?.live;
  }

  /**
   * Opens a new session, or resumes an existing one. History is returned only for a session that
   * wasn't already open (an open session's live events are newer than its transcript).
   */
  open(req: OpenSessionRequest & { cwd: string }): { session: LiveSession; history?: ChatEvent[] } {
    const already = req.resumeSessionId
      ? [...this.entries.values()].find((e) => e.live.sessionId === req.resumeSessionId)
      : undefined;
    if (already) return { session: already.live };

    const key = crypto.randomUUID();
    const sessionId = req.resumeSessionId ?? crypto.randomUUID();
    const permissionMode = req.permissionMode ?? "auto";
    const live: LiveSession = {
      key,
      projectId: req.projectId,
      cwd: req.cwd,
      sessionId,
      title: req.title ?? NEW_CHAT_TITLE,
      view: "chat",
      busy: false,
      model: req.model,
      permissionMode,
    };
    const chat = new ChatSession({
      claudeBinary: this.opts.claudeBinary,
      cwd: req.cwd,
      env: this.opts.env(),
      settingsFile: this.opts.settingsFile,
      permissionMode,
      model: req.model,
      sessionId,
      sessionExists: () => Boolean(findTranscript(sessionId, [req.cwd])),
      appendSystemPrompt: () => this.opts.systemPromptFor?.(req.projectId, req.cwd),
    });
    const entry: Entry = { live, chat, hadTurn: false };
    this.entries.set(key, entry);

    chat.on("event", (event) => {
      if (event.kind === "user" && live.title === NEW_CHAT_TITLE) live.title = clip(event.text, TITLE_MAX_CHARS);
      if (event.kind === "init" && event.model) live.model = event.model;
      if (event.kind === "connectors") live.connectors = event.summary;
      if (event.kind === "usage") this.emit("usage", event.usage);
      if (event.kind === "turn-end" && event.ok) entry.hadTurn = true;
      this.noteWritten(key, event);
      live.busy = chat.busy;
      this.emit("event", key, event);
      this.emit("state", live);
    });
    // Start Claude Code now, so the claude.ai connectors are connected by the time the first message is sent.
    chat.warm();
    return { session: live, history: this.loadHistory(entry) };
  }

  /** History from Claude Code's transcript, for a renderer that lost its events (e.g. after a reload). */
  history(key: string): ChatEvent[] {
    return this.loadHistory(this.require(key));
  }

  async send(key: string, text: string): Promise<void> {
    const entry = this.require(key);
    if (entry.switching) throw new Error("Switching views; try again in a moment.");
    if (entry.term) throw new Error("This session is open in the terminal view. Switch back to chat to send from here.");
    if (entry.chat.busy) throw new Error("Claude is still working on the last message. Add a sidenote instead, or stop the turn.");
    entry.live.busy = true;
    this.emit("state", entry.live);
    await entry.chat.send(text);
  }

  async stop(key: string): Promise<void> {
    const entry = this.require(key);
    await entry.chat.stop();
    entry.live.busy = false;
    this.emit("state", entry.live);
    // Ready again for the next message, connectors included.
    if (!entry.term && this.entries.get(key) === entry) entry.chat.warm();
  }

  /** Switches between the chat window and Claude Code's terminal UI. Returns fresh history when returning to chat. */
  async setView(key: string, view: SessionView): Promise<ChatEvent[] | undefined> {
    const entry = this.require(key);
    if (entry.switching) throw new Error("Already switching views.");
    if (entry.live.view === view) return undefined;
    if (view === "terminal" && entry.chat.busy) {
      throw new Error("Wait for Claude to finish this turn (or stop it) before switching to the terminal.");
    }
    const switching = view === "terminal" ? this.toTerminal(key, entry) : this.toChat(entry);
    entry.switching = switching;
    try {
      return await switching;
    } finally {
      entry.switching = undefined;
    }
  }

  private async toTerminal(key: string, entry: Entry): Promise<undefined> {
    await entry.chat.stop();
    const term = new TerminalSession({
      claudeBinary: this.opts.claudeBinary,
      cwd: entry.live.cwd,
      env: this.opts.env(),
      settingsFile: this.opts.settingsFile,
      sessionId: entry.live.sessionId!,
      exists: entry.chat.created,
      model: entry.live.model,
      appendSystemPrompt: this.opts.systemPromptFor?.(entry.live.projectId, entry.live.cwd),
    });
    term.on("data", (data) => this.emit("termData", key, data));
    entry.hadTurn = true; // work in the terminal view isn't visible to GhostOS; assume it counts
    term.on("exit", () => {
      // The user quit Claude Code's UI (/exit) or it crashed: fall back to the chat view with fresh history.
      if (entry.term !== term) return;
      entry.term = undefined;
      entry.live.view = "chat";
      this.emit("state", entry.live);
      if (this.entries.get(key) === entry) entry.chat.warm();
      this.emit("history", key, this.loadHistory(entry));
    });
    entry.term = term;
    entry.live.view = "terminal";
    this.emit("state", entry.live);
    return undefined;
  }

  private async toChat(entry: Entry): Promise<ChatEvent[]> {
    const term = entry.term;
    entry.term = undefined; // detach first so its exit handler doesn't also switch views
    await term?.kill();
    entry.live.view = "chat";
    this.emit("state", entry.live);
    entry.chat.warm(); // connectors ready for the next message
    return this.loadHistory(entry);
  }

  writeTerminal(key: string, data: string): void {
    this.entries.get(key)?.term?.write(data);
  }

  resizeTerminal(key: string, cols: number, rows: number): void {
    this.entries.get(key)?.term?.resize(cols, rows);
  }

  async close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.written.delete(key);
    const term = entry.term;
    entry.term = undefined;
    await Promise.all([term?.kill(), entry.chat.stop()]);
    this.emit("closed", entry.live, entry.hadTurn);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((k) => this.close(k)));
  }

  anyBusy(): boolean {
    return [...this.entries.values()].some((e) => e.chat.busy || e.term);
  }

  private loadHistory(entry: Entry): ChatEvent[] {
    const file = findTranscript(entry.live.sessionId!, [entry.live.cwd]);
    const events = file ? loadHistory(file) : [];
    for (const e of events) this.noteWritten(entry.live.key, e);
    return events;
  }

  /** Files each open session wrote (Write/Edit/NotebookEdit), so only those (or project files) can be opened in a viewer. */
  private written = new Map<string, Set<string>>();

  /** tool-use id -> file, until its result says whether the write happened */
  private pendingWrites = new Map<string, string>();

  private noteWritten(key: string, event: ChatEvent): void {
    if (event.kind === "tool-use" && event.filePath) {
      this.pendingWrites.set(`${key}/${event.id}`, path.resolve(event.filePath));
      return;
    }
    if (event.kind !== "tool-result") return;
    const file = this.pendingWrites.get(`${key}/${event.id}`);
    if (!file) return;
    this.pendingWrites.delete(`${key}/${event.id}`);
    if (event.isError) return; // denied or failed: nothing was written
    let set = this.written.get(key);
    if (!set) this.written.set(key, (set = new Set()));
    set.add(file);
  }

  /** True when the open session `key` wrote or edited this file. */
  wroteFile(key: string, file: string): boolean {
    return this.written.get(key)?.has(file) ?? false;
  }

  /** The open session for a transcript, if any (a session open in a tab can't be deleted). */
  isOpen(sessionId: string): boolean {
    return [...this.entries.values()].some((e) => e.live.sessionId === sessionId);
  }

  private require(key: string): Entry {
    const entry = this.entries.get(key);
    if (!entry) throw new Error("That session is no longer open.");
    return entry;
  }
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
