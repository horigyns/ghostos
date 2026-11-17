// Schedule helpers shared by the main process (when is a run due?) and the renderer (describing a schedule).
// Pure functions over a passed-in time, so they can be tested without a clock.
// Cron expressions are the five standard fields (minute hour day-of-month month day-of-week) evaluated in an
// optional IANA time zone, e.g. imported claude.ai routines that run on UTC or "CRON_TZ=America/Los_Angeles".
import type { RunSchedule } from "./types";

const DAYS_PER_WEEK = 7;
const MINUTES_PER_HOUR = 60;
/** A cron schedule may not fire more often than this (the runner ticks once a minute). */
export const MIN_CRON_GAP_MINUTES = 5;
/** How far back to look for the latest cron slot (a yearly schedule still resolves). */
const CRON_LOOKBACK_DAYS = 366;
const MAX_LISTED_TIMES = 4;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  /** first value of `names` (1 for months, 0 for days) */
  nameBase?: number;
}
const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  { min: 0, max: 7, names: DOW_NAMES, nameBase: 0 }, // 0 and 7 are both Sunday
];

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** fields written as "*" (or "*\/n"); decides how day-of-month and day-of-week combine */
  domStar: boolean;
  dowStar: boolean;
  /** fields written exactly "*" (every day); used for descriptions */
  domAll: boolean;
  dowAll: boolean;
}

function fieldValue(token: string, spec: FieldSpec, expr: string): number {
  const lower = token.toLowerCase();
  const named = spec.names?.indexOf(lower) ?? -1;
  const value = named >= 0 ? named + (spec.nameBase ?? 0) : /^\d+$/.test(token) ? Number(token) : NaN;
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) throw new Error(`Invalid cron value "${token}" in "${expr}".`);
  return value;
}

function parseField(text: string, spec: FieldSpec, expr: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined || !range) throw new Error(`Invalid cron field "${text}" in "${expr}".`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${stepText}" in "${expr}".`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = fieldValue(a, spec, expr);
      hi = fieldValue(b, spec, expr);
      if (hi < lo) throw new Error(`Invalid cron range "${range}" in "${expr}".`);
    } else {
      lo = fieldValue(range, spec, expr);
      hi = stepText === undefined ? lo : spec.max; // "5/15" means 5, 20, 35, 50
    }
    for (let value = lo; value <= hi; value += step) out.add(value);
  }
  return out;
}

const sortedDesc = (values: Iterable<number>) => [...values].sort((a, b) => b - a);

/** Parses five cron fields. Throws a readable error for anything else. */
export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== FIELDS.length) throw new Error(`A cron schedule has 5 fields (minute hour day month weekday); got "${expr}".`);
  const sets = parts.map((part, i) => parseField(part, FIELDS[i], expr));
  const daysOfWeek = new Set([...sets[4]].map((d) => d % DAYS_PER_WEEK));
  return {
    minutes: sortedDesc(sets[0]),
    hours: sortedDesc(sets[1]),
    daysOfMonth: sets[2],
    months: sets[3],
    daysOfWeek,
    domStar: parts[2].startsWith("*"),
    dowStar: parts[4].startsWith("*"),
    domAll: parts[2] === "*",
    dowAll: parts[4] === "*",
  };
}

/** The shortest gap in minutes between two firings within an hour (60 when it fires once an hour or less). */
function minuteGap(cron: ParsedCron): number {
  const minutes = [...cron.minutes].sort((a, b) => a - b);
  if (minutes.length < 2) return MINUTES_PER_HOUR;
  let gap = minutes[0] + MINUTES_PER_HOUR - minutes[minutes.length - 1];
  for (let i = 1; i < minutes.length; i++) gap = Math.min(gap, minutes[i] - minutes[i - 1]);
  return gap;
}

export function validateTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Unknown time zone "${tz}".`);
  }
  return tz;
}

/** Checks a cron schedule; returns the normalized expression or throws. */
export function validateCron(expr: string, tz?: string): { expr: string; tz?: string } {
  const normalized = expr.trim().split(/\s+/).join(" ");
  const cron = parseCron(normalized);
  if (minuteGap(cron) < MIN_CRON_GAP_MINUTES) throw new Error(`A run can't repeat more often than every ${MIN_CRON_GAP_MINUTES} minutes.`);
  return { expr: normalized, tz: validateTimeZone(tz) };
}

/** Splits "CRON_TZ=Area/City m h dom mon dow" into its zone and expression. */
export function splitCronTz(raw: string): { expr: string; tz?: string } {
  const match = /^\s*(?:CRON_)?TZ=(\S+)\s+(.*)$/.exec(raw);
  return match ? { tz: match[1], expr: match[2].trim() } : { expr: raw.trim() };
}

// ---------- wall-clock time in a zone ----------

interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

function wallAt(t: number, tz?: string): Wall {
  if (!tz) {
    const date = new Date(t);
    return { y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate(), h: date.getHours(), mi: date.getMinutes() };
  }
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute) };
}

/** The instant a wall-clock time in `tz` (or local time) happens. */
export function wallToInstant(w: Wall, tz?: string): number {
  if (!tz) return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, 0, 0).getTime();
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const offsetAt = (t: number) => {
    const seen = wallAt(t, tz);
    return Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi) - Math.floor(t / 60_000) * 60_000;
  };
  const first = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(first);
  const seen = wallAt(second, tz);
  if (seen.h === w.h && seen.mi === w.mi) return second;
  // The wall time doesn't exist (skipped by a spring-forward change): fire just after the gap, as cron does.
  return Math.max(first, second);
}

/** The latest time at or before `now` that the cron expression fires, in `tz` (local time when absent). */
export function lastCronSlot(expr: string, tz: string | undefined, now: Date): Date | undefined {
  const cron = parseCron(expr);
  const today = wallAt(now.getTime(), tz);
  for (let back = 0; back <= CRON_LOOKBACK_DAYS; back++) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d - back));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!cron.months.has(mo)) continue;
    const domOk = cron.daysOfMonth.has(d);
    const dowOk = cron.daysOfWeek.has(day.getUTCDay());
    // Standard cron: when both day fields are restricted, either may match.
    const dayOk = cron.domStar && cron.dowStar ? true : cron.domStar ? dowOk : cron.dowStar ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of cron.hours) {
      for (const mi of cron.minutes) {
        const t = wallToInstant({ y, mo, d, h, mi }, tz);
        if (t <= now.getTime()) return new Date(t);
      }
    }
  }
  return undefined;
}

// ---------- describing schedules ----------

const pad = (n: number) => String(n).padStart(2, "0");

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zoneLabel(tz: string): string {
  return tz === "UTC" || tz === "Etc/UTC" ? "UTC" : tz.split("/").pop()!.replace(/_/g, " ");
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

function describeCron(expr: string, tz: string | undefined, now: Date): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(expr);
  } catch {
    return `Cron "${expr}"`;
  }
  const foreign = tz && tz !== localTimeZone() ? tz : undefined;
  const times: { h: number; mi: number }[] = [];
  for (const h of [...cron.hours].reverse()) for (const mi of [...cron.minutes].reverse()) times.push({ h, mi });
  const allMonths = cron.months.size === 12;
  if (times.length > MAX_LISTED_TIMES || !allMonths) return `Cron "${expr}"${foreign ? ` (${zoneLabel(foreign)})` : ""}`;

  const at = times.map((t) => `${pad(t.h)}:${pad(t.mi)}`).join(", ");
  let days: string;
  if (cron.domAll && cron.dowAll) days = "Daily";
  else if (cron.domAll && cron.dowStar === cron.dowAll) {
    const dows = [...cron.daysOfWeek].sort((a, b) => a - b);
    days = dows.length === WEEKDAYS.length && WEEKDAYS.every((d) => cron.daysOfWeek.has(d)) ? "Weekdays" : dows.map((d) => DAY_NAMES[d]).join(", ");
  } else if (cron.dowAll && cron.domStar === cron.domAll) {
    days = `Monthly on the ${[...cron.daysOfMonth].sort((a, b) => a - b).map(ordinal).join(", ")}`;
  } else return `Cron "${expr}"${foreign ? ` (${zoneLabel(foreign)})` : ""}`;

  if (!foreign) return `${days} at ${at}`;
  // Show the same times in this Mac's zone too (as of today; daylight saving can shift it by an hour).
  const today = wallAt(now.getTime(), foreign);
  const here = times
    .map((t) => {
      const local = new Date(wallToInstant({ y: today.y, mo: today.mo, d: today.d, h: t.h, mi: t.mi }, foreign));
      return `${pad(local.getHours())}:${pad(local.getMinutes())}`;
    })
    .join(", ");
  return `${days} at ${at} ${zoneLabel(foreign)} (${here} here)`;
}

/** Human description, e.g. "Weekdays at 09:00". */
export function describeSchedule(schedule: RunSchedule, now = new Date()): string {
  switch (schedule.kind) {
    case "interval":
      return schedule.everyMinutes % 60 === 0 ? `Every ${schedule.everyMinutes / 60} h` : `Every ${schedule.everyMinutes} min`;
    case "daily":
      return `Daily at ${schedule.time}`;
    case "weekly": {
      const label = schedule.days.length === WEEKDAYS.length && WEEKDAYS.every((d) => schedule.days.includes(d))
        ? "Weekdays"
        : schedule.days.map((d) => DAY_NAMES.at(d)).join(", ");
      return `${label} at ${schedule.time}`;
    }
    case "cron":
      return describeCron(schedule.expr, schedule.tz, now);
    case "once":
      return `Once, ${new Date(schedule.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
}
