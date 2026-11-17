import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainStore, DEFAULT_AREAS, slugify } from "../src/main/brain/store";

let dir: string;
let store: BrainStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghostos-brain-"));
  store = new BrainStore(dir);
  store.ensure();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("areas", () => {
  it("starts with Work, Personal, Research and Random", () => {
    expect(store.listAreas().map((a) => a.name)).toEqual(DEFAULT_AREAS.map((a) => a.name));
  });

  it("adds, renames and reorders areas", () => {
    const area = store.addArea("Side quests");
    store.renameArea(area.id, "Side projects");
    store.moveArea(area.id, -1);
    const names = store.listAreas().map((a) => a.name);
    expect(names.at(-2)).toBe("Side projects");
    expect(names.at(-1)).toBe("Random");
  });

  it("moves projects to Random when their area is removed, and refuses to remove Random", () => {
    const project = store.createProject({ name: "Press kit", area: "pr" });
    store.removeArea("pr");
    expect(store.getProject(project.id)?.area).toBe("random");
    expect(() => store.removeArea("random")).toThrow();
  });
});

describe("projects", () => {
  it("creates projects with unique ids and moves them between areas", () => {
    const a = store.createProject({ name: "Acme App", area: "work" });
    const b = store.createProject({ name: "Acme App", area: "work" });
    expect(a.id).toBe("acme-app");
    expect(b.id).not.toBe(a.id);
    store.updateProject(a.id, { area: "work" });
    expect(store.getProject(a.id)?.area).toBe("work");
  });

  it("files a project under Random when its area doesn't exist", () => {
    expect(store.createProject({ name: "Loose", area: "nope" }).area).toBe("random");
  });

  it("keeps folder paths per machine and merges by git remote", () => {
    const p = store.createProject({ name: "Diffusion", area: "research" });
    store.addFolder(p.id, "mini", "/Users/h/Diffusion", "git@github.com:h/diffusion.git");
    const updated = store.addFolder(p.id, "macbook", "/Users/h/code/diffusion", "git@github.com:h/diffusion.git");
    expect(updated.folders).toHaveLength(1);
    expect(updated.folders[0].paths).toEqual({ mini: "/Users/h/Diffusion", macbook: "/Users/h/code/diffusion" });
    const removed = store.removeFolder(p.id, "mini", "/Users/h/Diffusion");
    expect(removed.folders[0].paths).toEqual({ macbook: "/Users/h/code/diffusion" });
  });

  it("writes human-readable YAML manifests", () => {
    const p = store.createProject({ name: "Reel editor", area: "random" });
    const yaml = fs.readFileSync(path.join(dir, "projects", p.id, "project.yaml"), "utf8");
    expect(yaml).toContain("name: Reel editor");
    expect(yaml).toContain("area: random");
  });
});

describe("ideas and sidenotes", () => {
  it("adds ideas, re-files them and archives them", () => {
    const idea = store.addIdea("  Try a judge ensemble  ", null);
    expect(idea.text).toBe("Try a judge ensemble");
    store.updateIdea(idea.id, { projectId: "persona", status: "archived" });
    expect(store.listIdeas()[0]).toMatchObject({ projectId: "persona", status: "archived" });
  });

  it("rejects empty ideas and sidenotes", () => {
    expect(() => store.addIdea("   ", null)).toThrow();
    const p = store.createProject({ name: "X", area: "random" });
    expect(() => store.addSidenote({ projectId: p.id, sessionId: "s", text: " ", mode: "now", status: "queued" })).toThrow();
  });

  it("stores sidenotes per project and updates their status", () => {
    const p = store.createProject({ name: "Orion", area: "research" });
    const note = store.addSidenote({ projectId: p.id, sessionId: "abc", text: "check seed 3", mode: "now", status: "queued" });
    store.updateSidenote(p.id, note.id, { status: "delivered", deliveredAt: "2026-11-13T00:00:00Z" });
    expect(store.listSidenotes(p.id)[0]).toMatchObject({ text: "check seed 3", status: "delivered" });
  });

  it("skips a corrupt jsonl line, and backs the original up before rewriting", () => {
    store.addIdea("first", null);
    fs.appendFileSync(path.join(dir, "ideas.jsonl"), "<<<<<<< HEAD\n");
    store.addIdea("second", null);
    expect(store.listIdeas().map((i) => i.text)).toEqual(["first", "second"]);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("ideas.jsonl.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toContain("<<<<<<< HEAD");
    expect(store.warnings().join(" ")).toContain("ideas.jsonl");
  });
});

describe("damaged files", () => {
  it("shows default areas but refuses to overwrite an unreadable areas.yaml", () => {
    fs.writeFileSync(path.join(dir, "areas.yaml"), "areas: [unclosed");
    expect(store.listAreas().map((a) => a.id)).toContain("random");
    expect(store.warnings().join(" ")).toContain("areas.yaml");
    expect(() => store.addArea("New")).toThrow(/won't be overwritten/);
    expect(fs.readFileSync(path.join(dir, "areas.yaml"), "utf8")).toBe("areas: [unclosed");
  });

  it("never reuses the folder of a project whose manifest is unreadable", () => {
    const p = store.createProject({ name: "Signal", area: "random" });
    fs.writeFileSync(path.join(dir, "projects", p.id, "project.yaml"), "name: [broken");
    const again = store.createProject({ name: "Signal", area: "random" });
    expect(again.id).not.toBe(p.id);
    store.listProjects();
    expect(store.warnings().join(" ")).toContain(p.id);
  });
});

describe("slugify", () => {
  it("makes safe folder names", () => {
    expect(slugify("Satellite Viewer")).toBe("satellite-viewer");
    expect(slugify("!!!")).toBe("item");
  });
});
