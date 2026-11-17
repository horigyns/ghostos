// Ghost wiring: the supervisor's IPC, macOS notifications (a click opens Ghost in GhostOS), and its timers.
// Registered by setupPhase2, which owns the summarizer queue and the budget guard Ghost uses.
import { ipcMain, Notification } from "electron";
import { IPC } from "../shared/api";
import type { GhostSettings, GhostState } from "../shared/types";
import { GhostService, type GhostAction, type GhostDeps } from "./ghost/service";

const ACTIONS: readonly GhostAction[] = ["done", "dismiss", "snooze-day", "snooze-week", "reopen"];
const LOOP_ID = /^[a-z]-[A-Za-z0-9-]{4,64}$/;
const STALL_DAYS_MAX = 60;
const REMIND_DAYS_MAX = 30;
const HOURS_PER_DAY = 24;
const DIGEST_TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

export interface GhostWiringDeps extends Omit<GhostDeps, "notify" | "onChanged"> {
  send: (channel: string, ...args: unknown[]) => void;
  /** brings the GhostOS window to the front */
  focusWindow: () => void;
}

function wholeNumber(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${what} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** Checks Ghost settings sent from the Settings dialog; missing fields keep their current value. */
export function ghostSettings(input: unknown, current: GhostSettings): GhostSettings {
  if (input === undefined || input === null || typeof input !== "object") return current;
  const raw = input as Partial<Record<keyof GhostSettings, unknown>>;
  const bool = (value: unknown, fallback: boolean) => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error("Ghost on/off settings must be true or false.");
    return value;
  };
  const digestTime = raw.digestTime === undefined ? current.digestTime : String(raw.digestTime).trim();
  if (digestTime && !DIGEST_TIME.test(digestTime)) throw new Error("The digest time must be HH:MM, or empty for no digest.");
  return {
    enabled: bool(raw.enabled, current.enabled),
    stallDays: raw.stallDays === undefined ? current.stallDays : wholeNumber(raw.stallDays, "Stalled after", 1, STALL_DAYS_MAX),
    notifications: bool(raw.notifications, current.notifications),
    remindEveryDays: raw.remindEveryDays === undefined ? current.remindEveryDays : wholeNumber(raw.remindEveryDays, "Remind every", 1, REMIND_DAYS_MAX),
    quietFrom: raw.quietFrom === undefined ? current.quietFrom : wholeNumber(raw.quietFrom, "Quiet hours start", 0, HOURS_PER_DAY - 1),
    quietTo: raw.quietTo === undefined ? current.quietTo : wholeNumber(raw.quietTo, "Quiet hours end", 0, HOURS_PER_DAY - 1),
    autoSummarize: bool(raw.autoSummarize, current.autoSummarize),
    digestTime,
  };
}

export function setupGhost(deps: GhostWiringDeps): { ghost: GhostService; stop: () => void } {
  const { send, focusWindow, ...rest } = deps;
  // Keep a reference to shown notifications: macOS drops click handlers of garbage-collected ones.
  const shown = new Set<Notification>();
  const ghost: GhostService = new GhostService({
    ...rest,
    onChanged: () => send(IPC.evGhostChanged, ghost.state()),
    notify: (notice) => {
      if (!Notification.isSupported() || process.env.GHOSTOS_CAPTURE) return false;
      const n = new Notification({ title: `Ghost · ${notice.title}`, body: notice.body });
      shown.add(n);
      n.on("click", () => {
        focusWindow();
        send(IPC.evGhostOpen, notice.projectId ?? null);
        shown.delete(n);
      });
      n.on("close", () => shown.delete(n));
      n.show();
      return true;
    },
  });

  ipcMain.handle(IPC.ghostState, (): GhostState => ghost.state());
  ipcMain.handle(IPC.ghostScan, async (): Promise<GhostState> => {
    await ghost.scan();
    return ghost.state();
  });
  ipcMain.handle(IPC.ghostDecide, (_e, loopId: unknown, action: unknown) => {
    if (typeof loopId !== "string" || !LOOP_ID.test(loopId)) throw new Error("Invalid loop.");
    if (!ACTIONS.includes(action as GhostAction)) throw new Error("Unknown action.");
    ghost.decide(loopId, action as GhostAction);
  });
  ipcMain.handle(IPC.ghostDigest, () => ghost.runDigest(true));

  ghost.start();
  return { ghost, stop: () => ghost.stop() };
}
