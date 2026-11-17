// Installs the background runner as a per-user launchd agent, so scheduled runs fire while GhostOS
// is closed. It wakes every few minutes, runs whatever is due, and exits.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUNNER_LABEL = "com.ghostos.runner";
const RUNNER_INTERVAL_S = 300;

function plistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${RUNNER_LABEL}.plist`);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function launchctl(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile("launchctl", args, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })),
  );
}

export function runnerInstalled(): boolean {
  return fs.existsSync(plistPath());
}

export function runnerPlist(nodeBinary: string, runnerScript: string, appData: string): string {
  const log = path.join(appData, "runner.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${RUNNER_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(nodeBinary)}</string><string>${xml(runnerScript)}</string><string>${xml(appData)}</string></array>
  <key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>
  <key>StartInterval</key><integer>${RUNNER_INTERVAL_S}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardInPath</key><string>/dev/null</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** True when the installed agent already matches this build (nothing to reload). */
export function runnerUpToDate(nodeBinary: string, runnerScript: string, appData: string): boolean {
  try {
    return fs.readFileSync(plistPath(), "utf8") === runnerPlist(nodeBinary, runnerScript, appData);
  } catch {
    return false;
  }
}

export async function installRunner(nodeBinary: string, runnerScript: string, appData: string): Promise<void> {
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), runnerPlist(nodeBinary, runnerScript, appData));
  const domain = `gui/${process.getuid!()}`;
  await launchctl(["bootout", `${domain}/${RUNNER_LABEL}`]); // reload if already loaded
  const loaded = await launchctl(["bootstrap", domain, plistPath()]);
  if (!loaded.ok) {
    fs.rmSync(plistPath(), { force: true }); // don't report an agent as installed when it isn't loaded
    throw new Error(`Could not start the background runner: ${loaded.out}`);
  }
}

export async function uninstallRunner(): Promise<void> {
  await launchctl(["bootout", `gui/${process.getuid!()}/${RUNNER_LABEL}`]);
  fs.rmSync(plistPath(), { force: true });
}
