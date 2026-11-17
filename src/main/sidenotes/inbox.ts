// The main-process side of sidenote delivery: writes notes into the hook's inbox, builds the
// --settings file that wires the hook into every GhostOS-launched Claude session, and reports
// deliveries the hook has logged.
import fs from "node:fs";
import path from "node:path";
import { DELIVERED_LOG, NOTE_SUFFIX, isSessionId, type InboxNote } from "../../shared/hook-protocol";

export interface Delivery {
  sessionId: string;
  noteId: string;
  event: string;
  at: string;
}

/** Quotes a value for /bin/sh so no character in it (", $, `, \) is interpreted. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Writes the Claude Code settings file that registers the sidenote hook for GhostOS sessions only. */
export function writeSessionSettings(settingsFile: string, nodeBinary: string, hookScript: string, inboxDir: string): void {
  const command = `ELECTRON_RUN_AS_NODE=1 ${[nodeBinary, hookScript, inboxDir].map(shellQuote).join(" ")}`;
  const hook = [{ hooks: [{ type: "command", command }] }];
  const settings = { hooks: { PostToolBatch: hook, Stop: hook, UserPromptSubmit: hook } };
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function requireSessionId(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error("Invalid session id.");
  return sessionId;
}

export class Inbox {
  /** bytes of delivered.jsonl already reported, per session */
  private readOffsets = new Map<string, number>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  enqueue(sessionId: string, note: InboxNote): void {
    const sessionDir = path.join(this.dir, requireSessionId(sessionId));
    fs.mkdirSync(sessionDir, { recursive: true });
    // Timestamp prefix keeps delivery in the order the notes were written.
    const file = path.join(sessionDir, `${Date.now()}-${note.id}${NOTE_SUFFIX}`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(note));
    fs.renameSync(tmp, file);
  }

  /** Removes a note that hasn't been delivered yet. Returns false if the hook already claimed it. */
  withdraw(sessionId: string, noteId: string): boolean {
    const sessionDir = path.join(this.dir, requireSessionId(sessionId));
    if (!fs.existsSync(sessionDir)) return false;
    const name = fs.readdirSync(sessionDir).find((f) => f.endsWith(`-${noteId}${NOTE_SUFFIX}`));
    if (!name) return false;
    try {
      fs.unlinkSync(path.join(sessionDir, name));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; // the hook claimed it in between
      throw err;
    }
  }

  /** Returns deliveries logged by the hook since the last call. Only complete lines are consumed. */
  collectDeliveries(): Delivery[] {
    const deliveries: Delivery[] = [];
    for (const sessionId of fs.readdirSync(this.dir)) {
      const log = path.join(this.dir, sessionId, DELIVERED_LOG);
      if (!fs.existsSync(log)) continue;
      const size = fs.statSync(log).size;
      const offset = this.readOffsets.get(sessionId) ?? 0;
      if (size <= offset) continue;
      const fd = fs.openSync(log, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const complete = text.lastIndexOf("\n") + 1; // a line still being written waits for the next poll
      this.readOffsets.set(sessionId, offset + Buffer.byteLength(text.slice(0, complete)));
      for (const line of text.slice(0, complete).split("\n")) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as { id: string; event: string; at: string };
          deliveries.push({ sessionId, noteId: d.id, event: d.event, at: d.at });
        } catch (err) {
          console.warn(`[inbox] bad delivery line for ${sessionId}: ${(err as Error).message}`);
        }
      }
    }
    return deliveries;
  }
}
