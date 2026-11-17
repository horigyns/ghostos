import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainStore, latestById } from "../src/main/brain/store";
import { buildSessionContext, CONTEXT_MAX_CHARS, projectForFolder } from "../src/main/capabilities/context";
import { changedFiles, isCommitCommand, reviewedSinceLastCommit, runGhostHook, type ToolUse } from "../src/hook/ghostos-hook";
import { agentFileContent, CapabilityInstaller } from "../src/main/capabilities/install";
import { normalizeRemote, suggestFolders } from "../src/main/brain/locate";
import { BrainSync } from "../src/main/brain/sync";
import { BrainGit } from "../src/main/brain/git";

let dir: string;
let store: BrainStore;
let folder: string;
const MACHINE = "mini";

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-p3-")));
  store = new BrainStore(path.join(dir, "brain"));
  store.ensure();
  folder = path.join(dir, "persona-study");
  fs.mkdirSync(path.join(folder, "src"), { recursive: true });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function project() {
  return store.createProject({ name: "Persona study", area: "research", folders: [{ label: "persona-study", paths: { [MACHINE]: folder } }] });
}

function appData() {
  const a = path.join(dir, "app");
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "config.json"), JSON.stringify({ brainDir: store.dir }));
  fs.writeFileSync(path.join(a, "machine.json"), JSON.stringify({ id: MACHINE, name: "mini" }));
  return a;
}

let transcripts = 0;
function transcript(uses: { name: string; input: Record<string, unknown>; error?: boolean }[]): string {
  const file = path.join(dir, `t${++transcripts}.jsonl`);
  const lines: string[] = [];
  uses.forEach((u, i) => {
    lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: u.name, input: u.input }] } }));
    lines.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: Boolean(u.error) }] } }));
  });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("session context", () => {
  it("finds the project for a folder or any subfolder, deepest folder first", () => {
    const p = project();
    expect(projectForFolder(store, MACHINE, path.join(folder, "src"))?.project.id).toBe(p.id);
    expect(projectForFolder(store, MACHINE, dir)).toBeUndefined();
  });

  it("layers global, area and project rules, area agents and the brief, within the size limit", () => {
    const p = project();
    store.saveRules({}, "Plan before coding.");
    store.saveRules({ area: "research" }, "Preregister analyses.");
    store.saveRules({ projectId: p.id }, "Judge audits use rubric v2.");
    store.saveAgent({ name: "stats-checker", scope: "research", content: "---\nname: stats-checker\ndescription: Checks stats\n---\nCheck." });
    store.saveBrief(p.id, "Current state: audit done.\n" + "x".repeat(20_000));
    const ctx = buildSessionContext(store, store.getProject(p.id)!)!;
    expect(ctx.indexOf("Plan before coding")).toBeLessThan(ctx.indexOf("Preregister"));
    expect(ctx.indexOf("Preregister")).toBeLessThan(ctx.indexOf("rubric v2"));
    expect(ctx).toContain("research-stats-checker");
    expect(ctx).toContain("<project-brief>");
    expect(ctx.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });
});

describe("GhostOS hook", () => {
  it("adds context at session start in project folders only, and not for GhostOS's own sessions", () => {
    const p = project();
    store.saveRules({ projectId: p.id }, "Use rubric v2.");
    const app = appData();
    const out = runGhostHook(app, { hook_event_name: "SessionStart", cwd: path.join(folder, "src") }, {});
    expect(JSON.stringify(out)).toContain("rubric v2");
    expect(runGhostHook(app, { hook_event_name: "SessionStart", cwd: dir }, {})).toBeUndefined();
    expect(runGhostHook(app, { hook_event_name: "SessionStart", cwd: folder }, { GHOSTOS_SESSION: "1" })).toBeUndefined();
  });

  it("blocks a commit until a review has run since the last commit", () => {
    project();
    const app = appData();
    const commit = (t: string, id = "now") =>
      runGhostHook(app, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: id, cwd: folder, transcript_path: t, tool_input: { command: 'git commit -m "x"' } }, {});
    const noReview = transcript([{ name: "Edit", input: { file_path: "a.ts" } }]);
    expect(commit(noReview)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const reviewed = transcript([{ name: "Edit", input: { file_path: "a.ts" } }, { name: "Agent", input: { subagent_type: "code-reviewer" } }]);
    expect(commit(reviewed)).toBeUndefined();
    const reviewThenCommit = transcript([
      { name: "Agent", input: { subagent_type: "code-reviewer" } },
      { name: "Bash", input: { command: "git commit -m a" } },
      { name: "Edit", input: { file_path: "b.ts" } },
    ]);
    expect(commit(reviewThenCommit)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const deniedCommitDoesntCount = transcript([
      { name: "Agent", input: { subagent_type: "code-reviewer" } },
      { name: "Bash", input: { command: "git commit -m a" }, error: true },
    ]);
    expect(commit(deniedCommitDoesntCount)).toBeUndefined();
    // there is no marker Claude could add to get around the check
    const marked = runGhostHook(app, { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: folder, transcript_path: noReview, tool_input: { command: "git commit -m x # ghostos-skip-review" } }, {});
    expect(marked).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const failedReview = transcript([{ name: "Agent", input: { subagent_type: "code-reviewer" }, error: true }]);
    expect(commit(failedReview)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("only reminds when review enforcement is set to remind, and does nothing when off", () => {
    project();
    const app = appData();
    const t = transcript([{ name: "Edit", input: { file_path: "a.ts" } }]);
    const input = { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: folder, transcript_path: t, tool_input: { command: "git commit -m x" } };
    store.saveSettings({ ...store.getSettings(), enforcement: { ...store.getSettings().enforcement, reviewBeforeCommit: "remind" } });
    expect(JSON.stringify(runGhostHook(app, input, {}))).toContain("Reminder");
    store.saveSettings({ ...store.getSettings(), enforcement: { ...store.getSettings().enforcement, reviewBeforeCommit: "off" } });
    expect(runGhostHook(app, input, {})).toBeUndefined();
  });

  it("reminds about the documenter once after 5+ changed files", () => {
    project();
    const app = appData();
    const edits = ["a", "b", "c", "d", "e"].map((f) => ({ name: "Edit", input: { file_path: `${f}.ts` } }));
    const t = transcript(edits);
    const stop = { hook_event_name: "Stop", session_id: "11111111-2222-3333-4444-555555555555", cwd: folder, transcript_path: t };
    expect(runGhostHook(app, stop, {})).toMatchObject({ decision: "block" });
    expect(runGhostHook(app, stop, {})).toBeUndefined(); // once per session
    const documented = transcript([...edits, { name: "Agent", input: { subagent_type: "documenter" } }]);
    expect(runGhostHook(app, { ...stop, session_id: "22222222-2222-3333-4444-555555555555", transcript_path: documented }, {})).toBeUndefined();
  });

  it("reminds about the error log once, only where one exists", () => {
    project();
    const app = appData();
    const fail = { hook_event_name: "PostToolUseFailure", tool_name: "Bash", session_id: "33333333-2222-3333-4444-555555555555", cwd: folder };
    expect(runGhostHook(app, fail, {})).toBeUndefined();
    fs.mkdirSync(path.join(folder, "docs", "error-log"), { recursive: true });
    expect(JSON.stringify(runGhostHook(app, fail, {}))).toContain("error log");
    expect(runGhostHook(app, fail, {})).toBeUndefined();
  });

  it("recognises git commit after global options and in compound commands", () => {
    const yes = [
      "git commit -m x",
      "git -C /a/b commit",
      'git -C "dir with space" commit -m x',
      "git --git-dir /x/.git commit",
      "git -c user.name=x -c user.email=y commit -m s",
      "cd a && git --no-pager commit -am x",
      "npm test; /usr/bin/git commit -m ok",
      "GIT_AUTHOR_NAME=x sudo git commit",
      "git add . && git commit -F - <<'EOF'\nfix: thing\nEOF",
      "(cd sub && git commit -m y)",
    ];
    const no = [
      "git status",
      'git log --grep="git commit"',
      'echo "git commit"',
      "git commit-tree abc",
      "git commit --dry-run",
      'gh pr create --body "run git commit later"',
      "cat <<EOF > notes.md\ngit commit -m x\nEOF",
      "# git commit",
    ];
    for (const cmd of yes) expect(isCommitCommand(cmd), cmd).toBe(true);
    for (const cmd of no) expect(isCommitCommand(cmd), cmd).toBe(false);
  });

  it("parses tool uses and changed files from a transcript", () => {
    const uses: ToolUse[] = [
      { id: "1", name: "Write", input: { file_path: "a" } },
      { id: "2", name: "Edit", input: { file_path: "a" } },
      { id: "3", name: "Read", input: { file_path: "b" } },
    ];
    expect([...changedFiles(uses)]).toEqual(["a"]);
    expect(reviewedSinceLastCommit([{ id: "x", name: "Skill", input: { skill: "code-review" } }])).toBe(true);
  });
});

describe("capability installer", () => {
  function installer() {
    const claude = path.join(dir, "claude");
    fs.mkdirSync(path.join(claude, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(claude, "settings.json"),
      JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }),
    );
    fs.writeFileSync(path.join(claude, "agents", "researcher.md"), "the user's own researcher");
    return { claude, inst: new CapabilityInstaller({ claudeDir: claude, appData: appData(), nodeBinary: "/Apps/GhostOS", hookScript: "/x/ghostos-hook.js" }) };
  }

  it("adds its hooks next to the user's, backs up settings, writes agents and never overwrites the user's files", () => {
    const { claude, inst } = installer();
    store.saveAgent({ name: "researcher", scope: "global", content: "brain researcher" });
    store.saveAgent({ name: "stats-checker", scope: "research", content: "---\nname: stats-checker\ndescription: Checks stats\n---\nBody" });
    const plan = inst.apply(store.listAgents(), { "research": "Research" });
    const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(2); // the user's hook is kept
    expect(settings.hooks.PreToolUse[0]).toMatchObject({ matcher: "Bash", hooks: [{ if: "Bash(*git*commit*)" }] });
    expect(fs.readdirSync(path.join(dir, "app", "backups"))).toHaveLength(1);
    expect(fs.readFileSync(path.join(claude, "agents", "researcher.md"), "utf8")).toBe("the user's own researcher");
    expect(plan.files.find((f) => f.path.endsWith("researcher.md"))?.state).toBe("conflict");
    expect(fs.readFileSync(path.join(claude, "agents", "research-stats-checker.md"), "utf8")).toContain("name: research-stats-checker");
    // applying twice adds nothing more
    inst.apply(store.listAgents(), { "research": "Research" });
    expect(JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8")).hooks.Stop).toHaveLength(2);
  });

  it("removes only what it added, and keeps agent files the user edited", () => {
    const { claude, inst } = installer();
    store.saveAgent({ name: "a1", scope: "global", content: "one" });
    store.saveAgent({ name: "a2", scope: "global", content: "two" });
    inst.apply(store.listAgents(), {});
    fs.writeFileSync(path.join(claude, "agents", "a2.md"), "edited by the user");
    inst.remove();
    const settings = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8"));
    expect(settings.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    expect(fs.existsSync(path.join(claude, "agents", "a1.md"))).toBe(false);
    expect(fs.readFileSync(path.join(claude, "agents", "a2.md"), "utf8")).toBe("edited by the user");
    expect(inst.isApplied()).toBe(false);
  });

  it("labels area agents for their area", () => {
    const out = agentFileContent({ name: "planner", scope: "acme", content: "---\nname: planner\ndescription: Plans work\n---\nBody" }, "Acme");
    expect(out).toContain("name: acme-planner");
    expect(out).toContain("description: Plans work (For Acme projects.)");
  });
});

describe("another Mac", () => {
  it("normalises git remotes", () => {
    expect(normalizeRemote("git@github.com:Example/Diffusion.git")).toBe("github.com/example/diffusion");
    expect(normalizeRemote("https://github.com/example/diffusion")).toBe("github.com/example/diffusion");
  });

  it("suggests folders by git remote and by name", async () => {
    const repo = path.join(dir, "code", "diffusion");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:h/diffusion.git"], { cwd: repo });
    fs.mkdirSync(path.join(dir, "Mobile", "ACME"), { recursive: true });
    const p = store.createProject({
      name: "Two folders",
      area: "random",
      folders: [
        { label: "Diffusion", remote: "https://github.com/h/diffusion", paths: { mini: "/Users/h/Diffusion" } },
        { label: "ACME", paths: { mini: "/Users/h/Desktop/ACME" } },
      ],
    });
    const found = await suggestFolders(p, "macbook", [dir]);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ folderIndex: 0, path: repo, reason: "git remote" }),
        expect.objectContaining({ folderIndex: 1, path: path.join(dir, "Mobile", "ACME"), reason: "folder name" }),
      ]),
    );
  });
});

describe("brain sync", () => {
  it("keeps the newest version of an item that a merge left twice", () => {
    const a = { id: "x", createdAt: "2026-01-01", text: "old" };
    const b = { id: "x", createdAt: "2026-01-01", updatedAt: "2026-02-01", text: "new" };
    const c = { id: "y", createdAt: "2026-01-02", text: "other" };
    expect(latestById([b, c, a]).map((i) => i.text)).toEqual(["new", "other"]);
  });

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  it("syncs two brains through a remote, merging both Macs' appended lines", async () => {
    const remote = path.join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const brainA = store.dir;
    git(brainA, "init", "-q", "-b", "main");
    const syncA = new BrainSync(brainA, new BrainGit(brainA));
    syncA.ensureAttributes();
    store.addIdea("idea from the mini", null);
    git(brainA, "add", "-A");
    git(brainA, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    const first = await syncA.connect(remote);
    expect(first.error).toBeUndefined();

    const brainB = path.join(dir, "brainB");
    execFileSync("git", ["clone", "-q", remote, brainB]);
    const storeB = new BrainStore(brainB);
    storeB.addIdea("idea from the macbook", null);
    git(brainB, "add", "-A");
    git(brainB, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b");
    git(brainB, "push", "-q", "origin", "main");

    store.addIdea("second idea from the mini", null);
    git(brainA, "add", "-A");
    git(brainA, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
    const status = await syncA.sync();
    expect(status.error).toBeUndefined();
    expect(store.listIdeas().map((i) => i.text).sort()).toEqual(["idea from the macbook", "idea from the mini", "second idea from the mini"]);
    expect(status.ahead).toBe(0);
  });

  it("stops on a real conflict and leaves this Mac's brain as it was", async () => {
    const remote = path.join(dir, "remote2.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const brainA = store.dir;
    const gitA = new BrainGit(brainA);
    git(brainA, "init", "-q", "-b", "main");
    const p = project();
    await gitA.commitNow();
    const syncA = new BrainSync(brainA, gitA);
    expect((await syncA.connect(remote)).error).toBeUndefined();

    const brainB = path.join(dir, "brainB2");
    execFileSync("git", ["clone", "-q", remote, brainB]);
    new BrainStore(brainB).saveBrief(p.id, "brief from the macbook");
    git(brainB, "add", "-A");
    git(brainB, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b");
    git(brainB, "push", "-q", "origin", "main");

    store.saveBrief(p.id, "brief from the mini");
    const status = await syncA.sync();
    expect(status.error).toMatch(/both Macs changed/);
    expect(store.getBrief(p.id).trim()).toBe("brief from the mini");
    expect(fs.existsSync(path.join(brainA, ".git", "rebase-merge"))).toBe(false);
    expect(git(brainA, "status", "--porcelain")).toBe("");
  });

  it("refuses to merge a brain that started separately from the remote", async () => {
    const remote = path.join(dir, "remote3.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(other, "areas.yaml"), "[]\n");
    git(other, "add", "-A");
    git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "other");
    git(other, "push", "-q", remote, "main");

    const gitA = new BrainGit(store.dir);
    git(store.dir, "init", "-q", "-b", "main");
    await gitA.commitNow();
    const status = await new BrainSync(store.dir, gitA).connect(remote);
    expect(status.error).toMatch(/started separately/);
  });
});
