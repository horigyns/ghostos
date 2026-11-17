// How GhostOS launches the Claude Code CLI: the unmodified binary, on the user's own login,
// with a clean environment so nothing from a parent process (another Claude session, an API key)
// changes which account or settings it uses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATE_BIN_DIRS = [".local/bin", "/opt/homebrew/bin", "/usr/local/bin"];
const BASE_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Env vars that would redirect Claude Code away from the user's own subscription login. */
const STRIPPED_PREFIXES = ["CLAUDECODE", "CLAUDE_CODE_", "CLAUDE_AGENT_SDK_", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PREVIEW_"];
const STRIPPED_EXACT = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ELECTRON_RUN_AS_NODE"];

function binDirs(): string[] {
  return CANDIDATE_BIN_DIRS.map((d) => (path.isAbsolute(d) ? d : path.join(os.homedir(), d)));
}

/** Finds the claude binary; apps opened from Finder don't get the shell's PATH. */
export function findClaudeBinary(): string {
  for (const dir of binDirs()) {
    const candidate = path.join(dir, "claude");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "claude";
}

export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (STRIPPED_EXACT.includes(key) || STRIPPED_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }
  const existingPath = (env.PATH ?? "").split(":").filter(Boolean);
  env.PATH = [...new Set([...binDirs(), ...existingPath, ...BASE_PATH])].join(":");
  env.TERM = env.TERM ?? "xterm-256color";
  return { ...env, ...extra };
}
