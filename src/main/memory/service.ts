// Project memory: per-session summaries and the living project brief. Summaries run one at a time in
// the background (on Haiku), only when the budget guard allows, and either update the brief directly
// or leave a proposal for approval.
//
// Safety: the brief is written from transcripts, which can contain text from web pages or files, and it
// is then given to every new session. So a brief is never applied automatically when the session read
// web or MCP content, when the brief was edited while the summary ran, or when it grows too large; in
// those cases it becomes a proposal the user reviews.
import crypto from "node:crypto";
import fs from "node:fs";
import type { ChatEvent, SessionSummaryDoc } from "../../shared/types";
import type { BrainStore } from "../brain/store";
import { findTranscript, loadHistory } from "../claude/transcripts";
import { backgroundAllowed } from "../runs/budget";
import type { LocalState } from "../runs/local-state";
import { summarize, summaryPrompt, transcriptExcerpt, usedExternalContent, type SummaryResult, type TrackedThread } from "./summarizer";

/** Sessions with fewer exchanges than this aren't worth a summary. */
const MIN_EVENTS_TO_SUMMARIZE = 2;
/** A proposed brief longer than this isn't applied or proposed; the summary is still kept. */
export const BRIEF_PROPOSAL_MAX_CHARS = 8_000;

export interface MemoryJob {
  projectId: string;
  sessionId: string;
  cwd: string;
  /** true when the user asked for it (ignores the budget guard) */
  manual: boolean;
}

export type MemoryJobStatus = { projectId: string; sessionId: string; state: "queued" | "running" | "done" | "skipped" | "failed"; message?: string };

export interface MemoryServiceOptions {
  store: BrainStore;
  local: LocalState;
  claudeBinary: string;
  env: () => NodeJS.ProcessEnv;
  jobsDir: string;
  onStatus: (status: MemoryJobStatus) => void;
  onChanged: (projectId: string, reason: string) => void;
  /** Ghost's open threads for a project, so the summary can say which ones the session finished */
  trackedThreads?: (projectId: string) => TrackedThread[];
  /** called with the loop ids of tracked threads a session's summary says it finished */
  onThreadsResolved?: (projectId: string, sessionId: string, loopIds: string[]) => void;
  /** injectable for tests */
  run?: typeof summarize;
}

export const hashText = (text: string) => crypto.createHash("sha256").update(text.trim()).digest("hex");

export class MemoryService {
  private queue: MemoryJob[] = [];
  private current: MemoryJob | undefined;
  private busy = false;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(private readonly opts: MemoryServiceOptions) {
    fs.mkdirSync(opts.jobsDir, { recursive: true });
  }

  enqueue(job: MemoryJob): void {
    if (this.stopped) return;
    if (this.current?.sessionId === job.sessionId || this.queue.some((j) => j.sessionId === job.sessionId)) return;
    this.queue.push(job);
    this.opts.onStatus({ projectId: job.projectId, sessionId: job.sessionId, state: "queued" });
    void this.drain();
  }

  /** Called on quit: drops queued jobs and kills the running summary. Sessions can be summarized later. */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    this.abort.abort();
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && !this.stopped) {
        this.current = this.queue.shift()!;
        await this.process(this.current);
        this.current = undefined;
      }
    } finally {
      this.busy = false;
      this.current = undefined;
    }
  }

  private async process(job: MemoryJob): Promise<void> {
    const { store, local } = this.opts;
    const status = (state: MemoryJobStatus["state"], message?: string) =>
      this.opts.onStatus({ projectId: job.projectId, sessionId: job.sessionId, state, message });
    const project = store.getProject(job.projectId);
    const file = findTranscript(job.sessionId, [job.cwd]);
    if (!project || !file) return status("skipped", "No transcript for that session.");
    if (!job.manual && !backgroundAllowed(local.getUsage(), store.getSettings().budget, Date.now())) {
      return status("skipped", "Skipped to save usage (above the budget threshold).");
    }
    const events = loadHistory(file);
    if (events.filter((e) => e.kind === "user" || e.kind === "assistant-text").length < MIN_EVENTS_TO_SUMMARIZE) {
      return status("skipped", "Too short to summarize.");
    }
    status("running");
    const baseBrief = store.getBrief(job.projectId);
    // Threads from this same session's earlier summary are left out: it can't "finish" its own open items.
    const tracked = (this.opts.trackedThreads?.(job.projectId) ?? []).filter((t) => t.sessionId !== job.sessionId);
    let result: SummaryResult;
    try {
      result = await (this.opts.run ?? summarize)({
        claudeBinary: this.opts.claudeBinary,
        env: this.opts.env(),
        cwd: this.opts.jobsDir,
        prompt: summaryPrompt(project.name, baseBrief, transcriptExcerpt(events), tracked),
        signal: this.abort.signal,
      });
    } catch (err) {
      return status(this.stopped ? "skipped" : "failed", this.stopped ? "Stopped because GhostOS quit." : (err as Error).message);
    }
    this.apply(job, result, { baseBrief, events });
    const resolved = (result.resolvedThreads ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= tracked.length).map((n) => tracked[n - 1].loopId);
    if (resolved.length) this.opts.onThreadsResolved?.(job.projectId, job.sessionId, [...new Set(resolved)]);
    status("done");
  }

  /** Stores the summary and updates or proposes the brief. */
  apply(job: Pick<MemoryJob, "projectId" | "sessionId">, result: SummaryResult, context: { baseBrief: string; events: ChatEvent[] }): void {
    const { store } = this.opts;
    const summary: SessionSummaryDoc = {
      sessionId: job.sessionId,
      projectId: job.projectId,
      title: result.title.trim(),
      summary: result.summary.trim(),
      decisions: result.decisions.map((d) => d.trim()).filter(Boolean),
      openThreads: result.openThreads.map((t) => t.trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
    };
    store.saveSessionSummary(summary);
    this.opts.onChanged(job.projectId, "session summary");

    const proposed = result.brief.trim();
    if (!result.briefChanged || !proposed || proposed === context.baseBrief.trim() || proposed.length > BRIEF_PROPOSAL_MAX_CHARS) return;
    const briefUnchanged = hashText(store.getBrief(job.projectId)) === hashText(context.baseBrief);
    const automatic = store.getSettings().autoApplyBriefs && briefUnchanged && !usedExternalContent(context.events);
    if (automatic) {
      store.saveBrief(job.projectId, proposed);
      store.saveBriefProposal(job.projectId, undefined);
      this.opts.onChanged(job.projectId, "brief updated");
    } else {
      store.saveBriefProposal(job.projectId, {
        text: proposed,
        sessionId: job.sessionId,
        createdAt: summary.createdAt,
        baseHash: hashText(context.baseBrief),
      });
      this.opts.onChanged(job.projectId, "brief update proposed");
    }
  }
}
