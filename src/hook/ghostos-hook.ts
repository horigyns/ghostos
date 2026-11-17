// GhostOS's global Claude Code hook, installed into ~/.claude/settings.json by "Apply" in GhostOS, so it
// runs in every Claude Code session (terminal, VS Code, desktop app). It only acts inside folders that
// belong to a GhostOS project, and never breaks a session: any problem exits quietly.
//
//   SessionStart        -> the project's rules (global, area, project), area agents and brief as context
//   PreToolUse (Bash)   -> before `git commit`: require (or remind about) a code review since the last commit
//   Stop                -> after 5+ files changed: remind once to run the documenter agent
//   PostToolUseFailure  -> a failed shell command in a project with docs/error-log: remind once to check it
//
// Run as:  <electron as node> ghostos-hook.js <GhostOS app-data folder>
import fs from "node:fs";
import path from "node:path";
import { BrainStore } from "../main/brain/store";
import { buildSessionContext, buildUserContext, projectForFolder } from "../main/capabilities/context";
import { readLoopsCache } from "../main/ghost/cache";

const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
export const DOCUMENTER_FILE_THRESHOLD = 5;
/** Words that can come before the real command in a shell segment (`sudo git commit`, `env X=1 git commit`). */
const COMMAND_PREFIXES = new Set(["command", "sudo", "env", "time", "nohup", "exec", "builtin"]);
/** git global options that take a separate value (`git -C dir commit`). */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const REVIEW_AGENT = /review/i;
const DOCS_AGENT = /document/i;
const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { command?: string };
  stop_hook_active?: boolean;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** undefined until a result is seen */
  isError?: boolean;
}

/** Removes heredoc bodies (`<<EOF … EOF`), which are data, not commands. */
function withoutHeredocs(command: string): string {
  const out: string[] = [];
  let until: string | undefined;
  for (const line of command.split("\n")) {
    if (until !== undefined) {
      if (line.trim() === until) until = undefined;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([\w.-]+)\1/.exec(line);
    if (m) until = m[2];
  }
  return out.join("\n");
}

/** Splits a shell command into simple commands (at unquoted ; & | && || newlines and parentheses), each as words. */
export function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const text = withoutHeredocs(command);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (c === "#" && !inWord) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++; // comment
    } else if (";&|\n(){}`".includes(c)) {
      endSegment();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

/** True when the command runs `git commit` (not a dry run) in any of its simple commands. */
export function isCommitCommand(command: string): boolean {
  return shellSegments(command).some((words) => {
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || COMMAND_PREFIXES.has(words[i]))) i++;
    if (path.basename(words[i] ?? "") !== "git") return false;
    i++;
    while (i < words.length && words[i].startsWith("-")) i += GIT_OPTIONS_WITH_VALUE.has(words[i]) ? 2 : 1;
    return words[i] === "commit" && !words.slice(i + 1).includes("--dry-run");
  });
}

/** Main-thread tool calls from a transcript, in order, with whether each one failed. */
export function readToolUses(transcriptPath: string): ToolUse[] {
  return readTranscript(transcriptPath).uses;
}

/** Like readToolUses; `truncated` says the transcript was longer than the part read. */
export function readTranscript(transcriptPath: string): { uses: ToolUse[]; truncated: boolean } {
  if (!fs.existsSync(transcriptPath)) return { uses: [], truncated: false };
  const size = fs.statSync(transcriptPath).size;
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(transcriptPath, "r");
  try {
    fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    fs.closeSync(fd);
  }
  const uses: ToolUse[] = [];
  const byId = new Map<string, ToolUse>();
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.startsWith("{") || !line.includes("tool_")) continue;
    let entry: { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    for (const block of entry.message!.content as Record<string, unknown>[]) {
      if (entry.type === "assistant" && block.type === "tool_use") {
        const use: ToolUse = { id: String(block.id ?? ""), name: String(block.name ?? ""), input: (block.input ?? {}) as Record<string, unknown> };
        uses.push(use);
        byId.set(use.id, use);
      } else if (entry.type === "user" && block.type === "tool_result") {
        const use = byId.get(String(block.tool_use_id ?? ""));
        if (use) use.isError = Boolean(block.is_error);
      }
    }
  }
  return { uses, truncated: start > 0 };
}

const isAgentCall = (u: ToolUse, pattern: RegExp) =>
  ((u.name === "Agent" || u.name === "Task") && pattern.test(String(u.input.subagent_type ?? ""))) ||
  (u.name === "Skill" && pattern.test(String(u.input.skill ?? "")));

const isCommit = (u: ToolUse) => u.name === "Bash" && isCommitCommand(String(u.input.command ?? ""));

/** True when a review ran (and didn't fail) after the last successful commit; the commit being attempted now is excluded. */
export function reviewedSinceLastCommit(uses: ToolUse[], currentToolUseId?: string): boolean {
  let lastCommit = -1;
  uses.forEach((u, i) => {
    if (u.id !== currentToolUseId && isCommit(u) && u.isError === false) lastCommit = i;
  });
  return uses.slice(lastCommit + 1).some((u) => u.id !== currentToolUseId && u.isError !== true && isAgentCall(u, REVIEW_AGENT));
}

export function changedFiles(uses: ToolUse[]): Set<string> {
  const files = new Set<string>();
  for (const u of uses) {
    if (!EDIT_TOOLS.has(u.name)) continue;
    const file = u.input.file_path ?? u.input.notebook_path;
    if (typeof file === "string") files.add(file);
  }
  return files;
}

export function documenterRan(uses: ToolUse[]): boolean {
  return uses.some((u) => isAgentCall(u, DOCS_AGENT));
}

// ---------- once-per-session markers ----------

function markerFile(appData: string, sessionId: string): string | undefined {
  return SESSION_ID.test(sessionId) ? path.join(appData, "hook-state", `${sessionId}.json`) : undefined;
}

function hasMarker(appData: string, sessionId: string, key: string): boolean {
  const file = markerFile(appData, sessionId);
  if (!file) return true; // unknown session: don't nag
  try {
    return Boolean((JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>)[key]);
  } catch {
    return false;
  }
}

function setMarker(appData: string, sessionId: string, key: string): void {
  const file = markerFile(appData, sessionId);
  if (!file) return;
  let data: Record<string, boolean> = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, boolean>;
  } catch {
    // first marker for this session
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...data, [key]: true }));
}

// ---------- the hook ----------

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Returns the JSON to print for Claude Code, or undefined to do nothing. */
export function runGhostHook(appData: string, input: HookInput, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> | undefined {
  const brainDir = readJson<{ brainDir?: string }>(path.join(appData, "config.json"))?.brainDir;
  const machineId = readJson<{ id?: string }>(path.join(appData, "machine.json"))?.id;
  if (!brainDir || !machineId || !input.cwd || !fs.existsSync(brainDir)) return undefined;
  const store = new BrainStore(brainDir);
  const match = projectForFolder(store, machineId, input.cwd);
  const enforcement = store.getSettings().enforcement;
  const event = input.hook_event_name;
  const sessionId = input.session_id ?? "";
  if (!match) {
    // Not a GhostOS project: only how the user writes, which applies everywhere; otherwise stay out of the way.
    if (event !== "SessionStart" || env.GHOSTOS_SESSION === "1" || !enforcement.sessionContext) return undefined;
    const context = buildUserContext(store);
    return context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : undefined;
  }

  if (event === "SessionStart") {
    // GhostOS's own sessions already get this in their system prompt.
    if (env.GHOSTOS_SESSION === "1" || !enforcement.sessionContext) return undefined;
    const context = buildSessionContext(store, match.project, {
      folders: [input.cwd ?? "", match.folder].filter(Boolean),
      loops: readLoopsCache(appData, match.project.id),
      machineId,
    });
    return context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } } : undefined;
  }

  if (event === "PreToolUse" && input.tool_name === "Bash") {
    const command = String(input.tool_input?.command ?? "");
    if (enforcement.reviewBeforeCommit === "off" || !isCommitCommand(command) || !input.transcript_path) return undefined;
    const { uses, truncated } = readTranscript(input.transcript_path);
    if (reviewedSinceLastCommit(uses, input.tool_use_id)) return undefined;
    // A very long session whose last commit and review are both older than the part read: don't guess.
    if (truncated && !uses.some((u) => u.id !== input.tool_use_id && isCommit(u))) return undefined;
    // No way around this for Claude: the user can commit themselves, or set the check to Reminder in GhostOS.
    const why =
      `GhostOS rule for ${match.project.name}: run the code-reviewer agent on these changes before committing, then commit.` +
      " If the user wants to commit without a review, tell them to commit it themselves or set the check to Reminder in GhostOS (Rules → Enforcement).";
    if (enforcement.reviewBeforeCommit === "block") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } };
    }
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: `Reminder: ${why}` } };
  }

  if (event === "Stop") {
    if (input.stop_hook_active || enforcement.documenterReminder === "off" || !input.transcript_path) return undefined;
    if (hasMarker(appData, sessionId, "documenter")) return undefined;
    const uses = readToolUses(input.transcript_path);
    const files = changedFiles(uses);
    if (files.size < DOCUMENTER_FILE_THRESHOLD || documenterRan(uses)) return undefined;
    setMarker(appData, sessionId, "documenter");
    return {
      decision: "block",
      reason:
        `GhostOS reminder: this session changed ${files.size} files. If the work is complete, run the documenter agent to record it;` +
        " if the work is still in progress, briefly say so and stop.",
    };
  }

  if (event === "PostToolUseFailure" && input.tool_name === "Bash") {
    if (enforcement.errorLogReminder === "off" || hasMarker(appData, sessionId, "errorLog")) return undefined;
    if (!fs.existsSync(path.join(match.folder, "docs", "error-log"))) return undefined;
    setMarker(appData, sessionId, "errorLog");
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: "GhostOS reminder: this project keeps an error log in docs/error-log/. Check it (or ask the error-logger agent) for this error before debugging.",
      },
    };
  }
  return undefined;
}

function main(): void {
  const appData = process.argv[2];
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      if (!appData) return;
      const output = runGhostHook(appData, raw.trim() ? (JSON.parse(raw) as HookInput) : {});
      if (output) fs.writeSync(1, JSON.stringify(output));
    } catch (err) {
      // Never break a Claude session because of GhostOS.
      process.stderr.write(`GhostOS hook: ${(err as Error).message}\n`);
    }
  });
}

if (require.main === module) main();
