// The agent loop. One general agent, no sub-agents:
//   request -> stream text -> run tool calls (parallel when all read-only) ->
//   append tool results -> repeat, until end of turn, max turns, cancel or error.
// Every run emits session_start first and exactly one done last (an error event,
// when there is one, comes just before done).

import {
  requiresApproval,
  type ApprovalDecision,
  type ApprovalHandler,
  type ChatRequest,
  type ContentPart,
  type HarnessApi,
  type HarnessEvent,
  type Message,
  type ModelProvider,
  type ProviderError,
  type QuestionHandler,
  type Schedule,
  type SkillStore,
  type StopReason,
  type TaskRequest,
  type ToolCall,
  type ToolEffect,
  type ToolResult,
  type ToolResultPart,
  type ToolSpec,
  type Usage,
} from "@oneseat/contracts";
import { isReadOnly, summarizeAction } from "./approvals.js";
import { fitContext } from "./context.js";
import type { OneSeatDb } from "./db.js";
import { buildSystemPrompt, CORE_SKILL_TOOLS, SkillSession } from "./router.js";
import type { ScriptSandbox } from "./sandbox.js";
import type { ScheduleInput } from "./scheduler.js";
import { validateSchema } from "./schema.js";
import { ActionLog, ArtifactDrafts, MemoryStore, SessionStore } from "./stores.js";
import { createAskUserTool } from "./tools/ask.js";
import { createBuiltinTools } from "./tools/builtins.js";
import { ToolRegistry, type RegisteredTool, type ToolContext, type ToolOutput } from "./tools/registry.js";
import { createSkillTools, SKILL_TOOL_NAMES } from "./tools/skills.js";
import {
  AbortError,
  AsyncQueue,
  errorMessage,
  isRecord,
  newId,
  raceAbort,
  Redactor,
  silentLogger,
  sleep as defaultSleep,
  truncateText,
  type Logger,
  type SleepFn,
} from "./util.js";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface HarnessOptions {
  store: SkillStore;
  db: OneSeatDb;
  /** The model provider for a task (the daemon builds it from auth.set keys). */
  provider: (task: TaskRequest) => ModelProvider | Promise<ModelProvider>;
  workspaceDir: string;
  sandbox?: ScriptSandbox;
  /** Source of MCP tools (an McpManager). Read on every turn. */
  mcp?: { tools(): RegisteredTool[] };
  /** Backing store for schedule_task. */
  schedules?: { upsert(input: ScheduleInput): Schedule };
  extraTools?: RegisteredTool[];
  /** Skills a pinned app may use (origin.kind === "app"). Undefined or missing app means none. */
  appAllowedSkills?: (appId: string) => string[] | undefined | Promise<string[] | undefined>;
  maxTurns?: number;
  /** Max output tokens per model response. */
  maxTokens?: number;
  /** Estimated input budget before context management starts. */
  contextBudgetTokens?: number;
  /** Max characters of one tool result given to the model. */
  toolOutputCap?: number;
  retry?: RetryOptions;
  sleep?: SleepFn;
  now?: () => Date;
  redactor?: Redactor;
  logger?: Logger;
  preamble?: string;
}

export interface RunOptions {
  /** Use this run id (the daemon returns it before the run starts). */
  runId?: string;
  /** Further restrict the skills this run may use. */
  allowedSkills?: string[];
  signal?: AbortSignal;
  /** Answers ask_user questions. Without it, ask_user is not offered to the model. */
  onQuestion?: QuestionHandler;
}

export const DEFAULT_MAX_TURNS = 25;

class ProviderFailure extends Error {
  constructor(readonly error: ProviderError) {
    super(error.message);
  }
}

interface ModelTurn {
  parts: ContentPart[];
  text: string;
  calls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
}

interface PreparedCall {
  call: ToolCall;
  tool?: RegisteredTool;
  effects: ToolEffect[];
  summary: string;
  error?: string;
}

function addUsage(total: Usage, u: Usage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  if (u.cacheReadTokens !== undefined) total.cacheReadTokens = (total.cacheReadTokens ?? 0) + u.cacheReadTokens;
  if (u.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + u.cacheWriteTokens;
}

export class Harness implements HarnessApi {
  readonly registry = new ToolRegistry();
  readonly sessions: SessionStore;
  readonly memory: MemoryStore;
  readonly actions: ActionLog;
  readonly drafts: ArtifactDrafts;
  readonly redactor: Redactor;
  private readonly opts: HarnessOptions;
  private readonly logger: Logger;
  private readonly sleep: SleepFn;
  private readonly now: () => Date;
  private readonly runs = new Map<string, AbortController>();
  private readonly busySessions = new Set<string>();

  constructor(opts: HarnessOptions) {
    this.opts = opts;
    this.redactor = opts.redactor ?? new Redactor();
    this.logger = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? (() => new Date());
    this.sessions = new SessionStore(opts.db);
    this.memory = new MemoryStore(opts.db);
    this.actions = new ActionLog(opts.db, this.redactor);
    this.drafts = new ArtifactDrafts(opts.db);
    const builtins = createBuiltinTools({
      db: opts.db,
      memory: this.memory,
      drafts: this.drafts,
      store: opts.store,
      workspaceDir: opts.workspaceDir,
      now: this.now,
      ...(opts.schedules ? { schedules: opts.schedules } : {}),
    });
    for (const t of [...createSkillTools(opts.store, opts.sandbox), ...builtins, ...(opts.extraTools ?? [])])
      this.registry.register(t, { replace: true });
  }

  /** Start a run. Iterating the result streams its events; breaking out cancels it. */
  run(task: TaskRequest, onApproval: ApprovalHandler, opts: RunOptions = {}): AsyncIterable<HarnessEvent> {
    const runId = opts.runId ?? newId("run");
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const queue = new AsyncQueue<HarnessEvent>(() => controller.abort());
    this.runs.set(runId, controller);
    const emit = (e: HarnessEvent) => queue.push(this.redactEvent(e));
    void this.execute(runId, task, onApproval, opts, controller.signal, emit)
      .catch((e: unknown) => {
        this.logger.error(`run ${runId} crashed`, errorMessage(e));
        emit({ type: "error", message: errorMessage(e), retryable: false });
        emit({ type: "done", stopReason: "error", text: "", usage: { inputTokens: 0, outputTokens: 0 } });
      })
      .finally(() => {
        this.runs.delete(runId);
        queue.close();
      });
    return queue;
  }

  /** Cancel a running run. Returns false when no such run is active. */
  cancel(runId: string): boolean {
    const c = this.runs.get(runId);
    if (!c) return false;
    c.abort();
    return true;
  }

  isRunning(runId: string): boolean {
    return this.runs.has(runId);
  }

  activeRuns(): string[] {
    return [...this.runs.keys()];
  }

  private redactEvent(e: HarnessEvent): HarnessEvent {
    switch (e.type) {
      case "error":
        return { ...e, message: this.redactor.redact(e.message) };
      case "approval_request":
        return { ...e, summary: this.redactor.redact(e.summary) };
      case "question":
        return {
          ...e,
          question: this.redactor.redact(e.question),
          ...(e.options ? { options: e.options.map((o) => this.redactor.redact(o)) } : {}),
        };
      case "question_answered":
        return { ...e, answer: this.redactor.redact(e.answer) };
      default:
        return e;
    }
  }

  // ---------------------------------------------------------------------------

  private async execute(
    runId: string,
    task: TaskRequest,
    onApproval: ApprovalHandler,
    opts: RunOptions,
    signal: AbortSignal,
    emit: (e: HarnessEvent) => void,
  ): Promise<void> {
    const total: Usage = { inputTokens: 0, outputTokens: 0 };
    const finish = (stopReason: Extract<HarnessEvent, { type: "done" }>["stopReason"], text: string) =>
      emit({ type: "done", stopReason, text, usage: total });
    const failRun = (message: string, retryable = false) => {
      emit({ type: "error", message, retryable });
      finish("error", "");
    };

    if (!task || typeof task.input !== "string") return failRun("task.input must be a string");
    if (typeof task.model !== "string" || !task.model) return failRun("task.model is required");
    if (task.skill && task.disableSkills) return failRun("task.skill and task.disableSkills cannot be used together");

    // Which skills this run may use.
    let allowed = opts.allowedSkills;
    if (task.origin?.kind === "app") {
      const appSkills = (await this.opts.appAllowedSkills?.(task.origin.appId)) ?? [];
      allowed = allowed ? allowed.filter((s) => appSkills.includes(s)) : appSkills;
    }

    // Session.
    let sessionId = task.sessionId;
    let record = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!record) {
      sessionId = sessionId ?? newId("ses");
      record = this.sessions.create(sessionId, task);
    }
    const sid = record.id;
    if (this.busySessions.has(sid)) return failRun(`session ${sid} already has a run in progress`);
    this.busySessions.add(sid);
    try {
      const skills = new SkillSession({
        store: this.opts.store,
        disabled: task.disableSkills === true,
        ...(allowed ? { allowedSkills: allowed } : {}),
        loaded: record.loadedSkills,
      });
      emit({ type: "session_start", sessionId: sid, runId });

      if (task.skill) {
        const m = await skills.manifest(task.skill);
        if (!m) {
          const why = skills.isAllowed(task.skill) ? "is not installed" : "is not allowed here";
          return failRun(`skill "${task.skill}" ${why}`);
        }
        const before = skills.loaded.find((l) => l.name === task.skill)?.reason;
        skills.markLoaded(task.skill, "forced");
        if (before !== "forced") emit({ type: "skill_loaded", name: task.skill, reason: "forced" });
      }
      this.sessions.setLoadedSkills(sid, [...skills.loaded]);

      let provider: ModelProvider;
      try {
        provider = await this.opts.provider(task);
      } catch (e) {
        return failRun(errorMessage(e));
      }

      const history = this.sessions.messages(sid);
      const added: Message[] = [];
      const append = (m: Message) => {
        added.push(m);
        this.sessions.appendMessages(sid, runId, [m]);
      };
      // A key passed to auth.set never goes into a prompt or the stored history.
      append({ role: "user", content: [{ type: "text", text: this.redactor.redactKnown(task.input) }] });

      const ctx: ToolContext = { runId, sessionId: sid, task, signal, skills, emit };
      // Tools that exist only for this run: ask_user needs someone to answer.
      const runTools = opts.onQuestion ? [createAskUserTool(opts.onQuestion, this.redactor)] : [];
      const maxTurns = Math.max(1, Math.min(200, task.maxTurns ?? this.opts.maxTurns ?? DEFAULT_MAX_TURNS));
      let turn = 0;
      // Each turn's text, in order. See resultText for what the run returns.
      const texts: string[] = [];
      let stop: Extract<HarnessEvent, { type: "done" }>["stopReason"];
      let error: ProviderError | undefined;

      for (;;) {
        if (signal.aborted) {
          stop = "cancelled";
          break;
        }
        if (turn >= maxTurns) {
          stop = "max_turns";
          break;
        }
        turn++;
        const tools = await this.availableTools(skills, runTools);
        const specs: ToolSpec[] = tools.map((t) => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.inputSchema,
        }));
        const req = await this.buildRequest(task, skills, [...history, ...added], specs, signal, runTools.length > 0);
        let resp: ModelTurn;
        try {
          resp = await this.callModel(provider, req, emit, signal);
        } catch (e) {
          if (e instanceof AbortError || signal.aborted) {
            stop = "cancelled";
            break;
          }
          error = e instanceof ProviderFailure ? e.error : { kind: "unknown", message: errorMessage(e), retryable: false };
          stop = "error";
          break;
        }
        addUsage(total, resp.usage);
        emit({ type: "turn_end", turn, usage: resp.usage });
        if (resp.parts.length > 0) append({ role: "assistant", content: resp.parts });
        if (resp.text.trim()) texts.push(resp.text.trim());
        if (resp.calls.length === 0) {
          stop = resp.stopReason;
          break;
        }
        const results = await this.runTools(resp.calls, ctx, onApproval, runTools);
        append({ role: "user", content: results });
        this.sessions.setLoadedSkills(sid, [...skills.loaded]);
        if (signal.aborted) {
          stop = "cancelled";
          break;
        }
      }

      // Keep the stored conversation alternating: it must end with an assistant message.
      const last = added[added.length - 1];
      if (last && last.role === "user") {
        const note =
          stop === "max_turns"
            ? "[Stopped: reached the turn limit.]"
            : stop === "cancelled"
              ? "[Stopped: cancelled by the person.]"
              : stop === "error"
                ? "[Stopped: the model could not be reached.]"
                : "[No reply.]";
        append({ role: "assistant", content: [{ type: "text", text: note }] });
      }
      this.sessions.setLoadedSkills(sid, [...skills.loaded]);
      if (error) emit({ type: "error", message: error.message, retryable: error.retryable });
      finish(stop, resultText(texts));
    } finally {
      this.busySessions.delete(sid);
    }
  }

  private async buildRequest(
    task: TaskRequest,
    skills: SkillSession,
    messages: Message[],
    tools: ToolSpec[],
    signal: AbortSignal,
    canAsk: boolean,
  ): Promise<ChatRequest> {
    const index = await skills.index();
    const active = [];
    for (const l of skills.loaded) {
      if (l.reason !== "forced") continue;
      const m = await skills.manifest(l.name);
      if (m) active.push(m);
    }
    const base = {
      now: this.now(),
      skillsEnabled: !skills.disabled,
      index,
      active,
      ...(this.opts.preamble ? { preamble: this.opts.preamble } : {}),
      ...(canAsk ? { canAsk } : {}),
    };
    let system = buildSystemPrompt(base);
    const fit = fitContext({ system, messages, tools }, { budgetTokens: this.opts.contextBudgetTokens ?? 150_000 });
    const hints = fit.droppedSkillLoads.filter((n) => skills.isLoaded(n));
    if (hints.length > 0) system = buildSystemPrompt({ ...base, reloadHints: hints });
    const req: ChatRequest = {
      model: task.model,
      system,
      messages: fit.messages,
      tools,
      maxTokens: this.opts.maxTokens ?? 8192,
      signal,
    };
    if (task.effort) req.effort = task.effort;
    return req;
  }

  /** Tools the model may use right now: skill tools (unless disabled), built-ins, MCP, then the allowed-tools filter. */
  private async availableTools(skills: SkillSession, runTools: RegisteredTool[]): Promise<RegisteredTool[]> {
    const out: RegisteredTool[] = [];
    // A run's own tools (ask_user) win over a registry or MCP tool of the same name.
    const seen = new Set(runTools.map((t) => t.definition.name));
    const all = [...this.registry.list(), ...(this.opts.mcp?.tools() ?? [])];
    for (const t of all) {
      const name = t.definition.name;
      if (seen.has(name)) continue;
      seen.add(name);
      if ((SKILL_TOOL_NAMES as readonly string[]).includes(name) && skills.disabled) continue;
      if (!(await skills.toolAllowed(name))) continue;
      out.push(t);
    }
    return [...out, ...runTools];
  }

  private async callModel(
    provider: ModelProvider,
    req: ChatRequest,
    emit: (e: HarnessEvent) => void,
    signal: AbortSignal,
  ): Promise<ModelTurn> {
    const retry = this.opts.retry ?? {};
    const maxRetries = retry.maxRetries ?? 3;
    const base = retry.baseDelayMs ?? 500;
    const maxDelay = retry.maxDelayMs ?? 8000;
    for (let attempt = 0; ; attempt++) {
      const parts: ContentPart[] = [];
      const calls: ToolCall[] = [];
      let text = "";
      let pending = "";
      let emitted = false;
      let stopReason: StopReason | undefined;
      let usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let failure: ProviderError | undefined;
      // Streamed text is redacted with a hold-back, so a key split across chunks never shows.
      const shown = this.redactor.stream();
      const show = (t: string) => {
        if (t) emit({ type: "text_delta", text: t });
      };
      const flush = () => {
        show(shown.flush());
        if (pending) {
          parts.push({ type: "text", text: this.redactor.redactKnown(pending) });
          pending = "";
        }
      };
      try {
        for await (const ev of provider.send(req)) {
          if (signal.aborted) throw new AbortError();
          if (ev.type === "text_delta") {
            if (!ev.text) continue;
            emitted = true;
            pending += ev.text;
            text += ev.text;
            show(shown.push(ev.text));
          } else if (ev.type === "reasoning_done") {
            flush();
            parts.push(ev.part);
          } else if (ev.type === "tool_call") {
            emitted = true;
            flush();
            const input = isRecord(ev.call.input) ? this.redactor.redactValue(ev.call.input, true) : {};
            const call: ToolCall = { id: ev.call.id, name: ev.call.name, input };
            if (ev.call.providerMeta) call.providerMeta = ev.call.providerMeta;
            calls.push(call);
            parts.push({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input,
              ...(call.providerMeta ? { providerMeta: call.providerMeta } : {}),
            });
          } else if (ev.type === "message_end") {
            stopReason = ev.stopReason;
            usage = ev.usage;
          } else if (ev.type === "error") {
            failure = ev.error;
            break;
          }
        }
      } catch (e) {
        if (e instanceof AbortError || signal.aborted) throw new AbortError();
        failure = { kind: "network", message: errorMessage(e), retryable: true };
      }
      show(shown.flush());
      if (signal.aborted) throw new AbortError();
      if (!failure && stopReason === undefined)
        failure = { kind: "network", message: "the model stream ended early", retryable: true };
      if (!failure) {
        flush();
        return { parts, text: this.redactor.redactKnown(text), calls, stopReason: stopReason!, usage };
      }
      if (failure.kind === "aborted") throw new AbortError();
      // A provider asking for a longer wait than we would ever sleep (a daily quota: "retry in
      // 8h") will refuse again; report it now instead of stalling the run for minutes.
      const waitTooLong = failure.retryAfter !== undefined && failure.retryAfter * 1000 > maxDelay * 4;
      if (failure.retryable && !waitTooLong && !emitted && attempt < maxRetries) {
        const delay =
          failure.retryAfter !== undefined
            ? Math.min(maxDelay * 4, failure.retryAfter * 1000)
            : Math.min(maxDelay, base * 2 ** attempt) * (0.8 + Math.random() * 0.4);
        this.logger.warn(`model ${failure.kind}; retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)} ms`);
        await this.sleep(delay, signal);
        continue;
      }
      throw new ProviderFailure(failure);
    }
  }

  // ---------------------------------------------------------------------------
  // Tool execution

  private async prepare(call: ToolCall, ctx: ToolContext, runTools: RegisteredTool[]): Promise<PreparedCall> {
    const tool =
      runTools.find((t) => t.definition.name === call.name) ??
      this.registry.get(call.name) ??
      this.opts.mcp?.tools().find((t) => t.definition.name === call.name);
    const unknown = (msg: string): PreparedCall => ({
      call,
      effects: tool?.definition.effects ?? [],
      summary: `${call.name}: ${msg}`,
      error: msg,
    });
    if (!tool) return unknown(`Unknown tool "${call.name}".`);
    if ((SKILL_TOOL_NAMES as readonly string[]).includes(call.name) && ctx.skills.disabled)
      return unknown(`Tool "${call.name}" is not available: skills are off for this task.`);
    if (!(await ctx.skills.toolAllowed(call.name))) {
      const active = ctx.skills.loaded.map((l) => l.name).join(", ");
      return unknown(
        `Tool "${call.name}" is not allowed while skill ${active} is active. Allowed: the skill's allowed-tools plus ${CORE_SKILL_TOOLS.join(", ")}.`,
      );
    }
    const problems = validateSchema(tool.definition.inputSchema, call.input);
    if (problems.length > 0)
      return { ...unknown(`Invalid input for ${call.name}: ${problems.join("; ")}`), tool };
    try {
      const effects = (await tool.effectsFor?.(call.input, ctx)) ?? tool.definition.effects;
      const summary = (await tool.summarize?.(call.input, ctx)) ?? summarizeAction(call.name, call.input, effects);
      return { call, tool, effects, summary };
    } catch (e) {
      return { ...unknown(`Could not prepare ${call.name}: ${errorMessage(e)}`), tool };
    }
  }

  private async runTools(
    calls: ToolCall[],
    ctx: ToolContext,
    onApproval: ApprovalHandler,
    runTools: RegisteredTool[],
  ): Promise<ToolResultPart[]> {
    const prepared = await Promise.all(calls.map((c) => this.prepare(c, ctx, runTools)));
    const parallel = prepared.length > 1 && prepared.every((p) => p.error !== undefined || isReadOnly(p.effects));
    let results: ToolResult[];
    if (parallel) results = await Promise.all(prepared.map((p) => this.execOne(p, ctx, onApproval)));
    else {
      results = [];
      for (const p of prepared) results.push(await this.execOne(p, ctx, onApproval));
    }
    return results.map((r) => ({
      type: "tool_result",
      toolUseId: r.callId,
      name: r.name,
      content: r.content,
      ...(r.isError ? { isError: true } : {}),
    }));
  }

  private async execOne(p: PreparedCall, ctx: ToolContext, onApproval: ApprovalHandler): Promise<ToolResult> {
    const { call, effects } = p;
    ctx.emit({ type: "tool_start", call, effects });
    const started = Date.now();
    let approved: boolean | null = null;
    let out: ToolOutput;
    if (p.error !== undefined || !p.tool) out = { content: p.error ?? "unknown tool", isError: true };
    else if (ctx.signal.aborted) out = { content: "Cancelled before it ran.", isError: true };
    else {
      let decision: ApprovalDecision | undefined;
      if (requiresApproval(effects) || p.tool.alwaysAsk === true) {
        const approvalId = newId("apr");
        // Register the waiter before anyone can see the request, so an instant answer is never lost.
        const pending = onApproval({ approvalId, call, effects, summary: p.summary });
        ctx.emit({ type: "approval_request", approvalId, call, effects, summary: p.summary });
        try {
          decision = await raceAbort(pending, ctx.signal);
        } catch (e) {
          decision = { approved: false, note: e instanceof AbortError ? "the run was cancelled" : `approval failed: ${errorMessage(e)}` };
        }
        approved = decision.approved === true;
        ctx.emit({ type: "approval_result", approvalId, approved });
      }
      if (decision && !decision.approved) {
        const note = decision.note?.trim();
        out = {
          content: `The person declined this action (${p.summary}).${note ? ` Their note: "${note}".` : ""} Do not retry it or work around it; tell them what you would have done.`,
          isError: true,
        };
      } else {
        try {
          out = await p.tool.run(call.input, ctx);
        } catch (e) {
          out = { content: `Tool ${call.name} failed: ${errorMessage(e)}`, isError: true };
        }
      }
    }
    const cap = this.opts.toolOutputCap ?? 20_000;
    // Known secrets never reach the model, the log or the UI. (Pattern redaction would
    // mangle ordinary documents, so tool output gets exact-value redaction only.)
    const content = truncateText(this.redactor.redactKnown(out.content), cap, "tool output").text;
    const result: ToolResult = { callId: call.id, name: call.name, content, isError: out.isError === true };
    ctx.emit({ type: "tool_end", result, durationMs: Date.now() - started });
    try {
      this.actions.write({
        runId: ctx.runId,
        tool: call.name,
        effects,
        approved,
        isError: result.isError,
        summary: p.summary,
      });
    } catch (e) {
      this.logger.error("could not write the action log", errorMessage(e));
    }
    return result;
  }
}

export function createHarness(opts: HarnessOptions): Harness {
  return new Harness(opts);
}

/** Earlier-turn text at least this long is a deliverable (a draft, a table), not narration. */
export const RESULT_KEEP_CHARS = 160;

/**
 * A run's result text (done.text). A model often writes the deliverable, a draft or a report, and
 * then makes one more tool call (memory_save) before a short closing line such as "the draft is
 * above". Pinned apps and schedules get only done.text, so the final turn alone would lose the
 * draft. The result is the final turn's text plus each earlier turn's text that is long enough to
 * be a deliverable; one-line narration ("Adding the customer.") is left out.
 */
export function resultText(texts: readonly string[]): string {
  if (texts.length === 0) return "";
  const last = texts.length - 1;
  return texts.filter((t, i) => i === last || t.length >= RESULT_KEEP_CHARS).join("\n\n");
}
