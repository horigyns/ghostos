import { useEffect, useState } from "react";
import type { RunnerStatus } from "../../shared/api";
import type { BrainSettings, SyncStatus } from "../../shared/types";

const DEFAULT_REPO_NAME = "GhostOS-brain";

/** Syncing the brain folder between Macs through a private git remote. */
function BrainSyncSection({ onError }: { onError: (err: unknown) => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [url, setUrl] = useState("");
  const [repoName, setRepoName] = useState(DEFAULT_REPO_NAME);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.ghost.sync.status().then(setStatus).catch(onError);
    return window.ghost.on.syncChanged(setStatus);
  }, [onError]);

  const run = async (fn: () => Promise<SyncStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    const ok = window.confirm(
      `Create a private GitHub repository "${repoName}" with your GitHub CLI login, and push your brain (projects, rules, briefs, notes) to it?`,
    );
    if (ok) void run(() => window.ghost.sync.createGithub(repoName.trim()));
  };

  if (!status) return <p className="hint">Checking sync…</p>;
  if (status.remote) {
    return (
      <>
        <p className="hint">
          Syncs with <span className="mono">{status.remote}</span> every 5 minutes and shortly after changes.
          {status.lastSyncAt ? ` Last sync ${new Date(status.lastSyncAt).toLocaleString()}.` : ""}
          {status.ahead ? ` ${status.ahead} change(s) waiting to upload.` : ""}
        </p>
        {status.error && <p className="hint" style={{ color: "var(--bad)" }}>{status.error}</p>}
        <div className="row">
          <button disabled={busy} onClick={() => void run(() => window.ghost.sync.now())}>{busy ? "Syncing…" : "Sync now"}</button>
        </div>
      </>
    );
  }
  return (
    <>
      <p className="hint">
        Keep the brain in a private git repository so your MacBook sees the same projects, rules, runs and notes. On the other Mac,
        clone it to ~/GhostOS-brain before opening GhostOS there. Folder locations are kept per Mac.
      </p>
      {status.error && <p className="hint" style={{ color: "var(--bad)" }}>{status.error}</p>}
      <div className="row">
        <input value={repoName} onChange={(e) => setRepoName(e.target.value)} style={{ width: 200 }} />
        <button disabled={busy || !repoName.trim()} onClick={create}>Create private GitHub repo</button>
      </div>
      <div className="row">
        <input placeholder="or an existing repo: git@github.com:you/brain.git" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button disabled={busy || !url.trim()} onClick={() => void run(() => window.ghost.sync.connect(url.trim()))}>Connect</button>
      </div>
    </>
  );
}

interface Props {
  settings: BrainSettings;
  onClose: () => void;
  onError: (err: unknown) => void;
}

function NumberField({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint: string }) {
  return (
    <label className="setting">
      <span>{label}</span>
      <span className="row">
        <input type="number" min={1} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: 70 }} />
        <span className="dim">%</span>
      </span>
      <span className="hint">{hint}</span>
    </label>
  );
}

/** Ghost, budget guard thresholds, how briefs update, the background runner and sync. */
export function SettingsDialog({ settings, onClose, onError }: Props) {
  const [draft, setDraft] = useState<BrainSettings>(settings);
  const [runner, setRunner] = useState<RunnerStatus | null>(null);
  const budget = draft.budget;
  const setBudget = (patch: Partial<BrainSettings["budget"]>) => setDraft({ ...draft, budget: { ...budget, ...patch } });
  const ghost = draft.ghost;
  const setGhost = (patch: Partial<BrainSettings["ghost"]>) => setDraft({ ...draft, ghost: { ...ghost, ...patch } });

  useEffect(() => {
    window.ghost.settings.runnerStatus().then(setRunner).catch(onError);
  }, [onError]);

  const save = async () => {
    try {
      await window.ghost.settings.save(draft);
      onClose();
    } catch (err) {
      onError(err);
    }
  };

  const toggleRunner = async (enabled: boolean) => {
    try {
      setRunner(await window.ghost.settings.setRunner(enabled));
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-body">
          <h2>Ghost</h2>
          <p className="hint">Ghost watches every project for unfinished work and tells you when something stalls.</p>
          <label className="setting check">
            <input type="checkbox" checked={ghost.enabled} onChange={(e) => setGhost({ enabled: e.target.checked })} />
            <span>Track open loops in every project</span>
            <span className="hint">Open threads from session summaries, uncommitted or unpushed work, unmerged branches, failed runs, saved notes.</span>
          </label>
          <label className="setting">
            <span>A project is stalled after</span>
            <span className="row">
              <input type="number" min={1} max={60} value={ghost.stallDays} onChange={(e) => setGhost({ stallDays: Number(e.target.value) })} style={{ width: 70 }} />
              <span className="dim">days without activity</span>
            </span>
          </label>
          <label className="setting check">
            <input type="checkbox" checked={ghost.notifications} onChange={(e) => setGhost({ notifications: e.target.checked })} />
            <span>Notify me when a project stalls</span>
            <span className="hint">
              Reminds again every{" "}
              <input type="number" min={1} max={30} value={ghost.remindEveryDays} onChange={(e) => setGhost({ remindEveryDays: Number(e.target.value) })} style={{ width: 56 }} />{" "}
              days. Quiet from{" "}
              <input type="number" min={0} max={23} value={ghost.quietFrom} onChange={(e) => setGhost({ quietFrom: Number(e.target.value) })} style={{ width: 56 }} /> to{" "}
              <input type="number" min={0} max={23} value={ghost.quietTo} onChange={(e) => setGhost({ quietTo: Number(e.target.value) })} style={{ width: 56 }} /> h
              (same number: never quiet).
            </span>
          </label>
          <label className="setting check">
            <input type="checkbox" checked={ghost.autoSummarize} onChange={(e) => setGhost({ autoSummarize: e.target.checked })} />
            <span>Summarize sessions from VS Code, the terminal and the Claude app</span>
            <span className="hint">After 45 quiet minutes, on Haiku, at most 3 per half hour, within the budget guard. Summaries feed Ghost and close threads a later session finished.</span>
          </label>
          <label className="setting">
            <span>Daily digest from Claude at</span>
            <span className="row">
              <input type="time" value={ghost.digestTime} onChange={(e) => setGhost({ digestTime: e.target.value })} />
              {ghost.digestTime && <button className="ghost" onClick={(e) => { e.preventDefault(); setGhost({ digestTime: "" }); }}>Off</button>}
            </span>
            <span className="hint">One short Sonnet call a day: what's slipping and what to pick up next. Empty: no digest.</span>
          </label>

          <h2>Budget guard</h2>
          <p className="hint">Applies to background work (scheduled runs and session summaries), using the usage your chats report. Runs you start yourself aren't blocked.</p>
          <NumberField label="Switch runs to a cheaper model at weekly usage" value={budget.downgradeAboveWeekPct} onChange={(n) => setBudget({ downgradeAboveWeekPct: n })} hint="" />
          <label className="setting">
            <span>Cheaper model</span>
            <select value={budget.downgradeModel} onChange={(e) => setBudget({ downgradeModel: e.target.value as "sonnet" | "haiku" })}>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
            <span className="hint" />
          </label>
          <NumberField label="Wait for the 5-hour window to reset at" value={budget.pauseAboveFiveHourPct} onChange={(n) => setBudget({ pauseAboveFiveHourPct: n })} hint="" />
          <NumberField label="Pause background work at weekly usage" value={budget.pauseAboveWeekPct} onChange={(n) => setBudget({ pauseAboveWeekPct: n })} hint="" />

          <h2>Project briefs</h2>
          <label className="setting check">
            <input type="checkbox" checked={draft.autoApplyBriefs} onChange={(e) => setDraft({ ...draft, autoApplyBriefs: e.target.checked })} />
            <span>Update briefs automatically</span>
            <span className="hint">Off: Claude proposes each change and you approve it in the Memory tab.</span>
          </label>

          <h2>Background runner</h2>
          <label className="setting check">
            <input type="checkbox" checked={runner?.installed ?? false} disabled={!runner} onChange={(e) => void toggleRunner(e.target.checked)} />
            <span>Run scheduled jobs while GhostOS is closed</span>
            <span className="hint">
              A small launchd job on this Mac checks every 5 minutes. While GhostOS is open it also checks every minute.
              {runner?.lastTickAt ? ` Last check: ${new Date(runner.lastTickAt).toLocaleString()}.` : ""}
            </span>
          </label>

          <h2>Sync between Macs</h2>
          <BrainSyncSection onError={onError} />
        </div>
        <div className="palette-foot">
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()}>Save</button>
        </div>
      </div>
    </div>
  );
}
