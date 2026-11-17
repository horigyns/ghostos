// Machine-local state shared by the app and the background runner (both may run at once):
// the latest usage snapshot, per-run schedule state, per-Mac run approvals, and the runner lock.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunDefinition, UsageSnapshot } from "../../shared/types";
import type { RunState } from "./schedule";

const USAGE_FILE = "usage.json";
const STATE_FILE = "runner-state.json";
const APPROVALS_FILE = "run-approvals.json";
const LOCK_FILE = "runner.lock";
/** A lock whose holder hasn't refreshed it for this long is considered abandoned. */
export const LOCK_HEARTBEAT_STALE_MS = 10 * 60_000;
/** Boot times within this tolerance are the same boot (uptime is read at slightly different moments). */
const BOOT_TOLERANCE_MS = 2 * 60_000;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** When this Mac last booted; a pid recorded before a reboot means nothing after it. */
export function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when a pid recorded at `bootAt` still refers to a running process from the same boot. */
export function ownerAlive(pid: number | undefined, bootAt: number | undefined): boolean {
  return Boolean(bootAt && Math.abs(bootAt - bootTime()) < BOOT_TOLERANCE_MS && isAlive(pid));
}

/** Fingerprint of the parts of a run that decide what it does, for per-Mac approval. */
export function runFingerprint(def: RunDefinition): string {
  const { prompt, schedule, model, permissionMode, folder, runOn } = def;
  return crypto.createHash("sha256").update(JSON.stringify({ prompt, schedule, model, permissionMode, folder, runOn })).digest("hex");
}

interface LockInfo {
  pid: number;
  token: string;
  at: number;
  bootAt: number;
}

export interface Lock {
  /** refreshes the lock so a long run doesn't look abandoned */
  heartbeat(): void;
  /** releases the lock, only if it is still ours */
  release(): void;
}

export class LocalState {
  constructor(private readonly appData: string) {}

  getUsage(): UsageSnapshot | undefined {
    return readJson<UsageSnapshot | undefined>(path.join(this.appData, USAGE_FILE), undefined);
  }

  /** Keeps the newest observation. A window the new snapshot doesn't report keeps its old value and reset time. */
  recordUsage(usage: UsageSnapshot): void {
    const prev = this.getUsage();
    if (prev && prev.observedAt > usage.observedAt) return;
    writeJson(path.join(this.appData, USAGE_FILE), {
      ...prev,
      ...Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)),
    });
  }

  getRunState(runId: string): RunState {
    return this.allRunStates()[runId] ?? {};
  }

  setRunState(runId: string, patch: RunState): void {
    const all = this.allRunStates();
    all[runId] = { ...all[runId], ...patch };
    writeJson(path.join(this.appData, STATE_FILE), { runs: all, lastTickAt: this.lastTickAt() });
  }

  noteTick(): void {
    writeJson(path.join(this.appData, STATE_FILE), { runs: this.allRunStates(), lastTickAt: Date.now() });
  }

  lastTickAt(): number | undefined {
    return readJson<{ lastTickAt?: number }>(path.join(this.appData, STATE_FILE), {}).lastTickAt;
  }

  private allRunStates(): Record<string, RunState> {
    return readJson<{ runs?: Record<string, RunState> }>(path.join(this.appData, STATE_FILE), {}).runs ?? {};
  }

  // ---------- per-Mac approval: a run synced from elsewhere doesn't execute here until approved here ----------

  isApproved(def: RunDefinition): boolean {
    return readJson<Record<string, string>>(path.join(this.appData, APPROVALS_FILE), {})[def.id] === runFingerprint(def);
  }

  approve(def: RunDefinition): void {
    const all = readJson<Record<string, string>>(path.join(this.appData, APPROVALS_FILE), {});
    all[def.id] = runFingerprint(def);
    writeJson(path.join(this.appData, APPROVALS_FILE), all);
  }

  // ---------- runner lock ----------

  /** Whether another live process currently holds the runner lock (e.g. the runner is mid-run). */
  lockHeldByOther(): boolean {
    const held = readJson<Partial<LockInfo> | undefined>(path.join(this.appData, LOCK_FILE), undefined);
    return Boolean(
      held && held.pid !== process.pid && typeof held.at === "number" &&
        Date.now() - held.at < LOCK_HEARTBEAT_STALE_MS && ownerAlive(held.pid, held.bootAt),
    );
  }

  /** Takes the runner lock, or returns undefined if another live process holds it. */
  tryLock(): Lock | undefined {
    const file = path.join(this.appData, LOCK_FILE);
    fs.mkdirSync(this.appData, { recursive: true });
    const held = readJson<Partial<LockInfo> | undefined>(file, undefined);
    if (held) {
      const fresh = typeof held.at === "number" && Date.now() - held.at < LOCK_HEARTBEAT_STALE_MS;
      if (fresh && ownerAlive(held.pid, held.bootAt)) return undefined;
      // Steal an abandoned lock by renaming it away; only one contender's rename can succeed.
      try {
        fs.renameSync(file, `${file}.stale-${crypto.randomBytes(4).toString("hex")}`);
      } catch {
        return undefined;
      }
      this.cleanStaleLocks();
    }
    const mine: LockInfo = { pid: process.pid, token: crypto.randomBytes(8).toString("hex"), at: Date.now(), bootAt: bootTime() };
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx" }); // fails if someone else just created it
    } catch {
      return undefined;
    }
    const stillMine = () => readJson<Partial<LockInfo>>(file, {}).token === mine.token;
    return {
      heartbeat: () => {
        if (stillMine()) writeJson(file, { ...mine, at: Date.now() });
      },
      release: () => {
        if (stillMine()) fs.rmSync(file, { force: true });
      },
    };
  }

  private cleanStaleLocks(): void {
    for (const name of fs.readdirSync(this.appData)) {
      if (name.startsWith(`${LOCK_FILE}.stale-`)) fs.rmSync(path.join(this.appData, name), { force: true });
    }
  }
}
