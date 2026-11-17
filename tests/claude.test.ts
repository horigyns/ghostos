import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toChatEvents, summarizeToolInput } from "../src/main/claude/events";
import { encodeProjectDir, loadHistory, summarizeSession, userText } from "../src/main/claude/transcripts";
import { cleanEnv } from "../src/main/claude/env";

describe("stream-json events", () => {
  it("maps init, text, tool use, tool result, result and rate limits", () => {
    expect(toChatEvents({ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5" })).toEqual([
      { kind: "init", sessionId: "s1", model: "claude-haiku-5-5" },
    ]);
    const assistant = toChatEvents({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Reading it" },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/a.txt" } },
        ],
      },
    });
    expect(assistant).toEqual([
      { kind: "assistant-text", text: "Reading it" },
      { kind: "tool-use", id: "t1", name: "Read", summary: "/x/a.txt" },
    ]);
    expect(
      toChatEvents({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Alpha" }] } }),
    ).toEqual([{ kind: "tool-result", id: "t1", isError: false, preview: "Alpha" }]);
    expect(toChatEvents({ type: "result", subtype: "success", duration_ms: 1200 })[0]).toMatchObject({ kind: "turn-end", ok: true });
    expect(toChatEvents({ type: "result", subtype: "error_max_turns", is_error: true })[0]).toMatchObject({ ok: false });

    const usage = toChatEvents({
      type: "rate_limit_event",
      rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.35, resetsAt: 1 }, seven_day: { utilization: 0.43, resetsAt: 2 } } },
    })[0];
    expect(usage).toMatchObject({ kind: "usage", usage: { fiveHourPct: 35, sevenDayPct: 43, sevenDayResetsAt: 2 } });
  });

  it("prefers a tool's description, then its command or path", () => {
    expect(summarizeToolInput({ command: "ls", description: "List files" })).toBe("List files");
    expect(summarizeToolInput({ command: "npm test" })).toBe("npm test");
  });
});

describe("transcripts", () => {
  it("encodes folders the way Claude Code names its project folders", () => {
    expect(encodeProjectDir("/Users/me/Acme App/acme-app")).toBe("-Users-me-Acme-App-acme-app");
  });

  it("ignores injected context when finding what the user typed", () => {
    expect(userText({ content: [{ type: "text", text: "<ide_selection>x</ide_selection>" }, { type: "text", text: "Fix the bug" }] })).toBe(
      "Fix the bug",
    );
    expect(userText({ content: [{ type: "tool_result", content: "x" }] })).toBeUndefined();
  });

  it("titles a session from its AI title, else its first prompt, and replays history", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-transcript-"));
    const file = path.join(dir, "abc.jsonl");
    const lines = [
      { type: "user", cwd: "/p", message: { role: "user", content: [{ type: "text", text: "Summarize the paper" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/p/a.md" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "text" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Here is the summary." }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent chatter" }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(summarizeSession(file)).toMatchObject({ sessionId: "abc", title: "Summarize the paper", cwd: "/p" });
    fs.appendFileSync(file, JSON.stringify({ type: "ai-title", aiTitle: "Paper summary" }) + "\n");
    expect(summarizeSession(file)?.title).toBe("Paper summary");
    const history = loadHistory(file);
    expect(history.map((e) => e.kind)).toEqual(["user", "tool-use", "tool-result", "assistant-text"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("clean environment", () => {
  it("drops anything that would bypass the user's own subscription login", () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.CLAUDE_CODE_ENTRYPOINT = "desktop";
    process.env.ANTHROPIC_BASE_URL = "http://proxy";
    const env = cleanEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH).toContain(".local/bin");
    delete process.env.ANTHROPIC_API_KEY;
  });
});
