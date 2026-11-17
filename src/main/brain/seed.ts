// First-run projects, sorted into areas. Only folders that exist on this Mac are attached;
// everything can be renamed, moved or deleted in the app afterwards.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrainStore } from "./store";
import { remoteOf } from "./git";

interface SeedProject {
  name: string;
  area: string;
  folders: string[]; // relative to the home folder
}

/** Projects to create on first run from folders that exist on this Mac. Empty: add your own projects in the app. */
const SEED_PROJECTS: SeedProject[] = [];

export async function seedProjects(store: BrainStore, machineId: string, home = os.homedir()): Promise<number> {
  let created = 0;
  for (const seed of SEED_PROJECTS) {
    const existing = seed.folders.map((f) => path.join(home, f)).filter((p) => fs.existsSync(p));
    if (!existing.length) continue;
    const folders = await Promise.all(
      existing.map(async (p) => ({ label: path.basename(p), remote: await remoteOf(p), paths: { [machineId]: p } })),
    );
    store.createProject({ name: seed.name, area: seed.area, folders });
    created++;
  }
  return created;
}
