import { useCallback, useEffect, useState } from "react";
import type { MemoryState } from "../../shared/api";
import type { ProjectView } from "../../shared/types";
import { MemoryNotes } from "./MemoryNotes";

interface Props {
  project: ProjectView;
  version: number;
  autoApply: boolean;
  capabilitiesVersion: number;
  onOpenSession: (sessionId: string, title: string) => void;
  onError: (err: unknown) => void;
}

/** The project's living brief (given to every new Claude session here) and its session summaries. */
/** The project's own rules, layered after the global and area rules, plus a preview of what a session starts with. */
function ProjectRules({ projectId, version, onError }: { projectId: string; version: number; onError: (err: unknown) => void }) {
  const [rules, setRules] = useState("");
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRules(await window.ghost.capabilities.projectRules(projectId));
    setDirty(false);
  }, [projectId]);
  useEffect(() => {
    if (!dirty) load().catch(onError);
    // `dirty` left out on purpose, as with the brief.
  }, [load, version, onError]);

  const save = () =>
    void window.ghost.capabilities
      .saveRules({ projectId }, rules)
      .then(load)
      .then(async () => {
        if (preview !== null) setPreview(await window.ghost.capabilities.previewContext(projectId));
      })
      .catch(onError);
  const togglePreview = () =>
    preview !== null ? setPreview(null) : void window.ghost.capabilities.previewContext(projectId).then(setPreview).catch(onError);

  return (
    <>
      <div className="panel-head" style={{ marginTop: 22 }}>
        <h2>Project rules</h2>
        <span className="hint">Added after the all-projects and area rules (Rules in the sidebar).</span>
      </div>
      <textarea
        className="brief-edit"
        rows={5}
        placeholder="Rules only for this project, e.g. deploy only from main; judge audits use rubric v2."
        value={rules}
        onChange={(e) => {
          setRules(e.target.value);
          setDirty(true);
        }}
      />
      <div className="row" style={{ marginTop: 6 }}>
        <button className="ghost" onClick={togglePreview}>{preview === null ? "Preview what a new session starts with" : "Hide preview"}</button>
        <span style={{ flex: 1 }} />
        <button disabled={!dirty} onClick={() => void load().catch(onError)}>Discard</button>
        <button className="primary" disabled={!dirty} onClick={save}>Save rules</button>
      </div>
      {preview !== null && <pre className="brief-text">{preview || "(nothing: no rules, agents or brief yet)"}</pre>}
    </>
  );
}

export function MemoryPanel({ project, version, autoApply, capabilitiesVersion, onOpenSession, onError }: Props) {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [brief, setBrief] = useState("");
  const [dirty, setDirty] = useState(false);
  const [proposalEdit, setProposalEdit] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await window.ghost.memory.get(project.id);
    setMemory(data);
    setBrief(data.brief);
    setDirty(false);
  }, [project.id]);

  useEffect(() => {
    if (!dirty) load().catch(onError);
    // `dirty` is left out on purpose: a background update mustn't overwrite text being edited;
    // it loads after saving or discarding.
  }, [load, version, onError]);

  // A newer proposal replaces any edit in progress of the old one.
  const proposalStamp = memory?.proposal?.createdAt;
  useEffect(() => setProposalEdit(null), [proposalStamp]);

  const run = (fn: () => Promise<unknown>) => void fn().then(load).catch(onError);
  if (!memory) return <div className="past faint">Loading…</div>;
  const proposal = memory.proposal;

  return (
    <div className="past">
      {proposal && (
        <div className="card proposal">
          <div className="row">
            <strong>Claude proposes an update to this brief</strong>
            <span className="faint">from a session on {new Date(proposal.createdAt).toLocaleDateString()}</span>
            {memory.briefChangedSinceProposal && <span className="badge">the brief changed since; check before accepting</span>}
            <span style={{ flex: 1 }} />
            {proposalEdit === null ? (
              <button className="ghost" onClick={() => setProposalEdit(proposal.text)}>Edit</button>
            ) : null}
            <button onClick={() => run(async () => { await window.ghost.memory.dismissProposal(project.id); setProposalEdit(null); })}>Dismiss</button>
            <button className="primary" onClick={() => run(async () => { await window.ghost.memory.acceptProposal(project.id, proposalEdit ?? undefined); setProposalEdit(null); })}>
              Accept
            </button>
          </div>
          <div className="compare">
            <div>
              <div className="hint">Current</div>
              <pre className="brief-text">{memory.brief || "(empty)"}</pre>
            </div>
            <div>
              <div className="hint">Proposed</div>
              {proposalEdit === null ? (
                <pre className="brief-text">{proposal.text}</pre>
              ) : (
                <textarea className="brief-edit" rows={14} value={proposalEdit} onChange={(e) => setProposalEdit(e.target.value)} />
              )}
            </div>
          </div>
        </div>
      )}

      <div className="panel-head">
        <h2>Project brief</h2>
        <span className="hint">
          Given to every new Claude session in {project.name}. Updated from finished sessions:{" "}
          {autoApply ? "automatically." : "Claude proposes, you approve."}
        </span>
      </div>
      <textarea
        className="brief-edit"
        rows={12}
        placeholder="Current state, key decisions, open threads… Leave empty and Claude will draft it after your next session here."
        value={brief}
        onChange={(e) => {
          setBrief(e.target.value);
          setDirty(true);
        }}
      />
      <div className="row" style={{ marginTop: 6 }}>
        <span style={{ flex: 1 }} />
        <button disabled={!dirty} onClick={() => void load().catch(onError)}>Discard</button>
        <button className="primary" disabled={!dirty} onClick={() => run(() => window.ghost.memory.saveBrief(project.id, brief))}>
          Save brief
        </button>
      </div>

      <ProjectRules projectId={project.id} version={capabilitiesVersion} onError={onError} />

      <div className="panel-head" style={{ marginTop: 22 }}>
        <h2>From Claude's memory</h2>
        <span className="hint">Notes Claude Code saved while working here, kept in the brain so the other Mac has them too.</span>
      </div>
      <MemoryNotes
        scope={project.id}
        notes={memory.claudeMemory}
        empty="None yet. Use Import in the sidebar to bring in what Claude has remembered about this project."
        onChanged={() => void load().catch(onError)}
        onError={onError}
      />

      <h2 style={{ marginTop: 22 }}>Session summaries</h2>
      {!memory.summaries.length && (
        <p className="faint">Sessions are summarized when you close their tab, or with “Summarize” in Past sessions.</p>
      )}
      {memory.summaries.map((s) => (
        <div key={s.sessionId} className="card">
          <div className="row">
            <strong>{s.title}</strong>
            <span className="faint">{new Date(s.createdAt).toLocaleDateString()}</span>
            <span style={{ flex: 1 }} />
            <button className="ghost" onClick={() => onOpenSession(s.sessionId, s.title)}>Open session</button>
          </div>
          <div>{s.summary}</div>
          {!!s.decisions.length && (
            <div className="hint">Decisions: {s.decisions.join(" · ")}</div>
          )}
          {!!s.openThreads.length && (
            <div className="hint">Open: {s.openThreads.join(" · ")}</div>
          )}
        </div>
      ))}
    </div>
  );
}
