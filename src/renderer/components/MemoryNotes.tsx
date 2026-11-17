import { useCallback, useEffect, useState } from "react";
import { ME_SCOPE, type MemoryNote } from "../../shared/types";

interface ListProps {
  /** a project id, or "me" */
  scope: string;
  notes: MemoryNote[];
  empty: string;
  onChanged: () => void;
  onError: (err: unknown) => void;
}

/** Notes imported from Claude's memory: one line each, expandable to the full note. */
export function MemoryNotes({ scope, notes, empty, onChanged, onError }: ListProps) {
  const [open, setOpen] = useState<string | null>(null);
  if (!notes.length) return <p className="faint">{empty}</p>;
  const remove = (note: MemoryNote) => {
    if (!window.confirm(`Remove the note "${note.name}" from GhostOS? Claude's own copy (if any) stays.`)) return;
    void window.ghost.memory.removeNote(scope, note.file).then(onChanged).catch(onError);
  };
  return (
    <div className="note-cards">
      {notes.map((n) => (
        <div key={n.file} className={`card memory-note ${open === n.file ? "open" : ""}`}>
          <button className="past-item" onClick={() => setOpen(open === n.file ? null : n.file)}>
            <span>
              <strong>{n.name}</strong>
              {n.description && <span className="past-summary">{n.description}</span>}
            </span>
            <span className="faint">{open === n.file ? "▾" : "▸"}</span>
          </button>
          {open === n.file && (
            <>
              <pre className="brief-text">{n.content}</pre>
              <div className="row">
                <span className="faint mono">{n.file}</span>
                <span style={{ flex: 1 }} />
                <button className="ghost danger" onClick={() => remove(n)}>Remove</button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** Notes about the user, given to every project's Claude sessions. */
export function AboutYouNotes({ version, onError }: { version: number; onError: (err: unknown) => void }) {
  const [notes, setNotes] = useState<MemoryNote[] | null>(null);
  const load = useCallback(async () => setNotes(await window.ghost.memory.aboutMe()), []);
  useEffect(() => {
    load().catch(onError);
  }, [load, version, onError]);
  useEffect(() => window.ghost.on.memoryChanged((scope) => scope === ME_SCOPE && void load().catch(onError)), [load, onError]);
  if (!notes) return <p className="faint">Loading…</p>;
  return (
    <>
      <p className="hint">
        What Claude has learned about you, imported from Claude's memory. A one-line index of these goes to every Claude session in a
        GhostOS project (GhostOS, VS Code and the terminal); Claude reads a full note when it needs it.
      </p>
      <MemoryNotes scope={ME_SCOPE} notes={notes} empty="No notes about you yet. Use Import in the sidebar to bring them in from Claude." onChanged={() => void load().catch(onError)} onError={onError} />
    </>
  );
}
