// Turns Claude Code's stream-json output lines into the ChatEvents the UI renders.
import type { ChatEvent } from "../../shared/types";

const SUMMARY_MAX_CHARS = 140;
const RESULT_PREVIEW_MAX_CHARS = 400;
const PERCENT = 100;
/** Keys worth showing for a tool call, in order of preference. */
const SUMMARY_KEYS = ["description", "command", "file_path", "path", "pattern", "url", "query", "prompt", "skill"];

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return clip(value, SUMMARY_MAX_CHARS);
  }
  return clip(JSON.stringify(record), SUMMARY_MAX_CHARS);
}

export function previewToolResult(content: unknown): string {
  if (typeof content === "string") return clip(content, RESULT_PREVIEW_MAX_CHARS);
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join(" ");
    return clip(text, RESULT_PREVIEW_MAX_CHARS);
  }
  return "";
}

/** Tools whose input names a file they create or change (its output can be opened). */
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The absolute file a file-writing tool touched, if any. */
export function toolFilePath(name: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(name) || !input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const p = i.file_path ?? i.notebook_path ?? i.path;
  return typeof p === "string" && p.startsWith("/") ? p : undefined;
}

/** Maps one parsed stream-json message to zero or more chat events. */
export function toChatEvents(msg: Record<string, unknown>): ChatEvent[] {
  const type = msg.type;
  const message = msg.message as { content?: unknown; model?: string } | undefined;

  if (type === "system" && msg.subtype === "init") {
    return [{ kind: "init", sessionId: String(msg.session_id ?? ""), model: msg.model as string | undefined }];
  }

  if (type === "assistant" && Array.isArray(message?.content)) {
    const events: ChatEvent[] = [];
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "text" && String(block.text ?? "").trim()) {
        events.push({ kind: "assistant-text", text: String(block.text) });
      } else if (block.type === "tool_use") {
        events.push({
          kind: "tool-use",
          id: String(block.id ?? ""),
          name: String(block.name ?? "tool"),
          summary: summarizeToolInput(block.input),
          filePath: toolFilePath(String(block.name ?? ""), block.input),
        });
      }
    }
    return events;
  }

  if (type === "user" && Array.isArray(message?.content)) {
    const events: ChatEvent[] = [];
    for (const block of message.content as Record<string, unknown>[]) {
      if (block.type === "tool_result") {
        events.push({
          kind: "tool-result",
          id: String(block.tool_use_id ?? ""),
          isError: Boolean(block.is_error),
          preview: previewToolResult(block.content),
        });
      }
    }
    return events;
  }

  if (type === "result") {
    const ok = msg.subtype === "success" && !msg.is_error;
    return [
      {
        kind: "turn-end",
        ok,
        error: ok ? undefined : String(msg.result ?? msg.subtype ?? "The turn ended with an error"),
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
        durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
      },
    ];
  }

  if (type === "rate_limit_event") {
    const windows = (msg.rate_limit_info as { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> })
      ?.unifiedWindows;
    if (!windows) return [];
    const pct = (w?: { utilization?: number }) =>
      typeof w?.utilization === "number" ? Math.round(w.utilization * PERCENT) : undefined;
    return [
      {
        kind: "usage",
        usage: {
          fiveHourPct: pct(windows.five_hour),
          fiveHourResetsAt: windows.five_hour?.resetsAt,
          sevenDayPct: pct(windows.seven_day),
          sevenDayResetsAt: windows.seven_day?.resetsAt,
          observedAt: Date.now(),
        },
      },
    ];
  }

  return [];
}
