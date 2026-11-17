// End-to-end checks for Phase 2 against the real Claude Code CLI (uses a little subscription usage, on Haiku).
// Run with: npm run smoke:phase2
// Checks: a scheduled run executes headless and records its result; the scheduler starts a due run;
// the background runner bundle runs a due job on its own; a real session summary proposes a brief;
// the brief reaches a new chat through the system prompt; search finds run output and sessions.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainStore } from "../../src/main/brain/store";
import { BrainGit } from "../../src/main/brain/git";
import { cleanEnv, findClaudeBinary } from "../../src/main/claude/env";
import { executeRun } from "../../src/main/runs/executor";
import { LocalState } from "../../src/main/runs/local-state";
import { tick } from "../../src/main/runs/tick";
import { MemoryService, type MemoryJobStatus } from "../../src/main/memory/service";
import { ChatSession } from "../../src/main/sessions/chat";
import { search } from "../../src/main/search/search";
import type { ChatEvent, RunDefinition } from "../../src/shared/types";

const WAIT_MS = 240_000;
const POLL_MS = 500;
const root = path.resolve(__dirname, "..", "..");
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-p2-")));
const folder = path.join(work, "project");
const appData = path.join(work, "app");
const brainDir = path.join(work, "brain");
fs.mkdirSync(folder);
fs.mkdirSync(appData);
for (const name of ["alpha.txt", "bravo.txt", "charlie.txt"]) fs.writeFileSync(path.join(folder, name), `${name}\n`);
fs.writeFileSync(path.join(appData, "config.json"), JSON.stringify({ brainDir }));
fs.writeFileSync(path.join(appData, "machine.json"), JSON.stringify({ id: "smoke-mac", name: "smoke" }));

const store = new BrainStore(brainDir);
store.ensure();
const project = store.createProject({ name: "Smoke project", area: "random", folders: [{ label: "project", paths: { "smoke-mac": folder } }] });
const local = new LocalState(appData);
const claudeBinary = findClaudeBinary();
const ctx = { store, local, claudeBinary, env: cleanEnv(), onBrainChanged: () => undefined };

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
};
const waitFor = async (cond: () => boolean, what: string) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > WAIT_MS) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
};

function runDef(id: string, schedule: RunDefinition["schedule"], createdAt: string): RunDefinition {
  return {
    id,
    projectId: project.id,
    name: `Count files ${id}`,
    prompt: "List the .txt files in this folder and reply with exactly one line: FILECOUNT=<number>.",
    schedule,
    model: "haiku",
    permissionMode: "auto",
    folder,
    runOn: "smoke-mac",
    enabled: true,
    createdAt,
  };
}

async function main() {
  await new BrainGit(brainDir).init(); // the app does this at startup

  // 1. A run executes headless and records its result.
  const manual = await executeRun(ctx, runDef("aaaa0001", { kind: "daily", time: "03:00" }, new Date().toISOString()), { trigger: "manual" });
  console.log(`  run result: ${manual.resultText?.slice(0, 120).replace(/\n/g, " ")}`);
  check("run executes headless and records the result", manual.status === "succeeded" && /FILECOUNT=3/.test(manual.resultText ?? ""));
  check("run has a resumable session and usage was cached", Boolean(manual.sessionId) && Boolean(local.getUsage()));

  // 2. The scheduler starts a run whose slot just passed.
  const now = new Date();
  const slot = new Date(now.getTime() - 60_000);
  const hhmm = `${String(slot.getHours()).padStart(2, "0")}:${String(slot.getMinutes()).padStart(2, "0")}`;
  const due = runDef("aaaa0002", { kind: "daily", time: hhmm }, new Date(now.getTime() - 3_600_000).toISOString());
  store.saveRun(due);
  local.approve(due); // the app approves runs saved on this Mac
  const started = await tick({ ...ctx, machineId: "smoke-mac", folderFor: (d) => d.folder }, now);
  const scheduled = store.listRunRecords(project.id).find((r) => r.runId === "aaaa0002");
  check("scheduler starts a due run once", started === 1 && scheduled?.status === "succeeded" && scheduled.trigger === "schedule");
  check("the same slot doesn't run twice", (await tick({ ...ctx, machineId: "smoke-mac", folderFor: (d) => d.folder }, new Date(now.getTime() + 30_000))) === 0);

  // 3. The background runner bundle runs a due interval job by itself.
  const interval = runDef("aaaa0003", { kind: "interval", everyMinutes: 5 }, new Date(Date.now() - 3_600_000).toISOString());
  store.saveRun(interval);
  local.approve(interval);
  execFileSync(process.execPath, [path.join(root, "dist", "runner", "index.js"), appData], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: WAIT_MS,
  });
  const byRunner = store.listRunRecords(project.id).find((r) => r.runId === "aaaa0003");
  check("background runner runs a due job and records it", byRunner?.status === "succeeded");
  check("runner commits the brain to git", execFileSync("git", ["-C", brainDir, "log", "--oneline"]).toString().includes("run"));

  // 3b. Stopping the runner mid-run (as launchd does on reload) records the run as stopped and ends Claude.
  const long = {
    ...runDef("aaaa0004", { kind: "interval", everyMinutes: 5 }, new Date(Date.now() - 3_600_000).toISOString()),
    prompt: "Use the Bash tool to run exactly: sleep 90 && echo slept. Then reply with one line: SLEPT.",
  };
  store.saveRun(long);
  local.approve(long);
  const runner = spawn(process.execPath, [path.join(root, "dist", "runner", "index.js"), appData], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
  });
  await waitFor(() => store.listRunRecords(project.id).some((r) => r.runId === "aaaa0004" && r.status === "running"), "long run to start");
  const childPid = store.listRunRecords(project.id).find((r) => r.runId === "aaaa0004")!.childPid!;
  await new Promise((r) => setTimeout(r, 8_000)); // let Claude get into the sleep
  runner.kill("SIGTERM");
  await new Promise((r) => runner.once("exit", r));
  const stopped = store.listRunRecords(project.id).find((r) => r.runId === "aaaa0004");
  let childGone = false;
  try {
    process.kill(childPid, 0);
  } catch {
    childGone = true;
  }
  console.log(`  stopped run: ${stopped?.status} — ${stopped?.note}`);
  check("stopping the runner mid-run records it as stopped and ends Claude", stopped?.status === "failed" && /SIGTERM/.test(stopped.note ?? "") && childGone);
  store.deleteRun(project.id, "aaaa0004");

  // 4. A real summary of a session with durable decisions proposes a brief.
  const decisionsSession = crypto.randomUUID();
  const decisionChat = new ChatSession({
    claudeBinary,
    cwd: folder,
    env: cleanEnv(),
    settingsFile: path.join(appData, "none.json"),
    permissionMode: "auto",
    model: "haiku",
    sessionId: decisionsSession,
    sessionExists: () => false,
  });
  fs.writeFileSync(path.join(appData, "none.json"), "{}");
  const decisionEvents: ChatEvent[] = [];
  decisionChat.on("event", (e) => decisionEvents.push(e));
  await decisionChat.send(
    "Project decisions for the record: we deploy only on Fridays, and the staging database is called smoke-staging-db. " +
      "The open question is whether to add a second region. Acknowledge in one short sentence.",
  );
  await waitFor(() => decisionEvents.some((e) => e.kind === "turn-end"), "decision chat");
  await decisionChat.stop();

  const statuses: MemoryJobStatus[] = [];
  const memory = new MemoryService({
    store,
    local,
    claudeBinary,
    env: () => cleanEnv(),
    jobsDir: path.join(appData, "jobs"),
    onStatus: (s) => statuses.push(s),
    onChanged: () => undefined,
  });
  memory.enqueue({ projectId: project.id, sessionId: decisionsSession, cwd: folder, manual: true });
  await waitFor(() => statuses.some((s) => ["done", "failed", "skipped"].includes(s.state)), "summary");
  const last = statuses.at(-1)!;
  if (last.state !== "done") console.log(`  summary: ${last.state} ${last.message ?? ""}`);
  check("session summary is saved", last.state === "done" && store.listSessionSummaries(project.id).length === 1);
  const proposal = store.getBriefProposal(project.id);
  console.log(`  proposed brief: ${proposal?.text.slice(0, 160).replace(/\n/g, " ") ?? "(none)"}`);
  check("first brief is proposed for approval (not applied)", /friday/i.test(proposal?.text ?? "") && !store.getBrief(project.id));

  // 5. The brief reaches a new chat through the system prompt.
  store.saveBrief(project.id, "Codename for this project: BRIEF-TOKEN-77.");
  const chat = new ChatSession({
    claudeBinary,
    cwd: folder,
    env: cleanEnv(),
    settingsFile: path.join(appData, "none.json"),
    permissionMode: "auto",
    model: "haiku",
    sessionId: crypto.randomUUID(),
    sessionExists: () => false,
    appendSystemPrompt: () => `Project brief for Smoke project:\n\n${store.getBrief(project.id)}`,
  });
  fs.writeFileSync(path.join(appData, "none.json"), "{}");
  const events: ChatEvent[] = [];
  chat.on("event", (e) => events.push(e));
  await chat.send("What is this project's codename according to the project brief? Reply with just the codename.");
  await waitFor(() => events.some((e) => e.kind === "turn-end"), "brief chat");
  const reply = events.filter((e) => e.kind === "assistant-text").map((e) => (e as { text: string }).text).join(" ");
  check("brief reaches new chats via the system prompt", /BRIEF-TOKEN-77/.test(reply));
  await chat.stop();

  // 6. Search finds run output and sessions.
  const hits = await search({ query: "FILECOUNT", brainDir, projects: [{ id: project.id, name: project.name, folders: [folder] }] });
  check("search finds run results and session transcripts", hits.some((h) => h.kind === "run") && hits.some((h) => h.kind === "session"));
}

main()
  .catch((err) => {
    console.error(err);
    results.push(["no errors", false]);
  })
  .finally(() => {
    // Clean up Claude Code's transcripts for the temp folder, then the temp folder itself.
    fs.rmSync(path.join(os.homedir(), ".claude", "projects", folder.replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
    const failed = results.filter(([, ok]) => !ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
