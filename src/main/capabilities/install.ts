// Applies GhostOS capabilities to this Mac's Claude Code config (~/.claude), and removes them again.
//
// - Hooks: GhostOS adds its own entries to ~/.claude/settings.json (marked with a trailing comment) next to
//   whatever the user already has. settings.json is backed up before every change, written atomically
//   through symlinks with its permissions kept, and never touched if it changed while GhostOS was writing.
// - Agents: the brain's agents are written to ~/.claude/agents/. A file GhostOS didn't write is never
//   overwritten (reported as a conflict) and never claimed, and on removal only files still exactly as
//   GhostOS wrote them are deleted. Ownership is tracked in a manifest in GhostOS's app data.
// Agents are written only when the user presses Apply/Update (or edits an agent in GhostOS); hooks are
// re-pointed automatically when the app moved.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentDoc, CapabilityFile, CapabilityPlan } from "../../shared/types";
import YAML from "yaml";
import { shellQuote } from "../sidenotes/inbox";

/** Ends every hook command GhostOS writes; how its entries are told apart from the user's. */
export const HOOK_MARK = "# GhostOS-managed hook";
const MANIFEST_FILE = "capabilities-manifest.json";
const BACKUPS_DIR = "backups";
const BACKUPS_KEPT = 10;
const GLOBAL_SCOPE = "global";
/** Seconds Claude Code waits for a GhostOS hook before going on without it. */
const HOOK_TIMEOUT_S = 10;

/** The hook events GhostOS registers, with matcher and command-argument filter where needed. */
const HOOK_EVENTS: { event: string; matcher?: string; if?: string }[] = [
  { event: "SessionStart" },
  { event: "PreToolUse", matcher: "Bash", if: "Bash(*git*commit*)" },
  { event: "Stop" },
  { event: "PostToolUseFailure", matcher: "Bash" },
];

interface Manifest {
  applied: boolean;
  /** agent file name -> sha256 of the content GhostOS wrote */
  agents: Record<string, string>;
}

interface HookHandler {
  type: string;
  command?: string;
  if?: string;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}
type Settings = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

const sha = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

export interface InstallPaths {
  /** ~/.claude */
  claudeDir: string;
  /** GhostOS app data (manifest, backups, hook config) */
  appData: string;
  /** node binary to run the hook with (Electron in Node mode) */
  nodeBinary: string;
  /** dist/hook/ghostos-hook.js */
  hookScript: string;
}

/** Where an agent from the brain lands: global agents keep their name, area agents get the area as prefix. */
export function agentFileName(agent: AgentDoc): string {
  return agent.scope === GLOBAL_SCOPE ? `${agent.name}.md` : `${agent.scope}-${agent.name}.md`;
}

/** Area agents say which projects they're for, since ~/.claude/agents applies to every project. */
export function agentFileContent(agent: AgentDoc, areaName?: string): string {
  const content = agent.content.replace(/\r\n/g, "\n");
  if (agent.scope === GLOBAL_SCOPE || !areaName) return content.trimEnd() + "\n";
  const name = `${agent.scope}-${agent.name}`;
  const note = `(For ${areaName} projects.)`;
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  let front: Record<string, unknown> = {};
  let body = content.trim();
  if (match) {
    try {
      const parsed = YAML.parse(match[1]) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
      body = content.slice(match[0].length).trim();
    } catch {
      // unreadable frontmatter: keep it in the body and write a fresh header
    }
  }
  const description = typeof front.description === "string" && front.description.trim() ? `${front.description.trim()} ${note}` : `For ${areaName} projects.`;
  const header = YAML.stringify({ ...front, name, description }, { lineWidth: 0 }).trimEnd();
  return `---\n${header}\n---\n\n${body}\n`;
}

export class CapabilityInstaller {
  constructor(private readonly paths: InstallPaths) {}

  private get settingsFile(): string {
    return path.join(this.paths.claudeDir, "settings.json");
  }

  private get agentsDir(): string {
    return path.join(this.paths.claudeDir, "agents");
  }

  /** Exits quietly if GhostOS was moved or deleted, so sessions never show hook errors. */
  hookCommand(): string {
    const [bin, script, data] = [this.paths.nodeBinary, this.paths.hookScript, this.paths.appData].map(shellQuote);
    return `[ -x ${bin} ] && [ -f ${script} ] || exit 0; ELECTRON_RUN_AS_NODE=1 ${bin} ${script} ${data} ${HOOK_MARK}`;
  }

  private readManifest(): Manifest {
    try {
      return { applied: false, agents: {}, ...(JSON.parse(fs.readFileSync(path.join(this.paths.appData, MANIFEST_FILE), "utf8")) as Partial<Manifest>) };
    } catch {
      return { applied: false, agents: {} };
    }
  }

  private writeManifest(manifest: Manifest): void {
    fs.mkdirSync(this.paths.appData, { recursive: true });
    const file = path.join(this.paths.appData, MANIFEST_FILE);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(manifest, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** The settings file itself (following a symlink, e.g. from a dotfiles repo). */
  private realSettingsFile(): string {
    try {
      return fs.realpathSync(this.settingsFile);
    } catch {
      return this.settingsFile;
    }
  }

  private readSettings(): Settings {
    if (!fs.existsSync(this.settingsFile)) return {};
    const text = fs.readFileSync(this.settingsFile, "utf8");
    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`~/.claude/settings.json isn't valid JSON (${(err as Error).message}); GhostOS won't change it.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("~/.claude/settings.json isn't a JSON object; GhostOS won't change it.");
    const settings = parsed as Settings;
    if (settings.hooks !== undefined && (typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
      throw new Error("The hooks in ~/.claude/settings.json aren't in the expected shape; GhostOS won't change them.");
    }
    return settings;
  }

  isApplied(): boolean {
    return this.readManifest().applied;
  }

  /** The user's settings with every GhostOS hook entry removed; everything else is left exactly as it was. */
  private withoutGhostHooks(settings: Settings): Settings {
    if (!settings.hooks) return settings;
    const ours = (h: HookHandler) => typeof h?.command === "string" && h.command.endsWith(HOOK_MARK);
    const hasOurs = (g: HookGroup) => Array.isArray(g?.hooks) && g.hooks.some(ours);
    const hooks: Record<string, HookGroup[]> = {};
    let changed = false;
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups) || !groups.some(hasOurs)) {
        hooks[event] = groups;
        continue;
      }
      changed = true;
      const kept = groups.flatMap((g) => {
        if (!hasOurs(g)) return [g];
        const rest = g.hooks!.filter((h) => !ours(h));
        return rest.length ? [{ ...g, hooks: rest }] : [];
      });
      if (kept.length) hooks[event] = kept;
    }
    if (!changed) return settings;
    const { hooks: _old, ...rest } = settings;
    return Object.keys(hooks).length ? { ...rest, hooks } : rest;
  }

  private withGhostHooks(settings: Settings): Settings {
    const base = this.withoutGhostHooks(settings);
    const hooks = { ...(base.hooks ?? {}) };
    for (const h of HOOK_EVENTS) {
      const handler: HookHandler = { type: "command", command: this.hookCommand(), timeout: HOOK_TIMEOUT_S };
      if (h.if) handler.if = h.if;
      const group: HookGroup = { hooks: [handler] };
      if (h.matcher) group.matcher = h.matcher;
      hooks[h.event] = [...(hooks[h.event] ?? []), group];
    }
    return { ...base, hooks };
  }

  /** What Apply would do now. */
  plan(agents: AgentDoc[], areaNames: Record<string, string>): CapabilityPlan {
    const manifest = this.readManifest();
    const files: CapabilityFile[] = [];
    const wanted = this.wantedAgents(agents, areaNames);
    for (const [name, content] of wanted) {
      const file = path.join(this.agentsDir, name);
      if (content === undefined) {
        files.push({ path: file, state: "conflict", note: "two brain agents would share this file name; rename one" });
        continue;
      }
      if (!fs.existsSync(file)) {
        files.push({ path: file, state: "write" });
        continue;
      }
      const current = fs.readFileSync(file, "utf8");
      const owned = manifest.agents[name] === sha(current);
      if (current === content) files.push({ path: file, state: "same", note: owned ? undefined : "your own identical file; left as yours" });
      else if (owned) files.push({ path: file, state: "write", note: "updated from the brain" });
      else files.push({ path: file, state: "conflict", note: "a file GhostOS didn't create is there; it is left alone" });
    }
    for (const name of Object.keys(manifest.agents)) {
      if (!wanted.has(name)) files.push({ path: path.join(this.agentsDir, name), state: "remove", note: "no longer in the brain" });
    }
    const settingsChange = JSON.stringify(this.withGhostHooks(this.readSettings())) !== JSON.stringify(this.readSettings());
    files.unshift({ path: this.settingsFile, state: settingsChange ? "write" : "same", note: "GhostOS hook entries only" });
    return { applied: manifest.applied, files, hookEvents: HOOK_EVENTS.map((h) => h.event) };
  }

  /** File name -> content for each brain agent; undefined marks two agents colliding on one file name. */
  private wantedAgents(agents: AgentDoc[], areaNames: Record<string, string>): Map<string, string | undefined> {
    const wanted = new Map<string, string | undefined>();
    for (const a of agents) {
      const name = agentFileName(a);
      wanted.set(name, wanted.has(name) ? undefined : agentFileContent(a, areaNames[a.scope]));
    }
    return wanted;
  }

  private backupSettings(): void {
    if (!fs.existsSync(this.settingsFile)) return;
    const dir = path.join(this.paths.appData, BACKUPS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(this.settingsFile, path.join(dir, `settings-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("settings-")).sort().slice(0, -BACKUPS_KEPT);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  }

  /**
   * Updates settings.json with `change`, only if the result differs. Reads, backs up and writes in one go,
   * refusing if the file changed in between (Claude Code also writes it), and keeps its permissions.
   */
  private updateSettings(change: (settings: Settings) => Settings): void {
    const target = this.realSettingsFile();
    const before = fs.existsSync(target) ? fs.statSync(target) : undefined;
    const settings = this.readSettings();
    const next = change(settings);
    if (JSON.stringify(next) === JSON.stringify(settings)) return;
    this.backupSettings();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.ghostos.tmp`;
    const fd = fs.openSync(tmp, "w", before ? before.mode & 0o777 : 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(next, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const now = fs.existsSync(target) ? fs.statSync(target) : undefined;
    if (now?.mtimeMs !== before?.mtimeMs || now?.size !== before?.size) {
      fs.rmSync(tmp, { force: true });
      throw new Error("~/.claude/settings.json changed while GhostOS was updating it. Nothing was written; try again.");
    }
    fs.renameSync(tmp, target);
  }

  apply(agents: AgentDoc[], areaNames: Record<string, string>): CapabilityPlan {
    this.updateSettings((s) => this.withGhostHooks(s));
    this.writeAgents(agents, areaNames);
    return this.plan(agents, areaNames);
  }

  /** Writes and removes agent files per the plan, recording each change in the manifest as it happens. */
  private writeAgents(agents: AgentDoc[], areaNames: Record<string, string>): void {
    const plan = this.plan(agents, areaNames);
    const manifest = this.readManifest();
    const wanted = this.wantedAgents(agents, areaNames);
    fs.mkdirSync(this.agentsDir, { recursive: true });
    try {
      for (const f of plan.files) {
        if (f.path === this.settingsFile) continue;
        const name = path.basename(f.path);
        if (f.state === "write") {
          const content = wanted.get(name)!;
          fs.writeFileSync(f.path, content);
          manifest.agents[name] = sha(content);
        } else if (f.state === "remove") {
          if (fs.existsSync(f.path) && sha(fs.readFileSync(f.path, "utf8")) === manifest.agents[name]) fs.rmSync(f.path);
          delete manifest.agents[name];
        }
      }
      manifest.applied = true;
    } finally {
      this.writeManifest(manifest);
    }
  }

  /** Removes GhostOS's hooks and the agent files it wrote (unless the user edited them since). */
  remove(): void {
    this.updateSettings((s) => this.withoutGhostHooks(s));
    const manifest = this.readManifest();
    for (const [name, hash] of Object.entries(manifest.agents)) {
      const file = path.join(this.agentsDir, name);
      if (fs.existsSync(file) && sha(fs.readFileSync(file, "utf8")) === hash) fs.rmSync(file);
    }
    this.writeManifest({ applied: false, agents: {} });
  }

  /**
   * Keeps an applied setup's hooks pointing at the app (after it moved). With `agents`, also brings the agent
   * files up to date; that is only done after the user changed agents in GhostOS, never after a sync.
   */
  refresh(agents: AgentDoc[], areaNames: Record<string, string>, opts: { agents: boolean }): boolean {
    if (!this.isApplied()) return false;
    const plan = this.plan(agents, areaNames);
    const hooksStale = plan.files[0]?.state === "write";
    const agentsStale = plan.files.slice(1).some((f) => f.state === "write" || f.state === "remove");
    if (hooksStale) this.updateSettings((s) => this.withGhostHooks(s));
    if (opts.agents && agentsStale) this.writeAgents(agents, areaNames);
    return hooksStale || (opts.agents && agentsStale);
  }
}
