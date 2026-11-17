// The file protocol between GhostOS (which queues sidenotes) and the sidenote hook (which delivers them).
// Shared by both sides; contains no side effects.
//
// <inboxDir>/<sessionId>/<timestamp>-<noteId>.json      a queued note
// <inboxDir>/<sessionId>/<timestamp>-<noteId>.claimed   a note a hook is delivering right now
// <inboxDir>/<sessionId>/delivered.jsonl                one line per delivered note

export interface InboxNote {
  id: string;
  text: string;
  mode: "now" | "after";
}

export const DELIVERED_LOG = "delivered.jsonl";
export const NOTE_SUFFIX = ".json";
export const CLAIMED_SUFFIX = ".claimed";
/** A claim older than this was left by a hook that died mid-delivery; the note is delivered again. */
export const STALE_CLAIM_MS = 30_000;

/** Claude session ids are UUIDs; anything else is refused before it becomes part of a path. */
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}
