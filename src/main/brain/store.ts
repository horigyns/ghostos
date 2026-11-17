// The "brain": GhostOS's own data (areas, projects, ideas, sidenotes) as plain, git-friendly files.
//
// Layout (all paths relative to the brain folder):
//   areas.yaml                         ordered list of areas
//   projects/<id>/project.yaml         one manifest per project
//   projects/<id>/sidenotes.jsonl      that project's sidenotes, one JSON object per line
//   ideas.jsonl                        all ideas; projectId null = unsorted inbox
//   projects/<id>/claude-memory/*.md   notes imported from Claude Code's auto-memory for that project
//   me/claude-memory/*.md              notes about the user imported from Claude Code's memory
//   me/voice.md                        how the user writes (their voice guide)
//   me/writing-samples/*.md|txt        pieces the user wrote, to match their voice
//   ghost/decisions.jsonl              Ghost: snoozed, done and dismissed open loops (append-only)
//   projects/<id>/organize.jsonl       chat folders inside a project, which chat is where, hidden chats (append-only)
//   design-systems/<id>/               a design system: design-system.yaml, DESIGN.md, assets/
//
// This module has no Electron dependency so it can be unit tested.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import {
  FALLBACK_AREA_ID,
  ME_SCOPE,
  type AgentDoc,
  type MemoryNote,
  type Area,
  type BrainSettings,
  type BriefProposal,
  type DesignAsset,
  type DesignSystem,
  type GhostDecision,
  type ProjectOrganization,
  type Idea,
  type Project,
  type ProjectFolder,
  type RunDefinition,
  type RunRecord,
  type SessionSummaryDoc,
  type Sidenote,
  type WritingSample,
} from "../../shared/types";

export { FALLBACK_AREA_ID };

const AREAS_FILE = "areas.yaml";
const PROJECTS_DIR = "projects";
const PROJECT_FILE = "project.yaml";
const SIDENOTES_FILE = "sidenotes.jsonl";
const IDEAS_FILE = "ideas.jsonl";
const SETTINGS_FILE = "settings.yaml";
const RUNS_FILE = "runs.yaml";
const RUN_HISTORY_FILE = "run-history.jsonl";
const RUN_HISTORY_LIMIT = 100;
const RUN_HISTORY_KEEP = 300;
const RUN_HISTORY_COMPACT_BYTES = 512 * 1024;
const BRIEF_FILE = "brief.md";
const BRIEF_PROPOSAL_FILE = "brief.proposed.json";
const SUMMARIES_DIR = "sessions";
const CLAUDE_MEMORY_DIR = "claude-memory";
const GHOST_DIR = "ghost";
const ORGANIZE_FILE = "organize.jsonl";
const FOLDER_PREFIX = "folder:";
const PLACE_PREFIX = "place:";
const HIDE_PREFIX = "hide:";

interface OrganizeRecord {
  id: string;
  kind: "folder" | "place" | "hide";
  name?: string;
  deleted?: boolean;
  folderId?: string | null;
  hidden?: boolean;
  createdAt: string;
  updatedAt?: string;
}

/** One change to a project's organization. */
export type OrganizeChange =
  | { kind: "folder"; folderId: string; name: string; deleted?: boolean; createdAt?: string }
  | { kind: "place"; sessionId: string; folderId: string | null }
  | { kind: "hide"; sessionId: string; hidden: boolean };
const DESIGN_DIR = "design-systems";
const DESIGN_META_FILE = "design-system.yaml";
const DESIGN_GUIDE_FILE = "DESIGN.md";
const DESIGN_ASSETS_DIR = "assets";
const DESIGN_ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** An asset's file name: plain characters only, no folders. */
const ASSET_FILE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,150}$/;
const GHOST_DECISIONS_FILE = "decisions.jsonl";
const ME_DIR = "me";
const VOICE_FILE = "voice.md";
const WRITING_SAMPLES_DIR = "writing-samples";
/** A writing sample's file name: plain text or markdown, no path parts. */
export const WRITING_SAMPLE_FILE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}\.(md|txt)$/;
const SAMPLE_EXCERPT_CHARS = 160;
/** Bytes read from a sample for its excerpt (the whole file is read only when Claude drafts the guide). */
const SAMPLE_HEAD_BYTES = 1_024;
/** A memory note's file name: plain characters, .md, and never Claude's index file. */
const MEMORY_FILE = /^(?!MEMORY\.md$)[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/;
/** True for a file name the brain accepts for a memory note. */
export const isMemoryFileName = (file: string): boolean => MEMORY_FILE.test(file);
const SLUG_MAX_LENGTH = 48;

/** The name and description from a memory note's frontmatter (falls back to the file name). */
export function memoryNoteHeader(content: string, file: string): { name: string; description: string } {
  const fallback = { name: file.replace(/\.md$/, ""), description: "" };
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return fallback;
  try {
    const data = YAML.parse(match[1]) as { name?: unknown; description?: unknown } | null;
    return {
      name: typeof data?.name === "string" && data.name.trim() ? data.name.trim() : fallback.name,
      description: typeof data?.description === "string" ? data.description.trim() : "",
    };
  } catch {
    return fallback;
  }
}

/** Ghost settings from a (possibly hand-edited or synced) file: anything invalid falls back to its default. */
function sanitizeGhost(raw: unknown): BrainSettings["ghost"] {
  const d = DEFAULT_SETTINGS.ghost;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    enabled: bool(r.enabled, d.enabled),
    stallDays: int(r.stallDays, 1, 60, d.stallDays),
    notifications: bool(r.notifications, d.notifications),
    remindEveryDays: int(r.remindEveryDays, 1, 30, d.remindEveryDays),
    quietFrom: int(r.quietFrom, 0, 23, d.quietFrom),
    quietTo: int(r.quietTo, 0, 23, d.quietTo),
    autoSummarize: bool(r.autoSummarize, d.autoSummarize),
    digestTime: typeof r.digestTime === "string" && (r.digestTime === "" || /^([01]?\d|2[0-3]):[0-5]\d$/.test(r.digestTime)) ? r.digestTime : d.digestTime,
  };
}

export const DEFAULT_SETTINGS: BrainSettings = {
  budget: { pauseAboveWeekPct: 90, pauseAboveFiveHourPct: 85, downgradeAboveWeekPct: 70, downgradeModel: "sonnet" },
  autoApplyBriefs: false,
  // The user's choices: block only the pre-commit review; everything else is a reminder.
  enforcement: { sessionContext: true, reviewBeforeCommit: "block", documenterReminder: "remind", errorLogReminder: "remind" },
  ghost: {
    enabled: true,
    stallDays: 3,
    notifications: true,
    remindEveryDays: 3,
    quietFrom: 22,
    quietTo: 8,
    autoSummarize: true,
    digestTime: "08:30",
  },
};

const RULES_DIR = "rules";
const AGENTS_DIR = "agents";
const GLOBAL_SCOPE = "global";
const PROJECT_RULES_FILE = "rules.md";
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SHORT_ID_BYTES = 4;

export const DEFAULT_AREAS: Area[] = [
  { id: "work", name: "Work" },
  { id: "personal", name: "Personal" },
  { id: "research", name: "Research" },
  { id: "random", name: "Random" },
];
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
  return slug || "item";
}

export function shortId(): string {
  return crypto.randomBytes(SHORT_ID_BYTES).toString("hex");
}

function parseJsonl<T>(file: string): { items: T[]; badLines: number } {
  if (!fs.existsSync(file)) return { items: [], badLines: 0 };
  const items: T[] = [];
  let badLines = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      // A corrupt line (a git conflict marker, a half-written sync) must not take down the whole file.
      badLines++;
    }
  }
  return { items, badLines };
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeFileAtomic(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * One item per id. Syncing merges two Macs' copies of a JSONL file line by line, so a changed item can
 * appear twice; the newest version (updatedAt, then createdAt; later line on a tie) is kept, in first-seen order.
 */
export function latestById<T extends { id: string; createdAt: string; updatedAt?: string }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const prev = best.get(item.id);
    if (!prev || (item.updatedAt ?? item.createdAt) >= (prev.updatedAt ?? prev.createdAt)) best.set(item.id, item);
  }
  const seen = new Set<string>();
  return items.filter((i) => !seen.has(i.id) && seen.add(i.id)).map((i) => best.get(i.id)!);
}

export class BrainStore {
  private readonly problems = new Map<string, string>();

  constructor(readonly dir: string) {}

  /** Problems found while reading brain files, for the UI to show. */
  warnings(): string[] {
    return [...this.problems.values()];
  }

  private readJsonl<T>(file: string): T[] {
    const { items, badLines } = parseJsonl<T>(file);
    const rel = path.relative(this.dir, file);
    if (badLines) this.problems.set(file, `${rel}: ${badLines} unreadable line(s); a backup is kept when the file is next saved.`);
    else this.problems.delete(file);
    return items;
  }

  /** Rewrites a JSONL file; if it holds unreadable lines, the original is backed up first so nothing is lost. */
  private writeJsonl<T>(file: string, items: T[]): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (parseJsonl(file).badLines) {
      const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(file, backup);
      // Kept under its own key so it stays visible after the cleaned-up file reads fine again.
      this.problems.set(`${file}#backup`, `${path.relative(this.dir, file)} had unreadable lines; the original was saved as ${path.basename(backup)}.`);
    }
    const body = items.map((item) => JSON.stringify(item)).join("\n");
    writeFileAtomic(file, items.length ? body + "\n" : "");
  }

  /** Creates the folder structure and default areas if this is a new brain. Returns true when newly created. */
  ensure(): boolean {
    const isNew = !fs.existsSync(path.join(this.dir, AREAS_FILE));
    fs.mkdirSync(path.join(this.dir, PROJECTS_DIR), { recursive: true });
    if (isNew) this.saveAreas(DEFAULT_AREAS);
    return isNew;
  }

  // ---------- areas ----------

  /** Areas in sidebar order. If areas.yaml can't be read, the defaults are shown and the file is left untouched. */
  listAreas(): Area[] {
    const file = path.join(this.dir, AREAS_FILE);
    if (!fs.existsSync(file)) return [...DEFAULT_AREAS];
    try {
      const parsed = YAML.parse(fs.readFileSync(file, "utf8")) as { areas?: Area[] } | null;
      if (!Array.isArray(parsed?.areas)) throw new Error("no areas list");
      this.problems.delete(file);
      return parsed.areas.filter((a) => a && typeof a.id === "string" && typeof a.name === "string");
    } catch (err) {
      this.problems.set(file, `${AREAS_FILE} can't be read (${(err as Error).message}). Showing default areas; fix the file to change areas.`);
      return [...DEFAULT_AREAS];
    }
  }

  saveAreas(areas: Area[]): void {
    const file = path.join(this.dir, AREAS_FILE);
    this.listAreas(); // refresh the problem state
    if (this.problems.has(file)) throw new Error(`${AREAS_FILE} can't be read, so it won't be overwritten. Fix or delete it first.`);
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(file, YAML.stringify({ areas }));
  }

  addArea(name: string): Area {
    const areas = this.listAreas();
    const area = { id: this.uniqueId(slugify(name), new Set(areas.map((a) => a.id))), name: name.trim() };
    this.saveAreas([...areas, area]);
    return area;
  }

  renameArea(id: string, name: string): void {
    this.saveAreas(this.listAreas().map((a) => (a.id === id ? { ...a, name: name.trim() } : a)));
  }

  /** Moves an area up (-1) or down (+1) in the sidebar order. */
  moveArea(id: string, direction: -1 | 1): void {
    const areas = this.listAreas();
    const from = areas.findIndex((a) => a.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= areas.length) return;
    [areas[from], areas[to]] = [areas[to], areas[from]];
    this.saveAreas(areas);
  }

  /** Removes an area; its projects move to the fallback area. The fallback area itself cannot be removed. */
  removeArea(id: string): void {
    if (id === FALLBACK_AREA_ID) throw new Error("The Random area can't be removed; it holds unsorted projects.");
    for (const project of this.listProjects()) {
      if (project.area === id) this.saveProject({ ...project, area: FALLBACK_AREA_ID });
    }
    this.saveAreas(this.listAreas().filter((a) => a.id !== id));
  }

  // ---------- projects ----------

  listProjects(): Project[] {
    const root = path.join(this.dir, PROJECTS_DIR);
    if (!fs.existsSync(root)) return [];
    const projects: Project[] = [];
    for (const id of fs.readdirSync(root)) {
      const file = path.join(root, id, PROJECT_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        const data = YAML.parse(fs.readFileSync(file, "utf8")) as Partial<Project>;
        projects.push({
          id,
          name: data.name ?? id,
          area: data.area ?? FALLBACK_AREA_ID,
          description: data.description,
          folders: data.folders ?? [],
          createdAt: data.createdAt ?? new Date(0).toISOString(),
          archived: data.archived === true ? true : undefined,
          archivedAt: data.archived === true && typeof data.archivedAt === "string" ? data.archivedAt : undefined,
        });
        this.problems.delete(file);
      } catch (err) {
        this.problems.set(file, `projects/${id}/${PROJECT_FILE} can't be read (${(err as Error).message}); that project is hidden until it's fixed.`);
      }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every project folder name on disk, including ones whose manifest can't be read. */
  private takenProjectIds(): Set<string> {
    const root = path.join(this.dir, PROJECTS_DIR);
    return new Set(fs.existsSync(root) ? fs.readdirSync(root) : []);
  }

  /** Projects that aren't archived (what the sidebar, Ghost and the scheduler work with). */
  listActiveProjects(): Project[] {
    return this.listProjects().filter((p) => !p.archived);
  }

  /**
   * Removes a project from the brain: its manifest, runs, history, notes, summaries and organization. Claude's
   * transcripts and the project's folders on disk aren't touched, and the brain's git history keeps a copy.
   */
  deleteProject(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id) || !this.takenProjectIds().has(id)) throw new Error("That project doesn't exist.");
    // Its ideas go back to the inbox rather than pointing at a project that's gone.
    for (const idea of this.listIdeas()) if (idea.projectId === id) this.updateIdea(idea.id, { projectId: null });
    fs.rmSync(path.join(this.dir, PROJECTS_DIR, id), { recursive: true, force: true });
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
  }

  createProject(input: { name: string; area: string; folders?: ProjectFolder[]; description?: string }): Project {
    const name = input.name.trim();
    if (!name) throw new Error("A project needs a name.");
    const existing = this.takenProjectIds();
    const project: Project = {
      // "me" is the scope for notes about the user, so no project may take it.
      id: this.uniqueId(slugify(name), new Set([...existing, ME_SCOPE])),
      name,
      area: this.knownArea(input.area),
      description: input.description,
      folders: input.folders ?? [],
      createdAt: new Date().toISOString(),
    };
    this.saveProject(project);
    return project;
  }

  saveProject(project: Project): void {
    const dir = path.join(this.dir, PROJECTS_DIR, project.id);
    fs.mkdirSync(dir, { recursive: true });
    const { id: _id, ...rest } = project;
    writeFileAtomic(path.join(dir, PROJECT_FILE), YAML.stringify(rest));
  }

  updateProject(id: string, patch: Partial<Omit<Project, "id" | "createdAt">>): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`No project with id ${id}`);
    const next = { ...project, ...patch, area: patch.area ? this.knownArea(patch.area) : project.area };
    this.saveProject(next);
    return next;
  }

  /** Attaches a folder to a project on a given machine, merging with an existing entry for the same remote. */
  addFolder(id: string, machineId: string, folderPath: string, remote?: string, label?: string): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`No project with id ${id}`);
    const folders = [...project.folders];
    const match = remote ? folders.find((f) => f.remote === remote) : undefined;
    if (match) {
      match.paths = { ...match.paths, [machineId]: folderPath };
    } else {
      folders.push({ label: label ?? path.basename(folderPath), remote, paths: { [machineId]: folderPath } });
    }
    return this.updateProject(id, { folders });
  }

  removeFolder(id: string, machineId: string, folderPath: string): Project {
    const project = this.getProject(id);
    if (!project) throw new Error(`No project with id ${id}`);
    const folders = project.folders
      .map((f) => {
        if (f.paths[machineId] !== folderPath) return f;
        const { [machineId]: _removed, ...paths } = f.paths;
        return { ...f, paths };
      })
      .filter((f) => Object.keys(f.paths).length > 0);
    return this.updateProject(id, { folders });
  }

  // ---------- ideas ----------

  listIdeas(): Idea[] {
    return latestById(this.readJsonl<Idea>(path.join(this.dir, IDEAS_FILE)));
  }

  addIdea(text: string, projectId: string | null): Idea {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("An idea can't be empty.");
    const idea: Idea = { id: shortId(), projectId, text: trimmed, status: "open", createdAt: new Date().toISOString() };
    this.writeJsonl(path.join(this.dir, IDEAS_FILE), [...this.listIdeas(), idea]);
    return idea;
  }

  updateIdea(id: string, patch: Partial<Pick<Idea, "projectId" | "text" | "status">>): Idea {
    let updated: Idea | undefined;
    const ideas = this.listIdeas().map((idea) => (idea.id === id ? (updated = { ...idea, ...patch, updatedAt: new Date().toISOString() }) : idea));
    if (!updated) throw new Error(`No idea with id ${id}`);
    this.writeJsonl(path.join(this.dir, IDEAS_FILE), ideas);
    return updated;
  }

  // ---------- sidenotes ----------

  private sidenotesFile(projectId: string): string {
    return path.join(this.dir, PROJECTS_DIR, projectId, SIDENOTES_FILE);
  }

  listSidenotes(projectId: string): Sidenote[] {
    return latestById(this.readJsonl<Sidenote>(this.sidenotesFile(projectId)));
  }

  addSidenote(note: Omit<Sidenote, "id" | "createdAt">): Sidenote {
    const trimmed = note.text.trim();
    if (!trimmed) throw new Error("A sidenote can't be empty.");
    const saved: Sidenote = { ...note, text: trimmed, id: shortId(), createdAt: new Date().toISOString() };
    this.writeJsonl(this.sidenotesFile(note.projectId), [...this.listSidenotes(note.projectId), saved]);
    return saved;
  }

  updateSidenote(projectId: string, id: string, patch: Partial<Omit<Sidenote, "id" | "projectId">>): Sidenote {
    let updated: Sidenote | undefined;
    const notes = this.listSidenotes(projectId).map((n) => (n.id === id ? (updated = { ...n, ...patch, updatedAt: new Date().toISOString() }) : n));
    if (!updated) throw new Error(`No sidenote with id ${id}`);
    this.writeJsonl(this.sidenotesFile(projectId), notes);
    return updated;
  }

  // ---------- settings ----------

  getSettings(): BrainSettings {
    const file = path.join(this.dir, SETTINGS_FILE);
    if (!fs.existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const data = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as Partial<BrainSettings>;
      this.problems.delete(file);
      return {
        budget: { ...DEFAULT_SETTINGS.budget, ...(data.budget ?? {}) },
        autoApplyBriefs: data.autoApplyBriefs === true,
        enforcement: { ...DEFAULT_SETTINGS.enforcement, ...(data.enforcement ?? {}) },
        ghost: sanitizeGhost(data.ghost),
      };
    } catch (err) {
      this.problems.set(file, `${SETTINGS_FILE} can't be read (${(err as Error).message}); using default settings.`);
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  saveSettings(settings: BrainSettings): void {
    writeFileAtomic(path.join(this.dir, SETTINGS_FILE), YAML.stringify(settings));
  }

  // ---------- run definitions ----------

  private runsFile(projectId: string): string {
    return path.join(this.dir, PROJECTS_DIR, projectId, RUNS_FILE);
  }

  listRuns(projectId: string): RunDefinition[] {
    const file = this.runsFile(projectId);
    if (!fs.existsSync(file)) return [];
    try {
      const data = YAML.parse(fs.readFileSync(file, "utf8")) as { runs?: Omit<RunDefinition, "projectId">[] } | null;
      this.problems.delete(file);
      return (data?.runs ?? []).map((r) => ({ ...r, projectId }));
    } catch (err) {
      this.problems.set(file, `projects/${projectId}/${RUNS_FILE} can't be read (${(err as Error).message}); its runs are paused.`);
      return [];
    }
  }

  listAllRuns(): RunDefinition[] {
    return this.listProjects().flatMap((p) => this.listRuns(p.id));
  }

  saveRun(def: RunDefinition): RunDefinition {
    const runs = this.listRuns(def.projectId).filter((r) => r.id !== def.id);
    this.writeRuns(def.projectId, [...runs, def]);
    return def;
  }

  deleteRun(projectId: string, runId: string): void {
    this.writeRuns(projectId, this.listRuns(projectId).filter((r) => r.id !== runId));
  }

  private writeRuns(projectId: string, runs: RunDefinition[]): void {
    const file = this.runsFile(projectId);
    if (this.problems.has(file)) throw new Error(`${RUNS_FILE} can't be read, so it won't be overwritten. Fix or delete it first.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, YAML.stringify({ runs: runs.map(({ projectId: _p, ...rest }) => rest) }));
  }

  // ---------- run history (append-only, so the app and the background runner can both write safely) ----------

  private historyFile(projectId: string): string {
    return path.join(this.dir, PROJECTS_DIR, projectId, RUN_HISTORY_FILE);
  }

  /** Appends a full or partial record; the latest values per record id win when read. */
  appendRunRecord(projectId: string, record: Partial<RunRecord> & { id: string }): void {
    const file = this.historyFile(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...record, projectId }) + "\n");
  }

  /** Run records, newest first. */
  listRunRecords(projectId: string, limit = RUN_HISTORY_LIMIT): RunRecord[] {
    const merged = new Map<string, RunRecord>();
    for (const part of this.readJsonl<Partial<RunRecord> & { id: string }>(this.historyFile(projectId))) {
      merged.set(part.id, { ...(merged.get(part.id) ?? ({} as RunRecord)), ...part });
    }
    return [...merged.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0, limit);
  }

  /**
   * Keeps run history small: once the file passes a size limit it is rewritten with the newest merged
   * records only. Called by the scheduler while it holds the runner lock.
   */
  compactRunHistory(projectId: string): boolean {
    const file = this.historyFile(projectId);
    if (!fs.existsSync(file) || fs.statSync(file).size < RUN_HISTORY_COMPACT_BYTES) return false;
    const keep = this.listRunRecords(projectId, RUN_HISTORY_KEEP);
    this.writeJsonl(file, keep.reverse());
    return true;
  }

  historyMtime(projectId: string): number {
    const file = this.historyFile(projectId);
    return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  }

  // ---------- organizing a project's chats ----------

  private organizeFile(projectId: string): string {
    return path.join(this.dir, PROJECTS_DIR, projectId, ORGANIZE_FILE);
  }

  /** The project's chat folders, placements and hidden chats, from its append-only log (newest record per id wins). */
  getOrganization(projectId: string): ProjectOrganization {
    const org: ProjectOrganization = { folders: [], placement: {}, hidden: [] };
    for (const r of latestById(this.readJsonl<OrganizeRecord>(this.organizeFile(projectId)))) {
      if (r.kind === "folder" && !r.deleted && typeof r.name === "string") org.folders.push({ id: r.id.slice(FOLDER_PREFIX.length), name: r.name, createdAt: r.createdAt });
      else if (r.kind === "place" && typeof r.folderId === "string") org.placement[r.id.slice(PLACE_PREFIX.length)] = r.folderId;
      else if (r.kind === "hide" && r.hidden === true) org.hidden.push(r.id.slice(HIDE_PREFIX.length));
    }
    return org;
  }

  /**
   * Records changes to a project's organization. One line per change, so two Macs' edits merge line by line
   * (union merge) instead of conflicting; a chat placed in a folder the other Mac removed just shows outside folders.
   */
  addOrganizationRecords(projectId: string, records: OrganizeChange[]): void {
    if (!this.takenProjectIds().has(projectId)) throw new Error("That project doesn't exist.");
    const now = new Date().toISOString();
    const file = this.organizeFile(projectId);
    const lines = records.map((r) => {
      const base = { createdAt: ("createdAt" in r && r.createdAt) || now, updatedAt: now };
      if (r.kind === "folder") return { ...base, id: FOLDER_PREFIX + r.folderId, kind: "folder", name: r.name, deleted: r.deleted || undefined };
      if (r.kind === "place") return { ...base, id: PLACE_PREFIX + r.sessionId, kind: "place", folderId: r.folderId };
      return { ...base, id: HIDE_PREFIX + r.sessionId, kind: "hide", hidden: r.hidden };
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  // ---------- design systems ----------

  designSystemDir(id: string): string {
    if (!DESIGN_ID.test(id)) throw new Error("Invalid design system id.");
    return path.join(this.dir, DESIGN_DIR, id);
  }

  listDesignSystems(): DesignSystem[] {
    const root = path.join(this.dir, DESIGN_DIR);
    if (!fs.existsSync(root)) return [];
    const out: DesignSystem[] = [];
    for (const id of fs.readdirSync(root).filter((d) => DESIGN_ID.test(d)).sort()) {
      const file = path.join(root, id, DESIGN_META_FILE);
      if (!fs.existsSync(file)) continue;
      try {
        const data = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as Partial<DesignSystem>;
        out.push({
          id,
          name: typeof data.name === "string" && data.name.trim() ? data.name : id,
          description: typeof data.description === "string" ? data.description : undefined,
          areas: Array.isArray(data.areas) ? data.areas.filter((a) => typeof a === "string") : [],
          projects: Array.isArray(data.projects) ? data.projects.filter((p) => typeof p === "string") : [],
          sources: Array.isArray(data.sources)
            ? data.sources.filter((s) => typeof s?.projectId === "string" && typeof s.folderLabel === "string" && typeof s.relPath === "string")
            : [],
          createdAt: data.createdAt ?? new Date(0).toISOString(),
          updatedAt: data.updatedAt,
        });
        this.problems.delete(file);
      } catch (err) {
        this.problems.set(file, `${DESIGN_DIR}/${id}/${DESIGN_META_FILE} can't be read (${(err as Error).message}).`);
      }
    }
    return out;
  }

  /** Creates a design system with a unique id from its name. */
  createDesignSystem(name: string): DesignSystem {
    // Taken ids come from the folders, so a system whose file can't be read is never overwritten.
    const root = path.join(this.dir, DESIGN_DIR);
    const taken = new Set(fs.existsSync(root) ? fs.readdirSync(root) : []);
    const ds: DesignSystem = { id: this.uniqueId(slugify(name), taken), name: name.trim(), areas: [], projects: [], sources: [], createdAt: new Date().toISOString() };
    this.saveDesignSystem(ds);
    return ds;
  }

  saveDesignSystem(ds: DesignSystem): void {
    const dir = this.designSystemDir(ds.id);
    fs.mkdirSync(path.join(dir, DESIGN_ASSETS_DIR), { recursive: true });
    // No timestamp in the file: two Macs saving the same unchanged system then never conflict in git.
    const { id: _id, updatedAt: _u, ...rest } = ds;
    writeFileAtomic(path.join(dir, DESIGN_META_FILE), YAML.stringify(rest));
  }

  deleteDesignSystem(id: string): void {
    fs.rmSync(this.designSystemDir(id), { recursive: true, force: true });
  }

  designGuidePath(id: string): string {
    return path.join(this.designSystemDir(id), DESIGN_GUIDE_FILE);
  }

  getDesignGuide(id: string): string {
    const file = this.designGuidePath(id);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  saveDesignGuide(id: string, text: string): void {
    writeFileAtomic(this.designGuidePath(id), text.trimEnd() + "\n");
  }

  designAssetsDir(id: string): string {
    return path.join(this.designSystemDir(id), DESIGN_ASSETS_DIR);
  }

  listDesignAssets(id: string): DesignAsset[] {
    const dir = this.designAssetsDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => ASSET_FILE.test(f) && !f.startsWith("."))
      .sort()
      .flatMap((file) => {
        const st = fs.lstatSync(path.join(dir, file));
        return st.isFile() ? [{ file, bytes: st.size }] : [];
      });
  }

  /** Copies a file into the design system's assets (a free name is chosen if it's taken). */
  addDesignAsset(id: string, source: string): string {
    const dir = this.designAssetsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const parsed = path.parse(source);
    const base = parsed.name.replace(/[^A-Za-z0-9 ._()-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "asset";
    const ext = parsed.ext.replace(/[^A-Za-z0-9.]/g, "");
    let file = `${base}${ext}`;
    for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${base}-${n}${ext}`;
    if (!ASSET_FILE.test(file)) throw new Error(`Can't use the file name "${parsed.base}".`);
    fs.copyFileSync(source, path.join(dir, file));
    return file;
  }

  /** An asset's path; only a regular file really inside the assets folder (a symlink, e.g. synced from elsewhere, isn't). */
  designAssetPath(id: string, file: string): string {
    if (!ASSET_FILE.test(file)) throw new Error("Invalid asset name.");
    const dir = this.designAssetsDir(id);
    const full = path.join(dir, file);
    if (fs.existsSync(full)) {
      if (!fs.lstatSync(full).isFile()) throw new Error("That asset isn't a regular file.");
      const real = fs.realpathSync(full);
      if (path.dirname(real) !== fs.realpathSync(dir)) throw new Error("That asset isn't in the design system's folder.");
    }
    return full;
  }

  removeDesignAsset(id: string, file: string): void {
    if (!ASSET_FILE.test(file)) throw new Error("Invalid asset name.");
    fs.rmSync(path.join(this.designAssetsDir(id), file), { force: true }); // removes a link itself, never its target
  }

  /** Design systems that apply to a project: linked to it directly or to its area. */
  designSystemsFor(project: Pick<Project, "id" | "area">): DesignSystem[] {
    return this.listDesignSystems().filter((d) => d.projects.includes(project.id) || d.areas.includes(project.area));
  }

  // ---------- Ghost: decisions about open loops (append-only, merged by id; synced) ----------

  private ghostDecisionsFile(): string {
    return path.join(this.dir, GHOST_DIR, GHOST_DECISIONS_FILE);
  }

  listGhostDecisions(): GhostDecision[] {
    return latestById(this.readJsonl<GhostDecision>(this.ghostDecisionsFile()));
  }

  /** Records a decision; the newest one per loop id wins when read, also after two Macs' files are merged. */
  addGhostDecision(decision: GhostDecision): void {
    const file = this.ghostDecisionsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ...decision, updatedAt: decision.updatedAt ?? decision.createdAt }) + "\n");
  }

  hasSessionSummary(projectId: string, sessionId: string): boolean {
    return fs.existsSync(path.join(this.dir, PROJECTS_DIR, projectId, SUMMARIES_DIR, `${sessionId}.json`));
  }

  // ---------- notes from Claude Code's auto-memory ----------

  /** Folder for imported memory notes: "me" (about the user) or a project id. */
  claudeMemoryDir(scope: string): string {
    if (scope === ME_SCOPE) return path.join(this.dir, ME_DIR, CLAUDE_MEMORY_DIR);
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(scope) || !this.takenProjectIds().has(scope)) throw new Error("That project doesn't exist.");
    return path.join(this.dir, PROJECTS_DIR, scope, CLAUDE_MEMORY_DIR);
  }

  listClaudeMemory(scope: string): MemoryNote[] {
    const dir = this.claudeMemoryDir(scope);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => MEMORY_FILE.test(f))
      .sort()
      .map((file) => {
        const content = fs.readFileSync(path.join(dir, file), "utf8");
        return { file, content, ...memoryNoteHeader(content, file) };
      });
  }

  saveClaudeMemory(scope: string, file: string, content: string): void {
    if (!MEMORY_FILE.test(file)) throw new Error(`Invalid memory file name "${file}".`);
    const dir = this.claudeMemoryDir(scope);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, file), content.endsWith("\n") ? content : content + "\n");
  }

  deleteClaudeMemory(scope: string, file: string): void {
    if (!MEMORY_FILE.test(file)) throw new Error(`Invalid memory file name "${file}".`);
    fs.rmSync(path.join(this.claudeMemoryDir(scope), file), { force: true });
  }

  // ---------- the user's writing voice ----------

  voiceGuidePath(): string {
    return path.join(this.dir, ME_DIR, VOICE_FILE);
  }

  writingSamplesDir(): string {
    return path.join(this.dir, ME_DIR, WRITING_SAMPLES_DIR);
  }

  /**
   * A voice file that is safe to read or open: a regular file (not a symlink, which git syncs and could point at
   * ~/.ssh or an app) that really is inside the brain folder it belongs to. Undefined when there is none.
   */
  private safeVoiceFile(dir: string, file: string): string | undefined {
    const full = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      return undefined;
    }
    if (!stat.isFile()) return undefined;
    try {
      if (path.dirname(fs.realpathSync(full)) !== fs.realpathSync(dir)) return undefined;
    } catch {
      return undefined;
    }
    return full;
  }

  getVoiceGuide(): string {
    const file = this.safeVoiceFile(path.dirname(this.voiceGuidePath()), VOICE_FILE);
    return file ? fs.readFileSync(file, "utf8") : "";
  }

  /** Saves the voice guide; empty text removes it. */
  saveVoiceGuide(text: string): void {
    const file = this.voiceGuidePath();
    if (!text.trim()) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text.trimEnd() + "\n");
  }

  listWritingSamples(): WritingSample[] {
    const dir = this.writingSamplesDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => WRITING_SAMPLE_FILE.test(f))
      .sort()
      .flatMap((file) => {
        const full = this.safeVoiceFile(dir, file);
        if (!full) return [];
        // Only the start is read: this runs at every session start (the hook).
        const head = Buffer.alloc(SAMPLE_HEAD_BYTES);
        const fd = fs.openSync(full, "r");
        let read: number;
        try {
          read = fs.readSync(fd, head, 0, SAMPLE_HEAD_BYTES, 0);
        } finally {
          fs.closeSync(fd);
        }
        const excerpt = head.subarray(0, read).toString("utf8").replace(/\uFFFD$/, "").replace(/\s+/g, " ").trim().slice(0, SAMPLE_EXCERPT_CHARS);
        return [{ file, bytes: fs.statSync(full).size, excerpt }];
      });
  }

  /** A sample's path, only for a regular file in the samples folder. */
  writingSamplePath(file: string): string {
    if (!WRITING_SAMPLE_FILE.test(file)) throw new Error("Invalid sample name.");
    const full = this.safeVoiceFile(this.writingSamplesDir(), file);
    if (!full) throw new Error("That sample isn't there.");
    return full;
  }

  readWritingSample(file: string): string {
    return fs.readFileSync(this.writingSamplePath(file), "utf8");
  }

  /** Adds a sample under a free name based on `name`; returns the file name used. */
  addWritingSample(name: string, content: string): string {
    const ext = /\.txt$/i.test(name) ? ".txt" : ".md";
    const base =
      name
        .replace(/\.(md|markdown|txt)$/i, "")
        .replace(/[^A-Za-z0-9 ._-]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[^A-Za-z0-9]+/, "")
        .trim()
        .slice(0, 80) || "sample";
    const dir = this.writingSamplesDir();
    fs.mkdirSync(dir, { recursive: true });
    let file = `${base}${ext}`;
    for (let n = 2; fs.existsSync(path.join(dir, file)) || isSymlink(path.join(dir, file)); n++) file = `${base} ${n}${ext}`;
    writeFileAtomic(path.join(dir, file), content.trimEnd() + "\n");
    return file;
  }

  /** Removes a sample (a symlink with a sample's name is removed itself, never what it points at). */
  deleteWritingSample(file: string): void {
    if (!WRITING_SAMPLE_FILE.test(file)) throw new Error("Invalid sample name.");
    fs.rmSync(path.join(this.writingSamplesDir(), file), { force: true });
  }

  // ---------- briefs and session summaries ----------

  getBrief(projectId: string): string {
    const file = path.join(this.dir, PROJECTS_DIR, projectId, BRIEF_FILE);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  saveBrief(projectId: string, text: string): void {
    const dir = path.join(this.dir, PROJECTS_DIR, projectId);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, BRIEF_FILE), text.trim() + "\n");
  }

  getBriefProposal(projectId: string): BriefProposal | undefined {
    const file = path.join(this.dir, PROJECTS_DIR, projectId, BRIEF_PROPOSAL_FILE);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as BriefProposal;
    } catch {
      return undefined;
    }
  }

  saveBriefProposal(projectId: string, proposal: BriefProposal | undefined): void {
    const file = path.join(this.dir, PROJECTS_DIR, projectId, BRIEF_PROPOSAL_FILE);
    if (!proposal) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(proposal, null, 2));
  }

  private summariesDir(projectId: string): string {
    return path.join(this.dir, PROJECTS_DIR, projectId, SUMMARIES_DIR);
  }

  saveSessionSummary(summary: SessionSummaryDoc): void {
    const dir = this.summariesDir(summary.projectId);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, `${summary.sessionId}.json`), JSON.stringify(summary, null, 2));
  }

  listSessionSummaries(projectId: string): SessionSummaryDoc[] {
    const dir = this.summariesDir(projectId);
    if (!fs.existsSync(dir)) return [];
    const out: SessionSummaryDoc[] = [];
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as SessionSummaryDoc);
      } catch {
        // skip a damaged summary; it can be regenerated
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---------- rules: global -> area -> project ----------

  private rulesFile(scope: { area?: string; projectId?: string }): string {
    if (scope.projectId) return path.join(this.dir, PROJECTS_DIR, scope.projectId, PROJECT_RULES_FILE);
    if (scope.area) return path.join(this.dir, RULES_DIR, "areas", `${scope.area}.md`);
    return path.join(this.dir, RULES_DIR, `${GLOBAL_SCOPE}.md`);
  }

  getRules(scope: { area?: string; projectId?: string } = {}): string {
    const file = this.rulesFile(scope);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  saveRules(scope: { area?: string; projectId?: string }, text: string): void {
    const file = this.rulesFile(scope);
    if (!text.trim()) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text.trim() + "\n");
  }

  // ---------- agents: global or per area ----------

  private agentsDir(scope: string): string {
    return scope === GLOBAL_SCOPE ? path.join(this.dir, AGENTS_DIR, GLOBAL_SCOPE) : path.join(this.dir, AGENTS_DIR, "areas", scope);
  }

  listAgents(): AgentDoc[] {
    const scopes = [GLOBAL_SCOPE, ...this.listAreas().map((a) => a.id)];
    const agents: AgentDoc[] = [];
    for (const scope of scopes) {
      const dir = this.agentsDir(scope);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
        agents.push({ name: file.slice(0, -3), scope, content: fs.readFileSync(path.join(dir, file), "utf8") });
      }
    }
    return agents;
  }

  saveAgent(agent: AgentDoc): AgentDoc {
    if (!AGENT_NAME.test(agent.name)) throw new Error("Agent names use lowercase letters, digits and dashes.");
    if (agent.scope !== GLOBAL_SCOPE && !this.listAreas().some((a) => a.id === agent.scope)) throw new Error("Unknown area for this agent.");
    const dir = this.agentsDir(agent.scope);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, `${agent.name}.md`), agent.content.trimEnd() + "\n");
    return agent;
  }

  deleteAgent(scope: string, name: string): void {
    if (!AGENT_NAME.test(name)) throw new Error("Invalid agent name.");
    fs.rmSync(path.join(this.agentsDir(scope), `${name}.md`), { force: true });
  }

  // ---------- helpers ----------

  private knownArea(areaId: string): string {
    return this.listAreas().some((a) => a.id === areaId) ? areaId : FALLBACK_AREA_ID;
  }

  private uniqueId(base: string, taken: Set<string>): string {
    if (!taken.has(base)) return base;
    let candidate = `${base}-${shortId()}`;
    while (taken.has(candidate)) candidate = `${base}-${shortId()}`;
    return candidate;
  }
}
