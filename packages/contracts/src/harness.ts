// Harness API and the daemon protocol (JSON-RPC 2.0, one JSON object per line on stdio).
// The desktop shell (Rust) spawns the daemon and speaks this protocol.
// Pinned apps reach the harness only through apps.run.

import type { AppJson, ArtifactBundle, BridgeResult } from "./artifact.js";
import type { Entitlement } from "./license.js";
import type { Effort, ProviderId, Usage, StopReason } from "./model.js";
import type { InstalledSkill, SkillIndexEntry, SkillIssue, SkillPermissions, SkillSource } from "./skill.js";
import type { ToolCall, ToolEffect, ToolResult } from "./tool.js";

export interface TaskRequest {
  input: string;
  provider: ProviderId;
  model: string;
  /** Continue an earlier session (memory of the conversation). */
  sessionId?: string;
  /** Force this skill to load, instead of routing. */
  skill?: string;
  /** No-skill baseline: give the model no skill index. Used by evals. */
  disableSkills?: boolean;
  effort?: Effort;
  maxTurns?: number;
  /** Where the request came from. Pinned apps are restricted to their allowed skills. */
  origin?: { kind: "main" } | { kind: "app"; appId: string } | { kind: "schedule"; scheduleId: string } | { kind: "eval" };
}

/**
 * Run event stream. Order: session_start first; exactly one done, last.
 * error is informational (it does not end the stream): a failed run emits error,
 * then done with stopReason "error". Listeners stop on done only.
 */
export type HarnessEvent =
  | { type: "session_start"; sessionId: string; runId: string }
  | { type: "skill_loaded"; name: string; reason: "router" | "forced" }
  | { type: "skill_file_read"; skill: string; file: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCall; effects: ToolEffect[] }
  | { type: "tool_end"; result: ToolResult; durationMs: number }
  | { type: "approval_request"; approvalId: string; call: ToolCall; effects: ToolEffect[]; summary: string }
  | { type: "approval_result"; approvalId: string; approved: boolean }
  | { type: "turn_end"; turn: number; usage: Usage }
  | { type: "done"; stopReason: StopReason | "max_turns" | "cancelled"; text: string; usage: Usage }
  | { type: "error"; message: string; retryable: boolean };

export interface ApprovalDecision {
  approved: boolean;
  /** Optional note from the person, passed to the model on denial. */
  note?: string;
}

export type ApprovalHandler = (req: {
  approvalId: string;
  call: ToolCall;
  effects: ToolEffect[];
  summary: string;
}) => Promise<ApprovalDecision>;

export interface HarnessApi {
  run(task: TaskRequest, onApproval: ApprovalHandler): AsyncIterable<HarnessEvent>;
}

// ---- Skill store (implemented by @oneseat/registry, consumed by harness/daemon) ----

export interface ScanFinding {
  severity: "block" | "warn" | "info";
  rule: string;
  file: string;
  line?: number;
  message: string;
}

export interface ScanReport {
  skill: string;
  verdict: "pass" | "warn" | "block";
  /** Plain-English summary of what the skill does and can touch. */
  summary: string;
  findings: ScanFinding[];
  declared: SkillPermissions;
  observed: SkillPermissions;
  filesRead: number;
  bytesRead: number;
}

export interface LintReport {
  skill: string;
  ok: boolean;
  issues: SkillIssue[];
}

export interface SkillStore {
  list(): Promise<InstalledSkill[]>;
  get(name: string): Promise<InstalledSkill | undefined>;
  index(): Promise<SkillIndexEntry[]>;
  /** Read a file inside an installed skill. Rejects paths outside the folder. */
  readFile(name: string, file: string): Promise<string>;
  /** Fetch, scan, lint, then install. Never installs on a block verdict. */
  install(source: SkillSource, opts?: { allowWarnings?: boolean }): Promise<InstallResult>;
  /** Fetch and scan only. */
  inspect(source: SkillSource): Promise<{ scan: ScanReport; lint: LintReport }>;
  remove(name: string): Promise<boolean>;
  /** Re-hash and check the signature of an installed skill. */
  verify(name: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface InstallResult {
  installed: boolean;
  skill?: InstalledSkill;
  scan: ScanReport;
  lint: LintReport;
  reason?: string;
}

// ---- Pinned apps ----

export interface PinnedApp {
  app: AppJson;
  /** Absolute path of the stored index.html. */
  htmlPath: string;
  pinnedAt: string;
}

// ---- Schedules ----

export interface Schedule {
  id: string;
  /** 5-field cron, local time. */
  cron: string;
  task: Omit<TaskRequest, "origin">;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
}

// ---- Daemon JSON-RPC methods ----

export interface DaemonMethods {
  "daemon.hello": { params: { client: string }; result: { version: string; protocol: 1 } };
  "auth.set": { params: { provider: ProviderId; apiKey: string; baseUrl?: string }; result: { ok: true } };
  "auth.clear": { params: { provider: ProviderId }; result: { ok: true } };
  "auth.status": { params: Record<string, never>; result: Record<ProviderId, boolean> };
  "models.list": { params: { provider: ProviderId }; result: { models: { id: string; label: string; tier?: string }[] } };
  "harness.run": { params: TaskRequest; result: { runId: string } };
  "harness.cancel": { params: { runId: string }; result: { ok: boolean } };
  "harness.approve": { params: { approvalId: string; approved: boolean; note?: string }; result: { ok: boolean } };
  "skills.list": { params: Record<string, never>; result: { skills: InstalledSkill[] } };
  "skills.inspect": { params: { source: string }; result: { scan: ScanReport; lint: LintReport } };
  "skills.install": { params: { source: string; allowWarnings?: boolean }; result: InstallResult };
  "skills.remove": { params: { name: string }; result: { ok: boolean } };
  "apps.pin": { params: ArtifactBundle; result: { app: PinnedApp } };
  "apps.list": { params: Record<string, never>; result: { apps: PinnedApp[] } };
  "apps.unpin": { params: { id: string }; result: { ok: boolean } };
  /** Called by the shell on behalf of a pinned window. appId is set by the shell, never by the page. */
  "apps.run": { params: { appId: string; skill: string; input: string | Record<string, unknown> }; result: BridgeResult };
  "schedules.list": { params: Record<string, never>; result: { schedules: Schedule[] } };
  "schedules.upsert": { params: Omit<Schedule, "lastRunAt" | "nextRunAt">; result: { schedule: Schedule } };
  "schedules.remove": { params: { id: string }; result: { ok: boolean } };
  "actions.log": { params: { limit?: number }; result: { entries: ActionLogEntry[] } };
  /** A make_artifact draft. The tool result carries only { draftId }; the shell fetches the bundle. */
  "apps.draft": { params: { draftId: string }; result: ArtifactBundle };
  "apps.drafts": { params: Record<string, never>; result: { drafts: ArtifactDraftInfo[] } };
  "mcp.status": { params: Record<string, never>; result: { servers: McpServerStatus[] } };
  /** The plan this computer is on. Free when no license is active. */
  "license.status": { params: Record<string, never>; result: Entitlement };
  /** Activate a license key with OneSeat Cloud for this computer. */
  "license.activate": { params: { licenseKey: string }; result: Entitlement };
  /** Free this computer's slot on the license and return to Free. */
  "license.deactivate": { params: Record<string, never>; result: Entitlement };
  /** Send pilot feedback to OneSeat Cloud. Never includes keys or business data unless typed. */
  "feedback.send": { params: FeedbackInput; result: { ok: boolean; id?: string } };
}

export interface FeedbackInput {
  message: string;
  /** 1 (bad) .. 5 (great). */
  rating?: number;
  email?: string;
  /** Free-form area, e.g. "invoices", "install", "approvals". */
  topic?: string;
}

export interface ArtifactDraftInfo {
  id: string;
  appId: string;
  name: string;
  createdAt: string;
}

export interface McpServerStatus {
  id: string;
  connected: boolean;
  tools: number;
  error?: string;
}

/** Notifications the daemon sends (no id). */
export interface DaemonNotifications {
  "harness.event": { runId: string; event: HarnessEvent };
  "schedule.fired": { scheduleId: string; runId: string };
}

export interface ActionLogEntry {
  at: string;
  runId: string;
  tool: string;
  effects: ToolEffect[];
  approved: boolean | null;
  isError: boolean;
  summary: string;
}

export type DaemonMethod = keyof DaemonMethods;

export interface RpcRequest<M extends DaemonMethod = DaemonMethod> {
  jsonrpc: "2.0";
  id: number | string;
  method: M;
  params: DaemonMethods[M]["params"];
}

export interface RpcResponse<M extends DaemonMethod = DaemonMethod> {
  jsonrpc: "2.0";
  id: number | string;
  result?: DaemonMethods[M]["result"];
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification<N extends keyof DaemonNotifications = keyof DaemonNotifications> {
  jsonrpc: "2.0";
  method: N;
  params: DaemonNotifications[N];
}

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notAuthorised: -32001,
  blocked: -32002,
  notFound: -32004,
  /** The feature needs a paid plan (see license.ts UPGRADE_ERROR_CODE). */
  upgradeRequired: -32003,
} as const;
