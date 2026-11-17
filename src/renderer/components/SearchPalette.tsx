import { useEffect, useRef, useState } from "react";
import type { ProjectView, SearchHit } from "../../shared/types";

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  session: "Session",
  sidenote: "Sidenote",
  idea: "Idea",
  brief: "Brief",
  summary: "Summary",
  run: "Run",
};

interface Props {
  projects: ProjectView[];
  currentProjectId: string | null;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}

/** ⌘F: search sessions, sidenotes, ideas, briefs, summaries and run results. */
export function SearchPalette({ projects, currentProjectId, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "project">(currentProjectId ? "project" : "all");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(projects.map((p) => [p.id, p.name]));

  const latest = useRef(0);
  const run = async (text = query, where = scope) => {
    if (text.trim().length < 2) return;
    // Only the newest search may show results; an older, slower one is ignored.
    const id = ++latest.current;
    setBusy(true);
    setError(null);
    try {
      const found = await window.ghost.search(text, where === "project" ? currentProjectId : null);
      if (id === latest.current) setHits(found);
    } catch (err) {
      if (id === latest.current) setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      if (id === latest.current) setBusy(false);
    }
  };

  // Changing the scope re-runs the current search (only the scope triggers it).
  useEffect(() => void (hits !== null && run(query, scope)), [scope]);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Search sessions, sidenotes, ideas, briefs, runs…  (Enter)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") void run();
          }}
        />
        <div className="palette-foot">
          <div className="segmented">
            <button className={scope === "project" ? "on" : ""} disabled={!currentProjectId} onClick={() => setScope("project")}>This project</button>
            <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>All projects</button>
          </div>
          <span className="faint">{busy ? "Searching…" : hits ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : ""}</span>
        </div>
        <div className="palette-list">
          {error && <div className="msg-error" style={{ padding: 10 }}>{error}</div>}
          {hits?.map((h, i) => (
            <button key={i} className="palette-item hit" onClick={() => onOpen(h)}>
              <span className="hit-head">
                <span className="badge">{KIND_LABEL[h.kind]}</span> <strong>{h.title}</strong>
                <span className="faint"> · {h.projectId ? names.get(h.projectId) ?? "" : "Unsorted"}{h.at ? ` · ${new Date(h.at).toLocaleDateString()}` : ""}</span>
              </span>
              <span className="dim snippet">{h.snippet}</span>
            </button>
          ))}
          {hits && !hits.length && <div className="faint" style={{ padding: 10 }}>Nothing found.</div>}
        </div>
      </div>
    </div>
  );
}
