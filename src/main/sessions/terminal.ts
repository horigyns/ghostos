// The terminal view of a session: Claude Code's own interactive interface in a pseudo-terminal,
// rendered by xterm.js in the renderer. Used as the fallback to the chat window.
import { EventEmitter } from "node:events";
import * as pty from "node-pty";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;
const KILL_GRACE_MS = 3_000;

export interface TerminalSessionOptions {
  claudeBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  settingsFile: string;
  sessionId: string;
  /** resume the existing session, or create it with this id */
  exists: boolean;
  model?: string;
  appendSystemPrompt?: string;
}

export interface TerminalEvents {
  data: [string];
  exit: [number];
}

export class TerminalSession extends EventEmitter<TerminalEvents> {
  private readonly term: pty.IPty;

  constructor(opts: TerminalSessionOptions) {
    super();
    const args = ["--settings", opts.settingsFile];
    if (opts.model) args.push("--model", opts.model);
    if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
    args.push(opts.exists ? "--resume" : "--session-id", opts.sessionId);
    this.term = pty.spawn(opts.claudeBinary, args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: opts.cwd,
      env: opts.env as Record<string, string>,
    });
    this.term.onData((data) => this.emit("data", data));
    this.term.onExit(({ exitCode }) => {
      this.exited = true;
      this.emit("exit", exitCode);
    });
  }

  private exited = false;

  write(data: string): void {
    this.term.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows);
  }

  /** Ends Claude Code's terminal UI and waits (briefly) for it to exit. */
  kill(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.term.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, KILL_GRACE_MS);
      this.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        this.term.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
