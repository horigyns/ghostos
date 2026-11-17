// App config (where the brain lives). Shared by the app and the background runner; no Electron here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  brainDir: string;
}

export const DEFAULT_BRAIN_DIR = path.join(os.homedir(), "GhostOS-brain");

export function loadConfig(appData: string): Config {
  const file = path.join(appData, "config.json");
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
      if (typeof data.brainDir === "string" && path.isAbsolute(data.brainDir)) return { brainDir: data.brainDir };
      console.warn("[config] brainDir must be an absolute path; using the default");
    } catch (err) {
      console.warn(`[config] config.json unreadable, using defaults: ${(err as Error).message}`);
    }
    return { brainDir: DEFAULT_BRAIN_DIR };
  }
  const config = { brainDir: DEFAULT_BRAIN_DIR };
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return config;
}
