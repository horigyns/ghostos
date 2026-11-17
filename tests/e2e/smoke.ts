// End-to-end smoke test against the real Claude Code CLI (uses a little of your subscription, on Haiku).
// Run with: npm run smoke
// Checks: a chat turn streams back; a "now" sidenote reaches Claude mid-turn and is marked delivered;
// the same process answers a follow-up (context kept); the terminal view starts and returning to chat
// replays history from Claude Code's transcript.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../src/main/sessions/manager";
import { Inbox, writeSessionSettings } from "../../src/main/sidenotes/inbox";
import { cleanEnv, findClaudeBinary } from "../../src/main/claude/env";
import type { ChatEvent } from "../../src/shared/types";

const TURN_TIMEOUT_MS = 180_000;
const TERMINAL_WAIT_MS = 15_000;
const POLL_MS = 250;
const UI_SETTLE_MS = 1_500;

// Bundled to dist/smoke/smoke.js, so the repo root is two levels up.
const root = path.resolve(__dirname, "..", "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-smoke-"));
const project = path.join(work, "project");
fs.mkdirSync(project);
for (const [name, text] of [["a.txt", "Alpha"], ["b.txt", "Bravo"], ["c.txt", "Charlie"]]) {
  fs.writeFileSync(path.join(project, name), `${text} file.\n`);
}
const inboxDir = path.join(work, "inbox");
const settingsFile = path.join(work, "settings.json");
writeSessionSettings(settingsFile, process.execPath, path.join(root, "dist", "hook", "sidenote-hook.js"), inboxDir);
const inbox = new Inbox(inboxDir);
const manager = new SessionManager({ claudeBinary: findClaudeBinary(), settingsFile, env: () => cleanEnv() });

const events: ChatEvent[] = [];
let termData = "";
manager.on("event", (_k, e) => {
  events.push(e);
  if (e.kind === "assistant-text") console.log(`  assistant: ${e.text.slice(0, 160).replace(/\n/g, " ")}`);
  if (e.kind === "tool-use") console.log(`  tool: ${e.name} ${e.summary}`);
  if (e.kind === "notice") console.log(`  notice: ${e.text}`);
});
manager.on("termData", (_k, d) => (termData += d));

function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, POLL_MS);
  });
}

const turns = () => events.filter((e) => e.kind === "turn-end").length;
const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};

async function main() {
  const { session } = manager.open({ projectId: "smoke", cwd: project, model: "haiku", permissionMode: "auto" });
  console.log(`session ${session.sessionId} in ${project}`);

  manager.send(
    session.key,
    "Read a.txt. When that finishes, read b.txt as a separate step, then c.txt as a third separate step. Never read two at once. " +
      "Then reply with one line per file, then list any extra information you received while working.",
  );
  inbox.enqueue(session.sessionId!, { id: "note-1", text: "The project codename is MANGO-42. Mention it in your reply.", mode: "now" });
  await waitFor(() => turns() >= 1, TURN_TIMEOUT_MS, "first turn");
  const reply1 = events.filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text).join("\n");
  check("first turn streams text and tool calls", events.some((e) => e.kind === "tool-use") && reply1.length > 0);
  check("'now' sidenote reached Claude mid-turn", /MANGO-42/.test(reply1));
  check("hook recorded the delivery", inbox.collectDeliveries().some((d) => d.noteId === "note-1"));
  check("usage limits arrived from the stream", events.some((e) => e.kind === "usage"));

  const before = events.length;
  manager.send(session.key, "What was the project codename? Reply with just the codename.");
  await waitFor(() => turns() >= 2, TURN_TIMEOUT_MS, "second turn");
  const reply2 = events.slice(before).filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text).join(" ");
  check("same process keeps context across turns", /MANGO-42/.test(reply2));

  await manager.setView(session.key, "terminal");
  await waitFor(() => termData.length > 200, TERMINAL_WAIT_MS, "terminal output").catch(() => undefined);
  check("terminal view starts Claude Code's interface", termData.length > 200);
  const history = (await manager.setView(session.key, "chat")) ?? [];
  check("returning to chat replays history from the transcript", history.some((e) => e.kind === "user" && /codename/.test(e.text)));

  // The chat must resume the session (not try to create it again) after the terminal view.
  await manager.send(session.key, "Reply with just the word RESUMED.");
  await waitFor(() => turns() >= 3, TURN_TIMEOUT_MS, "third turn");
  const third = events.filter((e) => e.kind === "turn-end").at(-1) as { ok: boolean } | undefined;
  check("chat resumes the session after the terminal view", Boolean(third?.ok));

  // Quitting Claude Code's own UI with /exit must hand the session back to the chat view.
  let historyEvents = 0;
  manager.on("history", () => historyEvents++);
  termData = "";
  await manager.setView(session.key, "terminal");
  // Wait for Claude Code's input prompt, then type like a person: the command, a pause, Enter.
  await waitFor(() => termData.includes("❯"), TERMINAL_WAIT_MS, "terminal prompt").catch(() => undefined);
  await new Promise((r) => setTimeout(r, UI_SETTLE_MS));
  manager.writeTerminal(session.key, "/exit");
  await new Promise((r) => setTimeout(r, UI_SETTLE_MS));
  manager.writeTerminal(session.key, "\r");
  await waitFor(() => manager.get(session.key)?.view === "chat", TERMINAL_WAIT_MS, "terminal exit").catch(() => undefined);
  check("/exit in the terminal returns to chat with fresh history", manager.get(session.key)?.view === "chat" && historyEvents > 0);
  await manager.send(session.key, "Reply with just the word AGAIN.");
  await waitFor(() => turns() >= 4, TURN_TIMEOUT_MS, "fourth turn");
  const fourth = events.filter((e) => e.kind === "turn-end").at(-1) as { ok: boolean } | undefined;
  check("chat works again after the terminal exited on its own", Boolean(fourth?.ok));

  await manager.closeAll();
}

main()
  .catch((err) => {
    console.error(err);
    results.push(["no errors", false]);
  })
  .finally(() => {
    fs.rmSync(work, { recursive: true, force: true });
    const failed = results.filter(([, ok]) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
