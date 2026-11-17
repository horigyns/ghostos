// A Claude Code session driven through the CLI's stream-json mode: GhostOS writes user messages as
// JSON lines to stdin and renders the JSON events Claude Code prints. One process lives for the
// whole conversation; after a stop or crash the next message starts a new process that resumes it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { ChatEvent, ConnectorSummary, PermissionMode } from "../../shared/types";
import { toChatEvents } from "../claude/events";

const STOP_GRACE_MS = 3_000;
/** How often a new process is asked which MCP servers have connected, before its first message. */
const CONNECTOR_POLL_MS = 400;
/** The longest a first message waits for claude.ai connectors. They connect in the background, and a turn that
 * starts before them never sees their tools (Notion, Vercel, Supabase…), unlike the Claude app. */
const CONNECTOR_WAIT_MAX_MS = 8_000;
/** If no claude.ai connector has been listed by then, the account has none: stop waiting for them. */
const CONNECTOR_LIST_GRACE_MS = 3_000;
/** A process started ahead of a message (when a chat is opened) ends if nothing is sent within this time. */
const WARM_IDLE_MS = 10 * 60_000;
const CLAUDE_AI_PREFIX = "claude.ai ";
const STATUS_REQUEST_PREFIX = "ghostos-mcp-";
/** Set once any process lists claude.ai connectors: from then on an empty list means "not loaded yet", not "none". */
let accountHasClaudeAiConnectors = false;
/** CLI warnings that don't mean anything to the user. */
const IGNORED_STDERR = [/no stdin data received/i];

export interface ChatSessionOptions {
  claudeBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  settingsFile: string;
  permissionMode: PermissionMode;
  model?: string;
  /** the Claude session id; GhostOS picks it for new sessions so sidenotes can target it at once */
  sessionId: string;
  /** whether Claude Code has this session on disk (checked again before every start) */
  sessionExists: () => boolean;
  /** extra system prompt (the project brief), read fresh at every start */
  appendSystemPrompt?: () => string | undefined;
}

export interface ChatSessionEvents {
  event: [ChatEvent];
}

interface McpServerStatus {
  name: string;
  status: string;
}

/** A readable name for an MCP server: "claude.ai Notion" → "Notion", "plugin:sales:gmail" → "gmail". */
export function connectorName(server: string): string {
  if (server.startsWith(CLAUDE_AI_PREFIX)) return server.slice(CLAUDE_AI_PREFIX.length);
  const plugin = /^plugin:[^:]+:(.+)$/.exec(server);
  return plugin ? plugin[1] : server;
}

/** Groups MCP server statuses by what they mean for the user. */
export function summarizeConnectors(servers: McpServerStatus[]): ConnectorSummary {
  const group = (statuses: string[]) => [...new Set(servers.filter((s) => statuses.includes(s.status)).map((s) => connectorName(s.name)))].sort();
  return { connected: group(["connected"]), needsAuth: group(["needs-auth"]), failed: group(["failed"]), pending: group(["pending"]) };
}

/** Whether a fresh process's claude.ai connectors are settled (connected, failed or waiting for sign-in). */
export function connectorsSettled(servers: McpServerStatus[], elapsedMs: number, hasConnectors = accountHasClaudeAiConnectors): boolean {
  const claudeAi = servers.filter((s) => s.name.startsWith(CLAUDE_AI_PREFIX));
  if (claudeAi.length) accountHasClaudeAiConnectors = true;
  // An account known to have them waits for the list (up to the deadline); one without stops after a short grace.
  if (!claudeAi.length) return !hasConnectors && elapsedMs >= CONNECTOR_LIST_GRACE_MS;
  return !claudeAi.some((s) => s.status === "pending");
}

export class ChatSession extends EventEmitter<ChatSessionEvents> {
  private proc: ChildProcessWithoutNullStreams | undefined;
  /** resolves when the current process's connectors are ready (or waiting longer isn't worth it) */
  private ready: Promise<void> = Promise.resolve();
  private settleReady: (() => void) | undefined;
  private statusSeq = 0;
  private startedAt = 0;
  private sentThisProcess = false;
  /** the latest MCP status of the current process, while waiting for its connectors */
  private lastServers: McpServerStatus[] | undefined;
  private stopping: Promise<void> | undefined;
  /** set once Claude Code has confirmed the session (init event) */
  private confirmed = false;
  readonly sessionId: string;
  busy = false;

  constructor(private readonly opts: ChatSessionOptions) {
    super();
    this.sessionId = opts.sessionId;
  }

  /** Whether Claude Code has this session on disk, so it must be resumed rather than created. */
  get created(): boolean {
    return this.confirmed || this.opts.sessionExists();
  }

  get running(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && this.proc.signalCode === null);
  }

  private start(): ChildProcessWithoutNullStreams {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", this.opts.permissionMode,
      "--settings", this.opts.settingsFile,
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    const extra = this.opts.appendSystemPrompt?.();
    if (extra) args.push("--append-system-prompt", extra);
    args.push(this.created ? "--resume" : "--session-id", this.sessionId);

    // detached: Claude and the tools it starts get their own process group, so stop() can end them all.
    const proc = spawn(this.opts.claudeBinary, args, { cwd: this.opts.cwd, env: this.opts.env, stdio: "pipe", detached: true });
    this.proc = proc;
    this.startedAt = Date.now();
    this.sentThisProcess = false;
    this.watchConnectors(proc);

    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.handleLine(line));
    readline.createInterface({ input: proc.stderr }).on("line", (line) => {
      if (line.trim() && !IGNORED_STDERR.some((re) => re.test(line))) this.emit("event", { kind: "notice", text: line });
    });
    // A write to a process that just died must not crash the app.
    proc.stdin.on("error", (err) => console.warn(`[chat] stdin closed: ${err.message}`));
    proc.on("error", (err) => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.settleReady?.();
      }
      this.busy = false;
      this.emit("event", { kind: "notice", text: `Could not start Claude Code: ${err.message}` });
      this.emit("event", { kind: "turn-end", ok: false, error: "Claude Code did not start." });
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.settleReady?.();
      }
      const wasBusy = this.busy;
      this.busy = false;
      this.emit("event", { kind: "exit", code });
      if (wasBusy && !this.stopping) {
        this.emit("event", { kind: "turn-end", ok: false, error: `Claude Code exited unexpectedly (${signal ?? `code ${code}`}).` });
      }
    });
    return proc;
  }

  private handleLine(line: string): void {
    if (!line.startsWith("{")) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[chat] unparseable stream line: ${(err as Error).message}`);
      return;
    }
    if (msg.type === "control_response") {
      this.handleControlResponse(msg);
      return;
    }
    for (const event of toChatEvents(msg)) {
      // Claude Code saves a session once a message is in it; a process started ahead of one hasn't created it.
      if (event.kind === "init" && this.sentThisProcess) this.confirmed = true;
      if (event.kind === "turn-end") this.busy = false;
      this.emit("event", event);
    }
  }

  /**
   * Asks a new process which MCP servers have connected, until the claude.ai connectors settle; the first message
   * waits for that. Nothing is sent to the model, so this uses no usage.
   */
  private watchConnectors(proc: ChildProcessWithoutNullStreams): void {
    this.settleReady?.(); // a previous process's waiter
    let settled = false;
    let poll: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let idle: NodeJS.Timeout | undefined;
    this.ready = new Promise<void>((resolve) => {
      this.settleReady = () => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(deadline);
        this.settleReady = undefined;
        resolve();
      };
    });
    const ask = () => {
      if (this.proc !== proc || !this.running) return;
      const request = { type: "control_request", request_id: `${STATUS_REQUEST_PREFIX}${++this.statusSeq}`, request: { subtype: "mcp_status" } };
      proc.stdin.write(JSON.stringify(request) + "\n");
    };
    poll = setInterval(ask, CONNECTOR_POLL_MS);
    this.lastServers = undefined;
    deadline = setTimeout(() => {
      // Some connectors are slow: go ahead with what has connected, and still show it.
      if (this.lastServers && this.proc === proc) this.emit("event", { kind: "connectors", summary: summarizeConnectors(this.lastServers) });
      this.settleReady?.();
    }, CONNECTOR_WAIT_MAX_MS);
    // A process started only to have connectors ready ends if no message comes.
    idle = setTimeout(() => {
      if (this.proc === proc && !this.sentThisProcess) void this.stop();
    }, WARM_IDLE_MS);
    proc.once("exit", () => clearTimeout(idle));
    ask();
  }

  private handleControlResponse(msg: Record<string, unknown>): void {
    const response = msg.response as { subtype?: string; request_id?: string; response?: { mcpServers?: unknown } } | undefined;
    if (!response?.request_id?.startsWith(STATUS_REQUEST_PREFIX)) return;
    if (response.subtype !== "success" || !Array.isArray(response.response?.mcpServers)) {
      this.settleReady?.(); // this Claude Code can't report status; don't hold messages for it
      return;
    }
    const servers = (response.response.mcpServers as Record<string, unknown>[])
      .filter((s) => typeof s.name === "string" && typeof s.status === "string")
      .map((s) => ({ name: s.name as string, status: s.status as string }));
    if (!this.settleReady) return; // already settled: a late answer
    this.lastServers = servers;
    if (connectorsSettled(servers, Date.now() - this.startedAt)) {
      this.emit("event", { kind: "connectors", summary: summarizeConnectors(servers) });
      this.settleReady();
    }
  }

  /** Starts the process ahead of the first message, so its connectors are ready when the user sends. */
  warm(): void {
    if (!this.running && !this.stopping) this.start();
  }

  /** Sends a user message; starts (or restarts, resuming) the Claude Code process if needed. */
  async send(text: string): Promise<void> {
    if (this.stopping) await this.stopping;
    const proc = this.running ? this.proc! : this.start();
    this.busy = true;
    this.sentThisProcess = true;
    this.emit("event", { kind: "user", text });
    await this.ready;
    // Stopped or crashed while waiting: the exit handler already ended the turn.
    if (this.proc !== proc || !this.running) return;
    proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  }

  /** Stops the current turn by ending the process (and its tools); the next send resumes the session. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const proc = this.proc;
    if (!proc || !this.running) return Promise.resolve();
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid!, signal);
      } catch {
        proc.kill(signal); // group already gone; signal the process itself
      }
    };
    this.stopping = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signalGroup("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      signalGroup("SIGINT");
    }).finally(() => {
      this.stopping = undefined;
      this.busy = false;
    });
    return this.stopping;
  }
}
