// A project as seen from this Mac: which of its folders exist here, and where new work starts.
import fs from "node:fs";
import path from "node:path";
import type { Project, ProjectView, RunDefinition } from "../../shared/types";

export function toView(project: Project, machineId: string): ProjectView {
  const localFolders = project.folders
    .map((f) => ({ label: f.label ?? "", path: f.paths[machineId] ?? "" }))
    .filter((f) => f.path)
    .map((f) => ({ ...f, label: f.label || path.basename(f.path), exists: fs.existsSync(f.path) }));
  return { ...project, localFolders, primaryPath: localFolders.find((f) => f.exists)?.path };
}

/**
 * The folder a run uses on this Mac: its own folder if it has one, else the project's primary folder.
 * A run whose own folder is missing gets none (and fails with a note) rather than running somewhere else.
 */
export function runFolder(def: RunDefinition, project: Project | undefined, machineId: string): string | undefined {
  if (def.folder) return fs.existsSync(def.folder) ? def.folder : undefined;
  return project ? toView(project, machineId).primaryPath : undefined;
}
