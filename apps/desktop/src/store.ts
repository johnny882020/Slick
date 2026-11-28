// App-wide state shared by the views: key status, daemon status, runs, drafts.

import type { ArtifactBundle, HarnessEvent } from "@oneseat/contracts";
import { makeDraft, type ArtifactDraft } from "./artifacts";
import type { DaemonNotification, DaemonStatus, KeyStatus } from "./protocol";
import { addDrafts, draftIdFromToolResult, initialRun, pendingApprovals, reduceRun, type ApprovalItem, type RunMeta, type RunState } from "./run-state";

export type Change =
  | { type: "keys" }
  | { type: "daemon" }
  | { type: "run"; runId: string }
  | { type: "approvals" }
  | { type: "drafts" }
  | { type: "schedule.fired"; scheduleId: string; runId: string };

export interface PendingApproval extends ApprovalItem {
  runId: string;
}

const MAX_RUNS = 50;

export class Store {
  keyStatus: KeyStatus | null = null;
  daemon: DaemonStatus | null = null;
  readonly runs = new Map<string, RunState>();
  /** Run shown in the Run view. */
  currentRunId: string | null = null;
  /** Draft keys already pinned in this session. */
  readonly pinnedDrafts = new Set<string>();
  /** Approvals answered here, before approval_result confirms. */
  readonly decided = new Map<string, boolean>();
  private readonly subs = new Set<(c: Change) => void>();

  subscribe(fn: (c: Change) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(c: Change): void {
    for (const fn of this.subs) {
      try {
        fn(c);
      } catch (e) {
        console.error(e);
      }
    }
  }

  setKeyStatus(s: KeyStatus): void {
    this.keyStatus = s;
    if (s.daemon) this.daemon = s.daemon;
    this.emit({ type: "keys" });
  }

  setDaemon(s: DaemonStatus): void {
    this.daemon = s;
    this.emit({ type: "daemon" });
  }

  /** Providers with a stored key. */
  readyProviders(): string[] {
    return (this.keyStatus?.providers ?? []).filter((p) => p.stored).map((p) => p.provider);
  }

  hasAnyKey(): boolean {
    return this.readyProviders().length > 0;
  }

  /** Register a run this UI started (events may already have arrived). */
  startRun(runId: string, input: string, meta: RunMeta = {}): RunState {
    const existing = this.runs.get(runId);
    const run = { ...(existing ?? initialRun(runId, input)), input, ...meta };
    this.runs.set(runId, run);
    this.currentRunId = runId;
    this.trim();
    this.emit({ type: "run", runId });
    return run;
  }

  applyEvent(runId: string, event: HarnessEvent): void {
    const before = this.runs.get(runId) ?? initialRun(runId);
    const after = reduceRun(before, event);
    this.runs.set(runId, after);
    this.trim();
    this.emit({ type: "run", runId });
    if (event.type === "approval_request" || event.type === "approval_result" || event.type === "done" || event.type === "error") {
      if (event.type === "approval_result") this.decided.delete(event.approvalId);
      this.emit({ type: "approvals" });
    }
    if (after.artifacts.length !== before.artifacts.length) this.emit({ type: "drafts" });
    if (event.type === "tool_end" && this.draftFetcher) {
      const id = draftIdFromToolResult(event.result.name, event.result.content, event.result.isError);
      if (id) void this.fetchDraft(runId, id);
    }
  }

  private draftFetcher: ((draftId: string) => Promise<ArtifactBundle>) | undefined;

  /** make_artifact results carry a draft id; this loads the bundle (daemon apps.draft). */
  setDraftFetcher(fetcher: (draftId: string) => Promise<ArtifactBundle>): void {
    this.draftFetcher = fetcher;
  }

  private async fetchDraft(runId: string, draftId: string): Promise<void> {
    try {
      const bundle = await this.draftFetcher!(draftId);
      this.addDraftBundle(runId, bundle);
    } catch {
      /* the draft stays reachable from the daemon's apps.drafts list */
    }
  }

  addDraftBundle(runId: string, bundle: ArtifactBundle): void {
    const run = this.runs.get(runId) ?? initialRun(runId);
    const next = addDrafts(run, [makeDraft(runId, bundle)]);
    if (next === run) return;
    this.runs.set(runId, next);
    this.emit({ type: "run", runId });
    this.emit({ type: "drafts" });
  }

  handleNotification(n: DaemonNotification): void {
    if (n.method === "harness.event") this.applyEvent(n.params.runId, n.params.event);
    else if (n.method === "schedule.fired") this.emit({ type: "schedule.fired", scheduleId: n.params.scheduleId, runId: n.params.runId });
  }

  /** The conversation a run belongs to, oldest turn first, ending with this run. */
  conversation(runId: string): RunState[] {
    const out: RunState[] = [];
    const seen = new Set<string>();
    let run = this.runs.get(runId);
    while (run && !seen.has(run.runId)) {
      seen.add(run.runId);
      out.unshift(run);
      run = run.followsRunId ? this.runs.get(run.followsRunId) : undefined;
    }
    return out;
  }

  /** The latest run of each conversation, oldest first. */
  conversationTips(): RunState[] {
    const followed = new Set<string>();
    for (const r of this.runs.values()) if (r.followsRunId) followed.add(r.followsRunId);
    return [...this.runs.values()].filter((r) => !followed.has(r.runId));
  }

  /** Approvals still waiting for a person, oldest first, across all runs. */
  pendingApprovals(): PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const run of this.runs.values())
      for (const a of pendingApprovals(run)) if (!this.decided.has(a.approvalId)) out.push({ ...a, runId: run.runId });
    return out;
  }

  markDecided(approvalId: string, approved: boolean): void {
    this.decided.set(approvalId, approved);
    this.emit({ type: "approvals" });
  }

  undoDecided(approvalId: string): void {
    this.decided.delete(approvalId);
    this.emit({ type: "approvals" });
  }

  /** Drafts from all runs that have not been pinned here yet, newest first. */
  drafts(): ArtifactDraft[] {
    const out: ArtifactDraft[] = [];
    for (const run of this.runs.values()) for (const d of run.artifacts) if (!this.pinnedDrafts.has(d.key)) out.push(d);
    return out.reverse();
  }

  markPinned(key: string): void {
    this.pinnedDrafts.add(key);
    this.emit({ type: "drafts" });
  }

  private trim(): void {
    while (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value as string;
      if (oldest === this.currentRunId) break;
      this.runs.delete(oldest);
    }
  }
}
