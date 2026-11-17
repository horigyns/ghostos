// End-to-end checks for Phase 3 against the real Claude Code CLI (a little subscription usage, on Haiku).
// Run with: npm run smoke:phase3
// Uses the installer's real hook entries, written to a temporary settings file (never ~/.claude), and checks:
// SessionStart gives a session in a project folder its rules; the commit gate blocks git commit without a
// review; a session outside GhostOS project folders gets nothing.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../../src/main/brain/store";
import { cleanEnv, findClaudeBinary } from "../../src/main/claude/env";
import { CapabilityInstaller } from "../../src/main/capabilities/install";

const CLAUDE_TIMEOUT_MS = 180_000;
const CODE_WORD = "PERIWINKLE-42";
const MACHINE = "smoke-mac";
const root = path.resolve(__dirname, "..", "..");
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-p3-")));
const folder = path.join(work, "project");
const outside = path.join(work, "outside");
const appData = path.join(work, "app");
const claudeDir = path.join(work, "claude-home");
const brainDir = path.join(work, "brain");
for (const d of [folder, outside, appData, path.join(claudeDir, "agents")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(appData, "config.json"), JSON.stringify({ brainDir }));
fs.writeFileSync(path.join(appData, "machine.json"), JSON.stringify({ id: MACHINE, name: "smoke" }));
fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");

const store = new BrainStore(brainDir);
store.ensure();
const project = store.createProject({ name: "Smoke project", area: "random", folders: [{ label: "project", paths: { [MACHINE]: folder } }] });
store.saveRules({ projectId: project.id }, `The project code word is ${CODE_WORD}. Say it when asked for the code word.`);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder });
fs.writeFileSync(path.join(folder, "a.txt"), "a\n");
execFileSync("git", ["add", "a.txt"], { cwd: folder });

// The installer writes the same hook entries it would put in ~/.claude, here into a temp folder.
new CapabilityInstaller({ claudeDir, appData, nodeBinary: process.execPath, hookScript: path.join(root, "dist", "hook", "ghostos-hook.js") }).apply([], {});
const settingsFile = path.join(claudeDir, "settings.json");

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail.slice(0, 600)}`}`);
};

function claude(cwd: string, prompt: string, extra: string[] = []): string {
  const r = spawnSync(
    findClaudeBinary(),
    ["-p", "--model", "haiku", "--no-session-persistence", "--setting-sources", "", "--settings", settingsFile, "--strict-mcp-config", ...extra],
    // The prompt goes on stdin: --tools and --allowedTools take several values and would swallow it.
    { cwd, env: cleanEnv(), encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS, input: prompt },
  );
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

const commits = () => {
  try {
    return Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: folder, encoding: "utf8", stdio: "pipe" }).trim());
  } catch {
    return 0;
  }
};

async function main() {
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  check("installer wrote the four hook events", ["SessionStart", "PreToolUse", "Stop", "PostToolUseFailure"].every((e) => settings.hooks?.[e]?.length));

  const ask = "What is the project code word from your instructions? Reply with only the code word, or NONE if you have none.";
  const inProject = claude(path.join(folder), ask, ["--tools", ""]);
  check("a session in a project folder starts with the project's rules", inProject.includes(CODE_WORD), inProject);

  const notProject = claude(outside, ask, ["--tools", ""]);
  check("a session outside project folders gets nothing", !notProject.includes(CODE_WORD), notProject);

  const commitOut = claude(
    folder,
    "Run exactly this shell command once, with nothing added: git -c user.name=smoke -c user.email=smoke@example.com commit -m smoke. Then report what happened in one sentence.",
    ["--tools", "Bash", "--allowedTools", "Bash(git *)"],
  );
  check("git commit (with -c options) is blocked without a review", commits() === 0, commitOut);
  check("Claude is told a review is needed", /review/i.test(commitOut), commitOut);

  const compoundOut = claude(
    folder,
    `Run exactly this shell command once, with nothing added: cd ${folder} && git -c user.name=smoke -c user.email=smoke@example.com commit -m smoke2. Then report what happened in one sentence.`,
    ["--tools", "Bash", "--allowedTools", "Bash(*)"],
  );
  check("a compound cd && git commit is blocked too", commits() === 0, compoundOut);

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
