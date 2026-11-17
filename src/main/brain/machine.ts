// A stable id for this Mac, so the brain can store per-machine folder paths
// (hostnames change; this id doesn't).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface Machine {
  id: string;
  name: string;
}

export function loadMachine(appDataDir: string): Machine {
  const file = path.join(appDataDir, "machine.json");
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as Machine;
      if (data.id) return data;
    } catch (err) {
      console.warn(`[machine] machine.json unreadable, creating a new id: ${(err as Error).message}`);
    }
  }
  const machine = { id: crypto.randomUUID(), name: os.hostname().replace(/\.local$/, "") };
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(machine, null, 2));
  return machine;
}
