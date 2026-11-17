// The budget guard: decides whether background work may run, and on which model, from the latest
// known usage of the Claude subscription (5-hour and weekly windows).
import type { BudgetSettings, UsageSnapshot } from "../../shared/types";

/** Usage older than this is treated as unknown. */
export const USAGE_STALE_MS = 6 * 60 * 60_000;
const MS_PER_SECOND = 1000;

export type BudgetDecision =
  | { action: "run"; model?: string; note?: string }
  | { action: "skip"; reason: string }
  | { action: "defer"; until: number; reason: string };

/** Current usage percentages, ignoring windows that have already reset. */
export function effectiveUsage(usage: UsageSnapshot | undefined, now: number): { week?: number; fiveHour?: number; fiveHourResetsAt?: number } {
  if (!usage || now - usage.observedAt > USAGE_STALE_MS) return {};
  const live = (pct: number | undefined, resetsAt: number | undefined) =>
    pct === undefined || (resetsAt !== undefined && resetsAt * MS_PER_SECOND <= now) ? undefined : pct;
  return {
    week: live(usage.sevenDayPct, usage.sevenDayResetsAt),
    fiveHour: live(usage.fiveHourPct, usage.fiveHourResetsAt),
    fiveHourResetsAt: usage.fiveHourResetsAt ? usage.fiveHourResetsAt * MS_PER_SECOND : undefined,
  };
}

/** Whether `model` is already the cheaper model or cheaper still (so switching would be an upgrade). */
function isCheaperOrSame(model: string | undefined, cheaper: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return m.includes("haiku") || m.includes(cheaper);
}

/** For a scheduled run with a preferred model. */
export function decideRun(model: string | undefined, usage: UsageSnapshot | undefined, budget: BudgetSettings, now: number): BudgetDecision {
  const { week, fiveHour, fiveHourResetsAt } = effectiveUsage(usage, now);
  if (week !== undefined && week >= budget.pauseAboveWeekPct) {
    return { action: "skip", reason: `Skipped: weekly usage is at ${week}% (pause threshold ${budget.pauseAboveWeekPct}%).` };
  }
  if (fiveHour !== undefined && fiveHour >= budget.pauseAboveFiveHourPct && fiveHourResetsAt && fiveHourResetsAt > now) {
    return {
      action: "defer",
      until: fiveHourResetsAt,
      reason: `Waiting: 5-hour usage is at ${fiveHour}%; runs after it resets at ${new Date(fiveHourResetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`,
    };
  }
  if (week !== undefined && week >= budget.downgradeAboveWeekPct && !isCheaperOrSame(model, budget.downgradeModel)) {
    return { action: "run", model: budget.downgradeModel, note: `Ran on ${budget.downgradeModel} to save usage (weekly at ${week}%).` };
  }
  return { action: "run", model };
}

/** For light background jobs such as session summaries. */
export function backgroundAllowed(usage: UsageSnapshot | undefined, budget: BudgetSettings, now: number): boolean {
  const { week, fiveHour } = effectiveUsage(usage, now);
  return (week ?? 0) < budget.pauseAboveWeekPct && (fiveHour ?? 0) < budget.pauseAboveFiveHourPct;
}
