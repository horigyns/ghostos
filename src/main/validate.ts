// Runtime checks for everything the renderer sends over IPC. TypeScript types don't exist at runtime,
// so ids, folders and options are verified here before they reach the filesystem, a process or the shell.
import fs from "node:fs";
import path from "node:path";
import type { PermissionMode, ProjectView } from "../shared/types";
import { isSessionId } from "../shared/hook-protocol";

const SLUG_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const SHORT_ID = /^[a-f0-9]{4,32}$/;
const MODEL_NAME = /^[a-zA-Z0-9.\-[\]]{1,60}$/;
const MAX_TEXT_CHARS = 20_000;
const MAX_NAME_CHARS = 120;
export const PERMISSION_MODES: readonly PermissionMode[] = ["auto", "acceptEdits", "plan", "manual"];

export function slugId(value: unknown, what: string): string {
  if (typeof value !== "string" || !SLUG_ID.test(value)) throw new Error(`Invalid ${what}.`);
  return value;
}

export function shortId(value: unknown, what: string): string {
  if (typeof value !== "string" || !SHORT_ID.test(value)) throw new Error(`Invalid ${what}.`);
  return value;
}

export function sessionId(value: unknown): string {
  if (!isSessionId(value)) throw new Error("Invalid session id.");
  return value;
}

export function text(value: unknown, what: string, max = MAX_TEXT_CHARS): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} can't be empty.`);
  if (value.length > max) throw new Error(`${what} is too long.`);
  return value;
}

export function name(value: unknown, what: string): string {
  return text(value, what, MAX_NAME_CHARS);
}

export function permissionMode(value: unknown): PermissionMode {
  if (value === undefined) return "auto";
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new Error("Unknown permission mode.");
  return value as PermissionMode;
}

export function model(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !MODEL_NAME.test(value)) throw new Error("Invalid model name.");
  return value;
}

/** Keeps only the listed keys of a patch object. */
export function pick<K extends string>(patch: unknown, keys: readonly K[]): Partial<Record<K, unknown>> {
  if (!patch || typeof patch !== "object") return {};
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) if (key in patch) out[key] = (patch as Record<string, unknown>)[key];
  return out;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `candidate` is one of the project's folders on this Mac, or inside one. */
export function isInProject(project: ProjectView, candidate: unknown, allowSubfolder: boolean): candidate is string {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
  const target = real(candidate);
  return project.localFolders.some((f) => {
    const root = real(f.path);
    return target === root || (allowSubfolder && target.startsWith(root + path.sep));
  });
}

/** A folder the shell may open: an existing directory that belongs to some project on this Mac. */
export function projectFolder(projects: ProjectView[], candidate: unknown): string {
  const owner = projects.find((p) => isInProject(p, candidate, false));
  if (!owner || !fs.statSync(candidate as string).isDirectory()) throw new Error("That folder isn't part of a project.");
  return candidate as string;
}
