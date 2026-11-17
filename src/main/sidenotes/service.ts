// Sidenotes: passing thoughts about the chat you're in. Each one is either added to that chat as
// context ("now" = after Claude's next tool batch, "after" = when the turn ends or with your next
// message) or saved with the chat to come back to ("later"). Records live in the brain; delivery
// goes through the hook's inbox.
import type { BrainStore } from "../brain/store";
import type { Idea, Sidenote, SidenoteMode } from "../../shared/types";
import type { Delivery, Inbox } from "./inbox";

export class SidenoteService {
  constructor(
    private readonly store: BrainStore,
    private readonly inbox: Inbox,
  ) {}

  add(input: { projectId: string; sessionId: string; text: string; mode: SidenoteMode }): Sidenote {
    const deliver = input.mode !== "later";
    const note = this.store.addSidenote({
      projectId: input.projectId,
      sessionId: input.sessionId,
      text: input.text,
      mode: input.mode,
      status: deliver ? "queued" : "saved",
    });
    if (deliver) this.inbox.enqueue(note.sessionId, { id: note.id, text: note.text, mode: input.mode as "now" | "after" });
    return note;
  }

  /** Sends a saved note into its session; it arrives when the current turn ends or with the next message. */
  send(projectId: string, id: string): Sidenote {
    const note = this.find(projectId, id);
    if (note.status !== "saved") return note;
    this.inbox.enqueue(note.sessionId, { id: note.id, text: note.text, mode: "after" });
    return this.store.updateSidenote(projectId, id, { mode: "after", status: "queued" });
  }

  /** Takes back a queued note that Claude hasn't received yet; it becomes a saved note. */
  withdraw(projectId: string, id: string): Sidenote {
    const note = this.find(projectId, id);
    if (note.status !== "queued") return note;
    if (!this.inbox.withdraw(note.sessionId, id)) return note; // the hook delivered it just now
    return this.store.updateSidenote(projectId, id, { mode: "later", status: "saved" });
  }

  promote(projectId: string, id: string): Idea {
    return this.store.addIdea(this.find(projectId, id).text, projectId);
  }

  /** Marks notes delivered; returns the projects whose notes changed. */
  applyDeliveries(deliveries: Delivery[]): Set<string> {
    const changed = new Set<string>();
    if (!deliveries.length) return changed;
    const byId = new Map(deliveries.map((d) => [d.noteId, d]));
    for (const project of this.store.listProjects()) {
      for (const note of this.store.listSidenotes(project.id)) {
        const delivery = byId.get(note.id);
        if (!delivery || note.status === "delivered") continue;
        this.store.updateSidenote(project.id, note.id, { status: "delivered", deliveredAt: delivery.at });
        changed.add(project.id);
      }
    }
    return changed;
  }

  private find(projectId: string, id: string): Sidenote {
    const note = this.store.listSidenotes(projectId).find((n) => n.id === id);
    if (!note) throw new Error("That sidenote no longer exists.");
    return note;
  }
}
