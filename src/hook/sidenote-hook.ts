// Claude Code hook that delivers GhostOS sidenotes into a running session.
// Claude Code runs it (via GhostOS's --settings file) as:  <electron as node> sidenote-hook.js <inboxDir>
//
//   PostToolBatch     -> delivers "now" notes as context next to the tool results (mid-turn, no interruption)
//   Stop              -> delivers any pending notes by continuing the turn once (decision: block)
//   UserPromptSubmit  -> delivers any pending notes alongside the user's next message
//
// Delivery is claim -> print -> record: a note is renamed to .claimed (an atomic claim, so two hooks
// never deliver the same note), printed for Claude, then logged to delivered.jsonl and removed. If the
// hook dies before recording, the stale claim is delivered again later rather than lost.
import fs from "node:fs";
import path from "node:path";
import {
  CLAIMED_SUFFIX,
  DELIVERED_LOG,
  NOTE_SUFFIX,
  STALE_CLAIM_MS,
  isSessionId,
  type InboxNote,
} from "../shared/hook-protocol";

/** Which pending notes a given hook event should deliver. */
export function selectNotes(event: string, notes: InboxNote[]): InboxNote[] {
  if (event === "PostToolBatch") return notes.filter((n) => n.mode === "now");
  if (event === "Stop" || event === "UserPromptSubmit") return notes;
  return [];
}

export function formatNotes(event: string, notes: InboxNote[]): string {
  const list = notes.map((n) => `- ${n.text}`).join("\n");
  const plural = notes.length > 1 ? "Sidenotes" : "A sidenote";
  if (event === "Stop") {
    return `${plural} the user added during this turn:\n${list}\nTake ${notes.length > 1 ? "them" : "it"} into account, then finish your reply.`;
  }
  return `${plural} the user added while you were working:\n${list}`;
}

/** Builds the JSON Claude Code expects on stdout for each event. */
export function hookOutput(event: string, notes: InboxNote[]): Record<string, unknown> {
  const text = formatNotes(event, notes);
  if (event === "Stop") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

interface PendingFile {
  file: string;
  note: InboxNote;
}

/** Queued notes plus claims abandoned by a hook that died, oldest first. */
export function readPending(sessionDir: string, now = Date.now()): PendingFile[] {
  if (!fs.existsSync(sessionDir)) return [];
  const pending: PendingFile[] = [];
  for (const name of fs.readdirSync(sessionDir).sort()) {
    const file = path.join(sessionDir, name);
    const queued = name.endsWith(NOTE_SUFFIX);
    const staleClaim = name.endsWith(CLAIMED_SUFFIX) && now - fs.statSync(file).mtimeMs > STALE_CLAIM_MS;
    if (!queued && !staleClaim) continue;
    try {
      pending.push({ file, note: JSON.parse(fs.readFileSync(file, "utf8")) as InboxNote });
    } catch {
      // A note still being written or just claimed by another hook; picked up on the next event.
    }
  }
  return pending;
}

/** Runs one hook invocation. `emit` prints the payload for Claude; delivery is recorded only after it succeeds. */
export function runHook(
  inboxDir: string,
  input: { hook_event_name?: string; session_id?: string },
  emit: (payload: Record<string, unknown>) => void = () => {},
): Record<string, unknown> | undefined {
  const event = input.hook_event_name ?? "";
  if (!isSessionId(input.session_id)) return undefined;
  const sessionDir = path.join(inboxDir, input.session_id);
  const pending = readPending(sessionDir);
  const chosen = new Set(selectNotes(event, pending.map((p) => p.note)).map((n) => n.id));

  const claimed: { file: string; note: InboxNote }[] = [];
  for (const p of pending.filter((p) => chosen.has(p.note.id))) {
    const claimFile = p.file.endsWith(CLAIMED_SUFFIX) ? p.file : p.file.slice(0, -NOTE_SUFFIX.length) + CLAIMED_SUFFIX;
    try {
      if (claimFile !== p.file) fs.renameSync(p.file, claimFile); // atomic claim
      fs.utimesSync(claimFile, new Date(), new Date());
      claimed.push({ file: claimFile, note: p.note });
    } catch {
      // another hook claimed (or the user withdrew) it first
    }
  }
  if (!claimed.length) return undefined;

  const payload = hookOutput(event, claimed.map((c) => c.note));
  emit(payload);
  const at = new Date().toISOString();
  fs.appendFileSync(
    path.join(sessionDir, DELIVERED_LOG),
    claimed.map((c) => JSON.stringify({ id: c.note.id, event, at })).join("\n") + "\n",
  );
  for (const c of claimed) fs.rmSync(c.file, { force: true });
  return payload;
}

function main(): void {
  const inboxDir = process.argv[2];
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      if (!inboxDir) return;
      runHook(inboxDir, raw.trim() ? JSON.parse(raw) : {}, (payload) => fs.writeSync(1, JSON.stringify(payload)));
    } catch (err) {
      // Never break the Claude session because of a sidenote problem; report on stderr only.
      process.stderr.write(`GhostOS sidenote hook: ${(err as Error).message}\n`);
    }
  });
}

if (require.main === module) main();
