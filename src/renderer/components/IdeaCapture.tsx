import { useState } from "react";
import type { ProjectView } from "../../shared/types";

interface Props {
  projects: ProjectView[];
  defaultProjectId: string | null;
  onClose: () => void;
  onError: (err: unknown) => void;
}

/** ⌘I: capture an idea from anywhere in the app, filed under a project or left unsorted. */
export function IdeaCapture({ projects, defaultProjectId, onClose, onError }: Props) {
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");

  const save = async () => {
    if (!text.trim()) return;
    try {
      await window.ghost.ideas.add(text, projectId || null);
      onClose();
    } catch (err) {
      onError(err);
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          rows={4}
          placeholder="Capture an idea…  (⌘Enter to save, Esc to cancel)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && e.metaKey) void save();
          }}
        />
        <div className="palette-foot">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Unsorted</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={!text.trim()}>
            Save idea
          </button>
        </div>
      </div>
    </div>
  );
}
