// One pass of the scheduler: start every run that is due on this machine, after asking the budget
// guard. Called every minute by the app while it's open, and every few minutes by the background
// runner (launchd) when it's enabled. A lock makes sure only one of them starts runs at a time.
import crypto from "node:crypto";
import type { RunDefinition } from "../../shared/types";
import { decideRun } from "./budget";
import { executeRun, isRunActive, reconcileInterruptedRuns, type RunContext } from "./executor";
import { isDue } from "./schedule";

const HEARTBEAT_MS = 60_000;

export interface TickContext extends RunContext {
  machineId: string;
  /** resolves a run's folder on this machine (the project's primary folder when the run has none) */
  folderFor: (def: RunDefinition) => string | undefined;
}

export async function tick(ctx: TickContext, now = new Date()): Promise<number> {
  const lock = ctx.local.tryLock();
  if (!lock) return 0;
  // Keep the lock fresh during long runs so the other process doesn't think it was abandoned.
  const heartbeat = setInterval(() => lock.heartbeat(), HEARTBEAT_MS);
  const startedAt = Date.now();
  // Runs can take a while; later decisions in this pass use the time as it is then.
  const clock = () => new Date(now.getTime() + (Date.now() - startedAt));
  let started = 0;
  try {
    ctx.local.noteTick();
    if (reconcileInterruptedRuns(ctx.store)) ctx.onBrainChanged("close interrupted runs");
    for (const project of ctx.store.listProjects()) ctx.store.compactRunHistory(project.id);
    const settings = ctx.store.getSettings();
    const archived = new Set(ctx.store.listProjects().filter((p) => p.archived).map((p) => p.id));
    for (const def of ctx.store.listAllRuns()) {
      if (archived.has(def.projectId)) continue; // an archived project's runs stop
      if (def.runOn !== ctx.machineId) continue;
      if (!ctx.local.isApproved(def)) continue; // synced from elsewhere: waits for approval on this Mac
      const at = clock();
      const state = ctx.local.getRunState(def.id);
      if (!isDue(def, state, at) || isRunActive(ctx.store, def)) continue;
      const decision = decideRun(def.model, ctx.local.getUsage(), settings.budget, at.getTime());
      const skipRecord = (note: string) =>
        ctx.store.appendRunRecord(def.projectId, {
          id: crypto.randomBytes(6).toString("hex"),
          runId: def.id,
          projectId: def.projectId,
          name: def.name,
          trigger: "schedule",
          status: "skipped",
          startedAt: at.toISOString(),
          endedAt: at.toISOString(),
          note,
          read: false,
        });
      if (decision.action === "skip") {
        ctx.local.setRunState(def.id, { lastStartAt: at.getTime(), deferUntil: undefined });
        skipRecord(decision.reason);
        ctx.onBrainChanged(`run ${def.name} skipped`);
        continue;
      }
      if (decision.action === "defer") {
        if (!state.deferUntil) {
          skipRecord(decision.reason);
          ctx.onBrainChanged(`run ${def.name} waiting`);
        }
        ctx.local.setRunState(def.id, { deferUntil: decision.until });
        continue;
      }
      ctx.local.setRunState(def.id, { lastStartAt: at.getTime(), deferUntil: undefined });
      await executeRun(ctx, { ...def, folder: ctx.folderFor(def) }, { trigger: "schedule", model: decision.model, note: decision.note });
      started++;
    }
  } finally {
    clearInterval(heartbeat);
    lock.release();
  }
  return started;
}
