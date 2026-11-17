// GhostOS background runner. launchd starts it every few minutes (as Electron running in Node mode):
//   <electron> dist/runner/index.js <appDataDir>
// It closes runs interrupted earlier, runs any scheduled Claude runs that are due on this Mac,
// commits the brain, and exits. If launchd stops it mid-run, the run is recorded as stopped.
import { BrainStore } from "../main/brain/store";
import { BrainGit } from "../main/brain/git";
import { loadMachine } from "../main/brain/machine";
import { runFolder } from "../main/brain/view";
import { cleanEnv, findClaudeBinary } from "../main/claude/env";
import { loadConfig } from "../main/config";
import { stopActiveRuns } from "../main/runs/executor";
import { LocalState } from "../main/runs/local-state";
import { tick } from "../main/runs/tick";

async function main(): Promise<void> {
  const appData = process.argv[2];
  if (!appData) throw new Error("usage: runner <appDataDir>");
  const config = loadConfig(appData);
  const machine = loadMachine(appData);
  const store = new BrainStore(config.brainDir);
  const git = new BrainGit(config.brainDir);
  const reasons: string[] = [];

  const shutdown = async (signal: string) => {
    await stopActiveRuns(`Stopped: the background runner received ${signal}.`);
    for (const reason of reasons) git.scheduleCommit(reason);
    await git.commitNow();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  const started = await tick({
    store,
    local: new LocalState(appData),
    claudeBinary: findClaudeBinary(),
    env: cleanEnv({ GHOSTOS_SESSION: "1" }),
    machineId: machine.id,
    folderFor: (def) => runFolder(def, store.getProject(def.projectId), machine.id),
    onBrainChanged: (reason) => reasons.push(reason),
  });
  for (const reason of reasons) git.scheduleCommit(reason);
  await git.commitNow();
  if (started) console.log(`[runner ${new Date().toISOString()}] ran ${started} job(s)`);
}

main().catch((err) => {
  console.error(`[runner ${new Date().toISOString()}] ${(err as Error).stack ?? err}`);
  process.exitCode = 1;
});
