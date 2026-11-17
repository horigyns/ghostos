import { useState } from "react";
import type { Area, FolderSuggestion, ProjectView } from "../../shared/types";
import { Menu, type MenuItem } from "./Menu";
import { usePrompt } from "./Prompt";

interface Props {
  project: ProjectView;
  areas: Area[];
  machineId: string;
  /** starts a Claude Code session in the terminal view */
  onNewCodingSession: () => void;
  /** opens the design systems dialog, on this one if given */
  onOpenDesign: (id?: string) => void;
  onError: (err: unknown) => void;
}

/** A project's ⋯ menu (folders, design systems, rename, area, archive) and the dialogs it opens. */
export function ProjectMenu({ project, areas, machineId, onNewCodingSession, onOpenDesign, onError }: Props) {
  const ask = usePrompt();
  const run = (fn: () => Promise<unknown>) => void fn().catch(onError);
  const [dialog, setDialog] = useState<"folders" | "area" | null>(null);

  const rename = async () => {
    const name = await ask("Rename project", project.name);
    if (name && name !== project.name) run(() => window.ghost.projects.update(project.id, { name }));
  };
  const newChatFolder = async () => {
    const name = await ask("New chat folder name");
    if (name) run(() => window.ghost.organize.createFolder(project.id, name));
  };
  const openDesign = () =>
    run(async () => {
      const linked = (await window.ghost.design.list()).find((d) => d.projects.includes(project.id) || d.areas.includes(project.area));
      onOpenDesign(linked?.id);
    });
  const archive = () =>
    window.confirm(
      `Archive "${project.name}"?\n\nIt leaves its area, its scheduled runs stop, Ghost stops tracking it and Claude sessions in its folders no longer get its rules. Its chats, notes and history stay; restore it any time from Archived at the bottom of Projects.`,
    ) && run(() => window.ghost.projects.update(project.id, { archived: true }));

  const actions: MenuItem[] = [
    { label: "Rename…", onClick: () => void rename() },
    { label: "Move to area…", onClick: () => setDialog("area") },
    { label: "Folders…", onClick: () => setDialog("folders") },
    { label: "Design systems…", onClick: openDesign },
    "-",
    { label: "New coding session", disabled: !project.primaryPath, title: "A Claude Code session in the terminal view", onClick: onNewCodingSession },
    { label: "New chat folder", onClick: () => void newChatFolder() },
    "-",
    project.archived
      ? { label: "Restore project", onClick: () => run(() => window.ghost.projects.update(project.id, { archived: false })) }
      : { label: "Archive", danger: true, onClick: archive },
  ];

  return (
    <>
      <Menu
        trigger={(toggle) => (
          <button className="icon-btn big" title="Project actions" onClick={toggle}>
            ⋯
          </button>
        )}
        items={actions}
      />
      {dialog === "folders" && <FoldersDialog project={project} machineId={machineId} onClose={() => setDialog(null)} onError={onError} />}
      {dialog === "area" && (
        <div className="overlay" onMouseDown={() => setDialog(null)}>
          <div className="palette small-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && setDialog(null)}>
            <div className="dialog-head">Move {project.name} to…</div>
            <div className="palette-list">
              {areas.map((a) => (
                <button
                  key={a.id}
                  autoFocus={a.id === project.area}
                  className={`palette-item ${a.id === project.area ? "selected" : ""}`}
                  onClick={() => {
                    setDialog(null);
                    if (a.id !== project.area) run(() => window.ghost.projects.update(project.id, { area: a.id }));
                  }}
                >
                  <span>{a.name}</span>
                  {a.id === project.area && <span className="faint">current</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The project's folders on this Mac: add, remove, and find ones it has on another Mac. */
function FoldersDialog({ project, machineId, onClose, onError }: { project: ProjectView; machineId: string; onClose: () => void; onError: (err: unknown) => void }) {
  const run = (fn: () => Promise<unknown>) => void fn().catch(onError);
  const [suggestions, setSuggestions] = useState<FolderSuggestion[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Folders the project has on another Mac but not (or not found) here.
  const missingHere = project.folders.filter((f) => !f.paths[machineId] || !project.localFolders.some((l) => l.path === f.paths[machineId] && l.exists));
  const findHere = async () => {
    setSearching(true);
    try {
      setSuggestions(await window.ghost.machine.suggestFolders(project.id));
    } catch (err) {
      onError(err);
    } finally {
      setSearching(false);
    }
  };
  const link = (s: FolderSuggestion) =>
    run(async () => {
      await window.ghost.machine.linkFolder(project.id, s.folderIndex, s.path);
      setSuggestions((prev) => prev?.filter((x) => x.folderIndex !== s.folderIndex) ?? null);
    });

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette small-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <div className="dialog-head">Folders · {project.name}</div>
        <div className="dialog-body">
          {!project.localFolders.length && <p className="faint">No folder on this Mac yet. Claude needs one to work in.</p>}
          {project.localFolders.map((f) => (
            <div key={f.path} className={`folder-line ${f.exists ? "" : "missing"}`}>
              <span className="folder-label">{f.label}</span>
              <span className="mono faint ellipsis" title={f.path}>{f.path.replace(/^\/Users\/[^/]+/, "~")}</span>
              <span className="grow" />
              <button
                className="link-btn danger"
                title="Remove this folder from the project (the folder itself is not touched)"
                onClick={() => {
                  if (window.confirm(`Remove ${f.path} from ${project.name}? The folder itself stays on disk.`)) run(() => window.ghost.projects.removeFolder(project.id, f.path));
                }}
              >
                Remove
              </button>
            </div>
          ))}
          {suggestions && (
            <div className="suggestions">
              {!suggestions.length && <span className="hint">Nothing found in your usual folders or iCloud Drive. Use Add folder to pick it.</span>}
              {suggestions.map((s) => (
                <div key={`${s.folderIndex}:${s.path}`} className="suggestion">
                  <strong>{s.label}</strong>
                  <span className="mono ellipsis" title={s.path}>{s.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                  <span className="faint">matched by {s.reason}</span>
                  <button onClick={() => link(s)}>Use this</button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="palette-foot">
          <button onClick={() => run(() => window.ghost.projects.addFolder(project.id))}>Add folder…</button>
          {missingHere.length > 0 && (
            <button className="ghost" disabled={searching} title="Look for this project's folders on this Mac, by git remote or name" onClick={() => void findHere()}>
              {searching ? "Looking…" : "Find on this Mac"}
            </button>
          )}
          <span className="grow" />
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
