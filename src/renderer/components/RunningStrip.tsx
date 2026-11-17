import type { ChatEvent, LiveSession, ProjectView, UsageSnapshot } from "../../shared/types";
import { sessionLabel, sessionTone } from "../board";

const WARN_PCT = 70;
const BAD_PCT = 90;

interface Props {
  live: LiveSession[];
  events: Record<string, ChatEvent[]>;
  projects: ProjectView[];
  /** the session shown on Sessions, when that's the current place */
  activeKey: string | null;
  usage: UsageSnapshot | null;
  onOpen: (key: string) => void;
}

function resetText(at?: number): string {
  return at ? new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) : "unknown";
}

function Bar({ pct }: { pct?: number }) {
  const value = Math.min(100, Math.max(0, pct ?? 0));
  const tone = value >= BAD_PCT ? "bad" : value >= WARN_PCT ? "warn" : "";
  return (
    <i>
      <b className={tone} style={{ width: `${value}%` }} />
    </i>
  );
}

/** The footer: one chip per live session, and plan usage on the right. */
export function RunningStrip({ live, events, projects, activeKey, usage, onOpen }: Props) {
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? "";
  const title = usage
    ? `5-hour window ${Math.round(usage.fiveHourPct ?? 0)}%, resets ${resetText(usage.fiveHourResetsAt)} · week ${Math.round(usage.sevenDayPct ?? 0)}%, resets ${resetText(usage.sevenDayResetsAt)}`
    : "Usage shows after Claude's first reply";
  return (
    <footer className="strip">
      <span className="strip-label">Running</span>
      {!live.length && <span className="faint">nothing</span>}
      {live.map((s) => {
        const tone = sessionTone(s, events[s.key]);
        return (
          <button key={s.key} className={`run-chip ${activeKey === s.key ? "on" : ""}`} title={s.cwd} onClick={() => onOpen(s.key)}>
            <span className={`dot ${tone}`} />
            <span className="ellipsis">{s.title}</span>
            <span className="p">
              · {name(s.projectId)} · {s.view === "terminal" ? "terminal" : sessionLabel(tone)}
            </span>
          </button>
        );
      })}
      <span className="meter" title={title}>
        5h <Bar pct={usage?.fiveHourPct} /> week <Bar pct={usage?.sevenDayPct} />
      </span>
    </footer>
  );
}
