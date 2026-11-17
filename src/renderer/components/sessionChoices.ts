// Choices and words for starting Claude sessions, shared by the session, chat list and run screens.
import type { GhostLoop, PermissionMode } from "../../shared/types";

export const MODEL_CHOICES = [
  { value: "", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "fable", label: "Fable" },
];
export const PERMISSION_CHOICES: { value: PermissionMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan only" },
  { value: "manual", label: "Ask first" },
];
/** Short label for a model choice ("" is the user's default). */
export function modelLabel(model: string): string {
  return model ? model : "default";
}

/** Words to start a chat on a loop. */
export function loopPrompt(loop: GhostLoop): string {
  switch (loop.kind) {
    case "thread":
      return `Let's pick this up: ${loop.title}${loop.detail ? ` (${loop.detail.replace(/^From /, "from ")})` : ""}. Check where it stands first, then propose the next step.`;
    case "uncommitted":
      return `There's unfinished work: ${loop.title}${loop.detail ? ` ${loop.detail}` : ""}. Look at the changes, tell me what they are and whether they're ready, and what's left before committing.`;
    case "unpushed":
      return `${loop.title}. Review those commits and tell me whether they're ready to push or open a PR.`;
    case "branches":
      return `${loop.title}: ${loop.detail ?? ""}. For each branch, tell me what it contains and whether to merge, finish or delete it.`;
    case "run-failed":
      return `${loop.title}${loop.detail ? ` (${loop.detail})` : ""}. Find out why and fix it.`;
    case "sidenote":
      return loop.title.replace(/^Saved note: /, "");
  }
}
