import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportMemoryItem, ImportResult, ImportRunItem, ImportScan } from "../../shared/api";
import { ME_SCOPE, type ProjectView } from "../../shared/types";

type Tab = "memory" | "runs";

interface Props {
  projects: ProjectView[];
  onClose: () => void;
  onDone: (result: ImportResult) => void;
  onError: (err: unknown) => void;
}

const STATUS_LABEL: Record<ImportMemoryItem["status"], string> = { new: "", imported: "already in GhostOS", changed: "newer than GhostOS's copy" };

function TargetSelect({ value, projects, allowMe, onChange }: { value: string; projects: ProjectView[]; allowMe: boolean; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={value ? "" : "needs-choice"}>
      <option value="">Choose…</option>
      {allowMe && <option value={ME_SCOPE}>About you (every project)</option>}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}

/**
 * Brings Claude's memory notes, desktop scheduled tasks and claude.ai routines into GhostOS.
 * Copies only: nothing in Claude, the desktop app or claude.ai is changed. Imported runs arrive switched off.
 */
export function ImportDialog({ projects, onClose, onDone, onError }: Props) {
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [tab, setTab] = useState<Tab>("memory");
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // The scan runs once; a changing onError must not rescan and reset the user's choices.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    window.ghost.importer
      .scan()
      .then((s) => {
        setScan(s);
        const all = [...s.memory, ...s.runs];
        setPicked(Object.fromEntries(all.map((i) => [i.key, i.selected])));
        setTargets(Object.fromEntries(all.map((i) => [i.key, i.target])));
        if (!s.memory.length && s.runs.length) setTab("runs");
      })
      .catch((err) => onErrorRef.current(err));
  }, []);

  const groups = useMemo(() => {
    const out = new Map<string, ImportMemoryItem[]>();
    for (const item of scan?.memory ?? []) out.set(item.sourceLabel, [...(out.get(item.sourceLabel) ?? []), item]);
    return [...out.entries()];
  }, [scan]);

  if (!scan) {
    return (
      <div className="overlay" onMouseDown={onClose}>
        <div className="palette capabilities" onMouseDown={(e) => e.stopPropagation()}>
          <div className="cap-body"><p className="faint">Looking at what Claude has…</p></div>
        </div>
      </div>
    );
  }

  const chosen = <T extends { key: string }>(items: T[]) => items.filter((i) => picked[i.key]);
  const memoryChosen = chosen(scan.memory);
  const runsChosen = chosen(scan.runs.filter((r) => r.importable));
  const missingTarget = [...memoryChosen, ...runsChosen].filter((i) => !targets[i.key]).length;
  const setGroup = (items: { key: string }[], on: boolean) => setPicked((prev) => ({ ...prev, ...Object.fromEntries(items.map((i) => [i.key, on])) }));
  const setTarget = (key: string, value: string) => {
    setTargets((prev) => ({ ...prev, [key]: value }));
    if (value) setPicked((prev) => ({ ...prev, [key]: true }));
  };
  const setGroupTarget = (items: { key: string }[], value: string) => {
    setTargets((prev) => ({ ...prev, ...Object.fromEntries(items.map((i) => [i.key, value])) }));
  };

  const apply = () => {
    setBusy(true);
    window.ghost.importer
      .apply({
        memory: memoryChosen.map((i) => ({ key: i.key, target: targets[i.key] })),
        runs: runsChosen.map((i) => ({ key: i.key, target: targets[i.key] })),
      })
      .then(onDone)
      .catch((err) => {
        setBusy(false);
        onError(err);
      });
  };

  const runRow = (r: ImportRunItem) => (
    <div key={r.key} className={`card import-item ${picked[r.key] ? "picked" : ""}`}>
      <div className="row">
        <label className="check">
          <input type="checkbox" disabled={!r.importable || r.status === "imported"} checked={Boolean(picked[r.key])} onChange={(e) => setPicked({ ...picked, [r.key]: e.target.checked })} />
          <strong>{r.name}</strong>
        </label>
        <span className="badge">{r.kind === "cloud-routine" ? "claude.ai routine" : "desktop task"}</span>
        {r.status === "imported" && <span className="badge">already in GhostOS</span>}
        {!r.enabledThere && <span className="faint">off there</span>}
        <span style={{ flex: 1 }} />
        <TargetSelect value={targets[r.key] ?? ""} projects={projects} allowMe={false} onChange={(v) => setTarget(r.key, v)} />
      </div>
      <div className="row dim" style={{ fontSize: 12 }}>
        <span>{r.scheduleText}</span>
        {r.model && <span className="faint">{r.model}</span>}
        <span className="faint">Auto permissions</span>
        {!!r.connectors.length && <span className="faint">uses {r.connectors.join(", ")}</span>}
      </div>
      <div className="faint run-prompt">{r.promptPreview}</div>
    </div>
  );

  return (
    <div className="overlay" onMouseDown={() => !busy && onClose()}>
      <div className="palette capabilities" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="project-tabs">
          <button className={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}>
            Memory <span className="faint">{memoryChosen.length}/{scan.memory.length}</span>
          </button>
          <button className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>
            Scheduled runs <span className="faint">{runsChosen.length}/{scan.runs.length}</span>
          </button>
        </nav>
        <div className="cap-body">
          {tab === "memory" && (
            <>
              <p className="hint">
                Notes Claude Code saved in each folder (~/.claude/projects/…/memory), plus your global CLAUDE.md. They're copied into the brain, so
                they show in each project's Memory tab and reach the other Mac. Notes from your home folder become notes about you. Anything that
                looks like it holds a password or key is left unticked.
              </p>
              {!groups.length && <p className="faint">Claude hasn't saved any memory notes on this Mac.</p>}
              {groups.map(([label, items]) => {
                const target = items.every((i) => targets[i.key] === targets[items[0].key]) ? (targets[items[0].key] ?? "") : "";
                return (
                  <div key={label}>
                    <div className="row import-group">
                      <label className="check">
                        <input type="checkbox" checked={items.every((i) => picked[i.key])} onChange={(e) => setGroup(items, e.target.checked)} />
                        <strong className="mono">{label}</strong>
                      </label>
                      <span className="faint">{items.length} note{items.length === 1 ? "" : "s"}</span>
                      <span style={{ flex: 1 }} />
                      <TargetSelect value={target} projects={projects} allowMe onChange={(v) => setGroupTarget(items, v)} />
                    </div>
                    {items.map((i) => (
                      <label key={i.key} className={`import-note ${picked[i.key] ? "picked" : ""}`}>
                        <input type="checkbox" checked={Boolean(picked[i.key])} onChange={(e) => setPicked({ ...picked, [i.key]: e.target.checked })} />
                        <span className="ellipsis">
                          {i.name}
                          {i.description && <span className="faint"> · {i.description}</span>}
                        </span>
                        {i.secret && <span className="badge warn-badge">may contain a secret</span>}
                        {i.guessed && <span className="faint" title="Matched by folder name only; check the project">guessed project</span>}
                        {STATUS_LABEL[i.status] && <span className="faint">{STATUS_LABEL[i.status]}</span>}
                      </label>
                    ))}
                  </div>
                );
              })}
            </>
          )}

          {tab === "runs" && (
            <>
              <p className="hint">
                Imported runs arrive <strong>switched off</strong>, so nothing runs twice. Switch each one on in the project's Runs tab once you've
                turned off the original in claude.ai or the Claude app. They run on this Mac with your subscription; Claude Code here has the same
                claude.ai connectors.
              </p>
              {scan.routinesSavedAt ? (
                <p className="faint" style={{ fontSize: 12 }}>
                  claude.ai routines as of {new Date(scan.routinesSavedAt).toLocaleString()} (from {scan.routinesFile.replace(/^\/Users\/[^/]+/, "~")}).
                </p>
              ) : (
                <p className="faint" style={{ fontSize: 12 }}>
                  No claude.ai routines list yet. Ask Claude Code to save your routines list to {scan.routinesFile.replace(/^\/Users\/[^/]+/, "~")}, then open this again.
                </p>
              )}
              {!scan.runs.length && <p className="faint">Nothing scheduled to bring in.</p>}
              {scan.runs.map(runRow)}
            </>
          )}
        </div>
        <div className="palette-foot">
          {missingTarget > 0 && <span className="hint">Choose where {missingTarget} selected item{missingTarget === 1 ? " goes" : "s go"}.</span>}
          <span style={{ flex: 1 }} />
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={busy || missingTarget > 0 || !(memoryChosen.length + runsChosen.length)} onClick={apply}>
            {busy ? "Importing…" : `Import ${memoryChosen.length} note${memoryChosen.length === 1 ? "" : "s"} and ${runsChosen.length} run${runsChosen.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
