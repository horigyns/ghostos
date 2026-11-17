// When is a scheduled run due? Pure functions over local time, so they can be tested without a clock.
import type { RunDefinition, RunSchedule } from "../../shared/types";
import { describeSchedule, lastCronSlot, validateCron } from "../../shared/schedule";

export { describeSchedule };

const MS_PER_MINUTE = 60_000;
const DAYS_PER_WEEK = 7;
/** A daily or weekly slot missed by more than this (Mac asleep, app closed) is skipped, not run late. */
export const CATCH_UP_MS = 6 * 60 * MS_PER_MINUTE;

export interface RunState {
  /** when this run last started (or was deliberately skipped) */
  lastStartAt?: number;
  /** don't start before this time (waiting for a usage window to reset) */
  deferUntil?: number;
}

function parseTime(hhmm: string): { h: number; m: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`Invalid time "${hhmm}" (use HH:MM).`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new Error(`Invalid time "${hhmm}".`);
  return { h, m };
}

export function validateSchedule(schedule: RunSchedule): RunSchedule {
  if (schedule.kind === "interval") {
    if (!Number.isInteger(schedule.everyMinutes) || schedule.everyMinutes < 5) throw new Error("Interval must be at least 5 minutes.");
    return { kind: "interval", everyMinutes: schedule.everyMinutes };
  }
  if (schedule.kind === "cron") {
    if (typeof schedule.expr !== "string") throw new Error("Missing cron expression.");
    const { expr, tz } = validateCron(schedule.expr, typeof schedule.tz === "string" ? schedule.tz : undefined);
    return tz ? { kind: "cron", expr, tz } : { kind: "cron", expr };
  }
  if (schedule.kind === "once") {
    if (typeof schedule.at !== "string" || Number.isNaN(Date.parse(schedule.at))) throw new Error("Invalid time for a one-time run.");
    return { kind: "once", at: new Date(schedule.at).toISOString() };
  }
  parseTime(schedule.time);
  if (schedule.kind === "daily") return { kind: "daily", time: schedule.time };
  if (schedule.kind === "weekly") {
    const days = [...new Set(schedule.days)].filter((d) => Number.isInteger(d) && d >= 0 && d < DAYS_PER_WEEK).sort();
    if (!days.length) throw new Error("Pick at least one day.");
    return { kind: "weekly", days, time: schedule.time };
  }
  throw new Error("Unknown schedule.");
}

/** The most recent slot at or before `now`, or undefined for interval schedules. */
export function lastSlot(schedule: RunSchedule, now: Date): Date | undefined {
  if (schedule.kind === "interval") return undefined;
  if (schedule.kind === "cron") {
    try {
      return lastCronSlot(schedule.expr, schedule.tz, now);
    } catch {
      return undefined; // a hand-edited, broken expression never fires (the editor rejects it on save)
    }
  }
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return at <= now ? at : undefined;
  }
  const { h, m } = parseTime(schedule.time);
  for (let back = 0; back <= DAYS_PER_WEEK; back++) {
    const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, h, m, 0, 0);
    if (slot > now) continue;
    if (schedule.kind === "daily" || schedule.days.includes(slot.getDay())) return slot;
  }
  return undefined;
}

export function isDue(def: RunDefinition, state: RunState, now: Date): boolean {
  if (!def.enabled) return false;
  if (state.deferUntil && state.deferUntil > now.getTime()) return false;
  // Slots before the last edit never run, so changing a schedule doesn't fire a run immediately.
  const floor = Math.max(Date.parse(def.createdAt), def.updatedAt ? Date.parse(def.updatedAt) : 0);
  if (def.schedule.kind === "interval") {
    const last = Math.max(state.lastStartAt ?? 0, floor);
    return now.getTime() - last >= def.schedule.everyMinutes * MS_PER_MINUTE;
  }
  const slot = lastSlot(def.schedule, now);
  if (!slot || slot.getTime() < floor) return false;
  if (state.lastStartAt !== undefined && state.lastStartAt >= slot.getTime()) return false;
  // A run that waited for a usage window counts its catch-up time from the end of the wait.
  const reference = Math.max(slot.getTime(), state.deferUntil ?? 0);
  return now.getTime() - reference <= CATCH_UP_MS;
}
