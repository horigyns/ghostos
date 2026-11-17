import { useCallback, useEffect, useRef, useState } from "react";
import type { RunInput } from "../../shared/api";
import type { PermissionMode, ProjectView, RunDefinition, RunRecord, RunSchedule } from "../../shared/types";
import { describeSchedule, localTimeZone } from "../../shared/schedule";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_TIME = "09:00";
const DEFAULT_INTERVAL_MIN = 60;
const MODEL_CHOICES = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];
const PERMISSIONS: { value: PermissionMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan only (read-only)" },
];

const DEFAULT_CRON = "0 9 * * 1-5";
/** Zones offered for a cron schedule: this Mac's, UTC, and whatever the run already uses. */
function zoneChoices(current?: string): string[] {
  return [...new Set([localTimeZone(), "UTC", ...(current ? [current] : [])])];
}

/** "2026-11-16T17:00" for a datetime-local input, in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
}

interface Props {
  project: ProjectView;
  machineId: string;
  version: number;
  onOpenSession: (sessionId: string, title: string) => void;
  onError: (err: unknown) => void;
}

function emptyDraft(projectId: string): RunInput {
  return { projectId, name: "", prompt: "", schedule: { kind: "daily", time: DEFAULT_TIME }, permissionMode: "auto", enabled: true };
}

export function RunsPanel({ project, machineId, version, onOpenSession, onError }: Props) {
  const [defs, setDefs] = useState<RunDefinition[]>([]);
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [draft, setDraft] = useState<RunInput | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const requestId = useRef(0);
  const load = useCallback(async () => {
    // Only the newest request may update the view (an older, slower one would show stale data).
    const id = ++requestId.current;
    const data = await window.ghost.runs.list(project.id);
    if (id !== requestId.current) return;
    setDefs(data.definitions);
    setRecords(data.records);
    setApproved(data.approved);
  }, [project.id]);

  useEffect(() => {
    load().catch(onError);
  }, [load, version, onError]);

  const run = (fn: () => Promise<unknown>) => void fn().then(load).catch(onError);

  const save = () => {
    if (!draft) return;
    run(async () => {
      await window.ghost.runs.save(draft);
      setDraft(null);
    });
  };

  const open = (r: RunRecord) => {
    setExpanded(expanded === r.id ? null : r.id);
    if (!r.read && r.status !== "running") run(() => window.ghost.runs.markRead(project.id, r.id));
  };

  const s = draft?.schedule;
  const setSchedule = (schedule: RunSchedule) => draft && setDraft({ ...draft, schedule });

  return (
    <div className="past">
      <div className="panel-head">
        <h2>Scheduled runs</h2>
        <button className="primary" onClick={() => setDraft(emptyDraft(project.id))} disabled={!project.primaryPath}>
          New run
        </button>
      </div>
      {!project.primaryPath && <p className="faint">Add a folder to this project first; runs need a folder to work in.</p>}

      {draft && s && (
        <div className="card form">
          <input placeholder="Name, e.g. Monday outreach digest" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <textarea
            rows={5}
            placeholder="What Claude should do each time. It runs unattended, so say what to produce and where to put it."
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
          <div className="row">
            <select
              value={s.kind}
              onChange={(e) => {
                const kind = e.target.value as RunSchedule["kind"];
                const time = "time" in s ? s.time : DEFAULT_TIME;
                setSchedule(
                  kind === "interval"
                    ? { kind, everyMinutes: DEFAULT_INTERVAL_MIN }
                    : kind === "weekly"
                      ? { kind, days: WEEKDAYS, time }
                      : kind === "cron"
                        ? { kind, expr: DEFAULT_CRON }
                        : kind === "once"
                          ? { kind, at: new Date(Date.now() + 60 * 60_000).toISOString() }
                          : { kind, time },
                );
              }}
            >
              <option value="daily">Daily</option>
              <option value="weekly">On days</option>
              <option value="interval">Every…</option>
              <option value="cron">Cron</option>
              <option value="once">Once</option>
            </select>
            {s.kind === "interval" && (
              <>
                <input type="number" min={5} step={5} value={s.everyMinutes} onChange={(e) => setSchedule({ ...s, everyMinutes: Number(e.target.value) })} style={{ width: 90 }} />
                <span className="dim">minutes</span>
              </>
            )}
            {(s.kind === "daily" || s.kind === "weekly") && <input type="time" value={s.time} onChange={(e) => setSchedule({ ...s, time: e.target.value })} />}
            {s.kind === "cron" && (
              <>
                <input className="mono" value={s.expr} onChange={(e) => setSchedule({ ...s, expr: e.target.value })} style={{ width: 150 }} title="minute hour day-of-month month day-of-week" />
                <select value={s.tz ?? localTimeZone()} onChange={(e) => setSchedule({ ...s, tz: e.target.value === localTimeZone() ? undefined : e.target.value })}>
                  {zoneChoices(s.tz).map((z) => (
                    <option key={z} value={z}>{z === localTimeZone() ? `${z} (this Mac)` : z}</option>
                  ))}
                </select>
                <span className="faint">{describeSchedule(s)}</span>
              </>
            )}
            {s.kind === "once" && (
              <input
                type="datetime-local"
                value={toLocalInput(s.at)}
                onChange={(e) => e.target.value && setSchedule({ kind: "once", at: new Date(e.target.value).toISOString() })}
              />
            )}
          </div>
          {s.kind === "weekly" && (
            <div className="row">
              {DAY_NAMES.map((name, day) => (
                <label key={day} className="check">
                  <input
                    type="checkbox"
                    checked={s.days.includes(day)}
                    onChange={(e) => setSchedule({ ...s, days: e.target.checked ? [...s.days, day] : s.days.filter((d) => d !== day) })}
                  />
                  {name}
                </label>
              ))}
            </div>
          )}
          <div className="row">
            <select value={draft.model ?? ""} onChange={(e) => setDraft({ ...draft, model: e.target.value || undefined })}>
              {MODEL_CHOICES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <select value={draft.permissionMode} onChange={(e) => setDraft({ ...draft, permissionMode: e.target.value as PermissionMode })}>
              {PERMISSIONS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <select value={draft.folder ?? ""} onChange={(e) => setDraft({ ...draft, folder: e.target.value || undefined })}>
              <option value="">{project.localFolders.find((f) => f.path === project.primaryPath)?.label ?? "Main folder"}</option>
              {project.localFolders.filter((f) => f.exists && f.path !== project.primaryPath).map((f) => (
                <option key={f.path} value={f.path}>{f.label}</option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="hint">Runs on this Mac with your subscription. The budget guard can switch it to a cheaper model or skip it when usage is high.</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => setDraft(null)}>Cancel</button>
            <button className="primary" onClick={save} disabled={!draft.name.trim() || !draft.prompt.trim()}>
              Save run
            </button>
          </div>
        </div>
      )}

      {defs.map((d) => (
        <div key={d.id} className="card">
          <div className="row">
            <strong>{d.name}</strong>
            <span className="dim">{describeSchedule(d.schedule)}</span>
            <span className="faint">{d.model ?? "default model"} · {d.permissionMode}</span>
            {d.runOn !== machineId && (
              <>
                <span className="badge">runs on another Mac</span>
                <button
                  title="Run this on this Mac from now on instead"
                  onClick={() => window.confirm(`Move "${d.name}" to run on this Mac? It stops running on the other one. Check its prompt, then press "Approve to run on this Mac".`) && run(() => window.ghost.machine.moveRunHere(project.id, d.id))}
                >
                  Move to this Mac
                </button>
              </>
            )}
            {d.runOn === machineId && !approved[d.id] && (
              <button className="primary" title="This run was added or changed on another Mac; it won't run here until you approve it" onClick={() => run(() => window.ghost.runs.approve(project.id, d.id))}>
                Approve to run on this Mac
              </button>
            )}
            <span style={{ flex: 1 }} />
            <label className="check" title="Enabled">
              <input type="checkbox" checked={d.enabled} onChange={(e) => run(() => window.ghost.runs.save({ ...d, enabled: e.target.checked }))} />
              On
            </label>
            <button onClick={() => run(() => window.ghost.runs.runNow(project.id, d.id))}>Run now</button>
            <button className="ghost" onClick={() => setDraft({ ...d })}>Edit</button>
            <button
              className="ghost danger"
              onClick={() => window.confirm(`Delete the run "${d.name}"? Its history stays.`) && run(() => window.ghost.runs.remove(project.id, d.id))}
            >
              Delete
            </button>
          </div>
          {d.importedFrom && (
            <div className="hint">
              Moved from {d.importedFrom.kind === "cloud-routine" ? "a claude.ai routine" : "a Claude desktop scheduled task"} ("{d.importedFrom.name}").
              {d.importedFrom.connectors?.length ? ` Uses ${d.importedFrom.connectors.join(", ")}.` : ""}
              {!d.enabled && " Switch it on when you've turned the original off, so it doesn't run twice."}
            </div>
          )}
          <div className="faint run-prompt">{d.prompt}</div>
        </div>
      ))}
      {!defs.length && !draft && <p className="faint">No scheduled runs yet.</p>}

      <h2 style={{ marginTop: 22 }}>History</h2>
      {!records.length && <p className="faint">Runs will show here with their results.</p>}
      {records.map((r) => (
        <div key={r.id} className={`card run-record ${r.read || r.status === "running" ? "" : "unread"}`}>
          <button className="past-item" onClick={() => open(r)}>
            <span>
              <span className={`badge ${r.status}`}>{r.status}</span> {r.name}
              {r.trigger === "manual" && <span className="faint"> · manual</span>}
            </span>
            <span className="faint">
              {when(r.startedAt)}
              {r.costUsd ? ` · ~$${r.costUsd.toFixed(2)} API-equivalent` : ""}
            </span>
          </button>
          {r.note && <div className="hint">{r.note}</div>}
          {expanded === r.id && (
            <div className="run-result">
              <div className="msg-assistant">{r.resultText || <span className="faint">No output.</span>}</div>
              {r.sessionId && (
                <button onClick={() => onOpenSession(r.sessionId!, `Run: ${r.name}`)}>Open this run's session</button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
