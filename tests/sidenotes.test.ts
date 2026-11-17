import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatNotes, hookOutput, runHook, selectNotes } from "../src/hook/sidenote-hook";
import type { InboxNote } from "../src/shared/hook-protocol";
import { Inbox, shellQuote, writeSessionSettings } from "../src/main/sidenotes/inbox";
import { SidenoteService } from "../src/main/sidenotes/service";
import { BrainStore } from "../src/main/brain/store";

const SESSION = "6e455a43-6e11-4dff-804d-aea4d2c9f60b";
const now: InboxNote = { id: "n1", text: "the codename is MANGO-42", mode: "now" };
const after: InboxNote = { id: "n2", text: "also count the words", mode: "after" };

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-notes-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("hook note selection", () => {
  it("delivers only 'now' notes mid-turn, everything at turn end or with the next prompt", () => {
    expect(selectNotes("PostToolBatch", [now, after])).toEqual([now]);
    expect(selectNotes("Stop", [now, after])).toEqual([now, after]);
    expect(selectNotes("UserPromptSubmit", [now, after])).toEqual([now, after]);
    expect(selectNotes("SessionStart", [now, after])).toEqual([]);
  });

  it("produces the JSON shapes Claude Code expects", () => {
    expect(hookOutput("Stop", [after])).toEqual({ decision: "block", reason: formatNotes("Stop", [after]) });
    expect(hookOutput("PostToolBatch", [now])).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: formatNotes("PostToolBatch", [now]) },
    });
  });
});

describe("inbox + hook round trip", () => {
  it("delivers each note exactly once and records the delivery", () => {
    const inbox = new Inbox(tmp);
    inbox.enqueue(SESSION, now);
    inbox.enqueue(SESSION, after);

    const mid = runHook(tmp, { hook_event_name: "PostToolBatch", session_id: SESSION });
    expect(JSON.stringify(mid)).toContain("MANGO-42");
    expect(JSON.stringify(mid)).not.toContain("count the words");

    const end = runHook(tmp, { hook_event_name: "Stop", session_id: SESSION });
    expect(end).toMatchObject({ decision: "block" });
    expect(JSON.stringify(end)).toContain("count the words");

    // Nothing left: the continued turn can stop normally (no loop).
    expect(runHook(tmp, { hook_event_name: "Stop", session_id: SESSION })).toBeUndefined();
    expect(inbox.collectDeliveries().map((d) => d.noteId)).toEqual(["n1", "n2"]);
    expect(inbox.collectDeliveries()).toEqual([]); // already reported
  });

  it("ignores sessions without an inbox and suspicious session ids", () => {
    expect(runHook(tmp, { hook_event_name: "Stop", session_id: SESSION })).toBeUndefined();
    expect(runHook(tmp, { hook_event_name: "Stop", session_id: "../../etc" })).toBeUndefined();
  });

  it("lets a queued note be withdrawn before delivery", () => {
    const inbox = new Inbox(tmp);
    inbox.enqueue(SESSION, after);
    expect(inbox.withdraw(SESSION, "n2")).toBe(true);
    expect(runHook(tmp, { hook_event_name: "Stop", session_id: SESSION })).toBeUndefined();
  });

  it("writes a settings file that registers the hook for the three events", () => {
    const file = path.join(tmp, "settings.json");
    writeSessionSettings(file, "/Applications/GhostOS.app/Contents/MacOS/GhostOS", "/x/hook.js", "/x/inbox dir");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolBatch", "Stop", "UserPromptSubmit"]);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("'/x/inbox dir'");
  });

  it("quotes paths so the shell never expands them", () => {
    expect(shellQuote(`/a/it's "$HOME" \`x\``)).toBe(`'/a/it'\\''s "$HOME" \`x\`'`);
  });

  it("re-delivers a note whose hook died after claiming it, instead of losing it", () => {
    const inbox = new Inbox(tmp);
    inbox.enqueue(SESSION, now);
    const sessionDir = path.join(tmp, SESSION);
    // Simulate a hook that claimed the note and was killed before recording it.
    const queued = fs.readdirSync(sessionDir).find((f) => f.endsWith(".json"))!;
    const claim = path.join(sessionDir, queued.replace(/\.json$/, ".claimed"));
    fs.renameSync(path.join(sessionDir, queued), claim);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(claim, old, old);
    expect(JSON.stringify(runHook(tmp, { hook_event_name: "PostToolBatch", session_id: SESSION }))).toContain("MANGO-42");
    expect(fs.readdirSync(sessionDir).filter((f) => f.endsWith(".claimed"))).toEqual([]);
  });

  it("refuses session ids that would escape the inbox", () => {
    expect(() => new Inbox(tmp).enqueue("../../etc", now)).toThrow();
  });
});

describe("sidenote service", () => {
  it("saves 'later' notes, sends them on request, and marks deliveries", () => {
    const store = new BrainStore(path.join(tmp, "brain"));
    store.ensure();
    const project = store.createProject({ name: "Persona study", area: "research" });
    const inbox = new Inbox(path.join(tmp, "inbox"));
    const service = new SidenoteService(store, inbox);

    const saved = service.add({ projectId: project.id, sessionId: SESSION, text: "revisit judge prompt", mode: "later" });
    expect(saved.status).toBe("saved");
    expect(runHook(path.join(tmp, "inbox"), { hook_event_name: "Stop", session_id: SESSION })).toBeUndefined();

    expect(service.send(project.id, saved.id).status).toBe("queued");
    runHook(path.join(tmp, "inbox"), { hook_event_name: "UserPromptSubmit", session_id: SESSION });
    const changed = service.applyDeliveries(inbox.collectDeliveries());
    expect([...changed]).toEqual([project.id]);
    expect(store.listSidenotes(project.id)[0].status).toBe("delivered");

    expect(service.promote(project.id, saved.id)).toMatchObject({ text: "revisit judge prompt", projectId: project.id });
  });
});
