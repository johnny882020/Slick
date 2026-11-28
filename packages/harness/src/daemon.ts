// The daemon: every DaemonMethods method over JSON-RPC 2.0 (newline-delimited).
// harness.run returns {runId} at once and streams harness.event notifications;
// approvals come back through harness.approve. Keys from auth.set live in memory
// only and are redacted from every log line, event and error.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  freeEntitlement,
  parseSkillSource,
  PROVIDER_IDS,
  upgradeMessage,
  type Feature,
  RPC_ERRORS,
  type ApprovalDecision,
  type ApprovalHandler,
  type ArtifactBundle,
  type BridgeResult,
  type DaemonMethod,
  type DaemonMethods,
  type DaemonNotifications,
  type HarnessEvent,
  type ProviderConfig,
  type ProviderFactory,
  type ProviderId,
  type Schedule,
  type SkillSearchResult,
  type SkillSource,
  type SkillStore,
  type TaskRequest,
} from "@oneseat/contracts";
import { AppError, AppStore, bridgeResult } from "./apps.js";
import { CronError } from "./cron.js";
import { OneSeatDb } from "./db.js";
import { Harness, type HarnessOptions } from "./harness.js";
import { LicenseError, type LicenseManager } from "./license.js";
import { McpManager, type McpServerStatus } from "./mcp/manager.js";
import { RpcError, serveLines, type LineConnection } from "./rpc.js";
import { ScriptSandbox, findDeno } from "./sandbox.js";
import { Scheduler } from "./scheduler.js";
import { ScheduleStore } from "./stores.js";
import { installResult, listBundledSkills, RemovedStarters } from "./starters.js";
import { createLogger, errorMessage, isRecord, newId, Redactor, type Logger } from "./util.js";

export const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
  store: SkillStore;
  providers: Partial<Record<ProviderId, ProviderFactory>>;
  dataDir: string;
  denoPath?: string;
  mcpConfigPath?: string;
  /** Default <dataDir>/workspace. */
  workspaceDir?: string;
  /** Model for apps.run (it carries no provider/model). Default: the last harness.run model. */
  defaultModel?: { provider: ProviderId; model: string };
  /** Injectable clock for the scheduler and the harness. */
  now?: () => Date;
  schedulerIntervalMs?: number;
  /** Start the scheduler tick loop on start (default true). */
  startScheduler?: boolean;
  /** Where log lines go (default stderr). Lines are always redacted. */
  log?: (line: string) => void;
  /** Overrides for the harness (maxTurns, retry, sleep, budgets...). */
  harness?: Partial<Omit<HarnessOptions, "store" | "db" | "provider" | "workspaceDir" | "redactor" | "logger">>;
  /**
   * The computer's OneSeat plan. When set, paid features (importing skills, pinned apps,
   * schedules, MCP connectors) need a plan that includes them. When unset nothing is gated.
   */
  license?: LicenseManager;
  /**
   * Starter skills shipped with the app. A removed starter skill is remembered (so the next
   * start does not put it back) and can be put back with skills.restore.
   */
  bundledSkillsDir?: string;
  /**
   * Search skills.sh (the sidecar wires @oneseat/registry's searchSkillsSh). Without it,
   * skills.search answers "not available".
   */
  searchSkills?: (query: string) => Promise<Omit<SkillSearchResult, "installed">[]>;
}

/** Methods the daemon adds beyond the contract (see the stream B report). */
export interface DaemonExtraMethods {
  "apps.draft": { params: { draftId: string }; result: ArtifactBundle };
  "apps.drafts": { params: Record<string, never>; result: { drafts: { id: string; appId: string; name: string; createdAt: string }[] } };
  "mcp.status": { params: Record<string, never>; result: { servers: McpServerStatus[] } };
}

type AllMethods = DaemonMethods & DaemonExtraMethods;
type Notification = { [N in keyof DaemonNotifications]: { method: N; params: DaemonNotifications[N] } }[keyof DaemonNotifications];

export interface Daemon {
  /** Resolves once MCP servers are loaded and the scheduler started. */
  readonly ready: Promise<void>;
  readonly harness: Harness;
  readonly scheduler: Scheduler;
  readonly db: OneSeatDb;
  readonly apps: AppStore;
  readonly redactor: Redactor;
  readonly logger: Logger;
  handle<M extends keyof AllMethods>(method: M, params: AllMethods[M]["params"]): Promise<AllMethods[M]["result"]>;
  /** Untyped entry point used by the transport. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Listen to notifications (harness.event, schedule.fired). */
  subscribe(listener: (n: Notification) => void): () => void;
  /** Serve one client over a pair of streams. */
  connect(input: Readable, output: Writable): LineConnection;
  close(): Promise<void>;
}

function invalid(message: string): never {
  throw new RpcError(RPC_ERRORS.invalidParams, message);
}

function str(p: Record<string, unknown>, key: string, opts: { optional?: boolean } = {}): string | undefined {
  const v = p[key];
  if (v === undefined && opts.optional) return undefined;
  if (typeof v !== "string" || v === "") invalid(`${key} must be a non-empty string`);
  return v;
}

/**
 * A skill source from the UI. Also takes "skills.sh:owner/repo/skill" (a search result id,
 * as the contract names it) and "skills.sh:owner/repo@skill".
 */
export function parseSourceText(text: string): SkillSource {
  const t = text.trim();
  if (!t.startsWith("skills.sh:")) return parseSkillSource(t);
  const rest = t.slice("skills.sh:".length);
  const id = rest.match(/^([^/@\s]+)\/([^/@\s]+)\/([^/@\s]+)$/);
  const src = parseSkillSource(id ? `${id[1]}/${id[2]}@${id[3]}` : rest);
  if (src.kind !== "skills.sh") invalid(`"${text}" is not a skills.sh name like owner/repo@skill`);
  return src;
}

/** Longest skills.search query. */
const SEARCH_QUERY_MAX = 200;

function providerId(v: unknown): ProviderId {
  if (typeof v !== "string" || !(PROVIDER_IDS as readonly string[]).includes(v))
    invalid(`provider must be one of ${PROVIDER_IDS.join(", ")}`);
  return v as ProviderId;
}

function validateTask(raw: unknown, what = "params"): TaskRequest {
  if (!isRecord(raw)) invalid(`${what} must be an object`);
  if (typeof raw["input"] !== "string") invalid(`${what}.input must be a string`);
  providerId(raw["provider"]);
  if (typeof raw["model"] !== "string" || !raw["model"]) invalid(`${what}.model must be a non-empty string`);
  for (const k of ["sessionId", "skill"] as const)
    if (raw[k] !== undefined && typeof raw[k] !== "string") invalid(`${what}.${k} must be a string`);
  if (raw["disableSkills"] !== undefined && typeof raw["disableSkills"] !== "boolean") invalid(`${what}.disableSkills must be a boolean`);
  if (raw["maxTurns"] !== undefined && (typeof raw["maxTurns"] !== "number" || raw["maxTurns"] < 1)) invalid(`${what}.maxTurns must be >= 1`);
  if (raw["effort"] !== undefined && !["low", "medium", "high"].includes(raw["effort"] as string)) invalid(`${what}.effort must be low, medium or high`);
  const o = raw["origin"];
  if (o !== undefined) {
    if (!isRecord(o) || !["main", "app", "schedule", "eval"].includes(o["kind"] as string)) invalid(`${what}.origin.kind is invalid`);
    if (o["kind"] === "app" && typeof o["appId"] !== "string") invalid(`${what}.origin.appId is required`);
    if (o["kind"] === "schedule" && typeof o["scheduleId"] !== "string") invalid(`${what}.origin.scheduleId is required`);
  }
  return raw as unknown as TaskRequest;
}

export function createDaemon(opts: DaemonOptions): Daemon {
  mkdirSync(opts.dataDir, { recursive: true });
  const redactor = new Redactor();
  const logger = createLogger(redactor, opts.log);
  const db = OneSeatDb.open(opts.dataDir);
  const workspaceDir = opts.workspaceDir ?? join(opts.dataDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const apps = new AppStore(join(opts.dataDir, "apps"));
  const keys = new Map<ProviderId, ProviderConfig>();
  const listeners = new Set<(n: Notification) => void>();
  const approvals = new Map<string, { runId: string; resolve: (d: ApprovalDecision) => void }>();
  const connections = new Set<LineConnection>();
  const pumps = new Set<Promise<void>>();
  let mcp: McpManager | undefined;
  let lastModel: { provider: ProviderId; model: string } | undefined;
  let closed = false;
  let licenseTimer: ReturnType<typeof setInterval> | undefined;

  const denoPath = opts.denoPath ?? findDeno();
  const sandbox = new ScriptSandbox({
    ...(denoPath ? { denoPath } : {}),
    workspaceDir,
    cacheDir: join(opts.dataDir, "deno-cache"),
    denyPaths: [db.path, `${db.path}-wal`, `${db.path}-shm`, apps.dir],
  });

  const notify = (n: Notification) => {
    for (const l of listeners) {
      try {
        l(n);
      } catch (e) {
        logger.error("notification listener failed", errorMessage(e));
      }
    }
  };

  const providerConfig = (id: ProviderId): ProviderConfig => {
    const c = keys.get(id);
    if (c) return c;
    if (id === "local") return { apiKey: "" };
    throw new RpcError(RPC_ERRORS.notAuthorised, `no API key for ${id}: call auth.set first`);
  };

  const makeProvider = (id: ProviderId) => {
    const factory = opts.providers[id];
    if (!factory) throw new RpcError(RPC_ERRORS.notFound, `no adapter for provider ${id}`);
    return factory(providerConfig(id));
  };

  const approvalHandler =
    (runId: string): ApprovalHandler =>
    (req) =>
      new Promise<ApprovalDecision>((resolve) => {
        approvals.set(req.approvalId, { runId, resolve });
      });

  const scheduleStore = new ScheduleStore(db);
  const removedStarters = new RemovedStarters(opts.dataDir);
  const installedNames = async () => new Set((await opts.store.list()).map((s) => s.manifest.frontmatter.name));

  const scheduler = new Scheduler({
    store: scheduleStore,
    logger,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.schedulerIntervalMs ? { intervalMs: opts.schedulerIntervalMs } : {}),
    fire: async (s: Schedule) => startRun({ ...s.task, origin: { kind: "schedule", scheduleId: s.id } }),
    onFired: (scheduleId, runId) => notify({ method: "schedule.fired", params: { scheduleId, runId } }),
  });

  const harness = new Harness({
    ...(opts.harness ?? {}),
    store: opts.store,
    db,
    provider: (task) => makeProvider(task.provider),
    workspaceDir,
    sandbox,
    mcp: { tools: () => mcp?.tools() ?? [] },
    // schedule_task (the model's tool) follows the same plan rule as schedules.upsert.
    schedules: {
      upsert: (input) => {
        if (opts.license && !opts.license.has("schedules")) throw new Error(upgradeMessage("schedules"));
        return scheduler.upsert(input);
      },
    },
    appAllowedSkills: (appId) => apps.allowedSkills(appId),
    redactor,
    logger,
    ...(opts.now ? { now: opts.now } : {}),
  });

  /** Start a run, forward its events as notifications, and settle its approvals when it ends. */
  function startRun(task: TaskRequest, onDone?: (events: HarnessEvent[]) => void, allowedSkills?: string[]): string {
    const runId = newId("run");
    const events: HarnessEvent[] = [];
    const stream = harness.run(task, approvalHandler(runId), { runId, ...(allowedSkills ? { allowedSkills } : {}) });
    const pump = (async () => {
      try {
        for await (const event of stream) {
          if (onDone) events.push(event);
          notify({ method: "harness.event", params: { runId, event } });
        }
      } catch (e) {
        logger.error(`run ${runId} stream failed`, errorMessage(e));
      } finally {
        for (const [id, a] of approvals)
          if (a.runId === runId) {
            approvals.delete(id);
            a.resolve({ approved: false, note: "the run ended" });
          }
        onDone?.(events);
      }
    })();
    pumps.add(pump);
    void pump.finally(() => pumps.delete(pump));
    return runId;
  }

  const defaultModel = async (): Promise<{ provider: ProviderId; model: string }> => {
    if (opts.defaultModel) return opts.defaultModel;
    if (lastModel) return lastModel;
    for (const id of PROVIDER_IDS) {
      if (!opts.providers[id] || (!keys.has(id) && id !== "local")) continue;
      try {
        const models = await makeProvider(id).models();
        if (models[0]) return { provider: id, model: models[0].id };
      } catch {
        /* try the next provider */
      }
    }
    throw new RpcError(RPC_ERRORS.notAuthorised, "no model is configured: call auth.set and harness.run first");
  };

  const runApp = async (p: Record<string, unknown>): Promise<BridgeResult> => {
    const appId = str(p, "appId")!;
    const skill = str(p, "skill")!;
    const input = p["input"];
    if (typeof input !== "string" && !isRecord(input)) invalid("input must be a string or an object");
    const pinned = apps.get(appId);
    if (!pinned) return { ok: false, text: "", error: `no pinned app "${appId}"` };
    if (!pinned.app.allowedSkills.includes(skill))
      return { ok: false, text: "", error: `skill "${skill}" is not allowed for app "${appId}"` };
    const model = await defaultModel();
    const task: TaskRequest = {
      input: typeof input === "string" ? input : JSON.stringify(input),
      provider: model.provider,
      model: model.model,
      skill,
      origin: { kind: "app", appId },
    };
    return await new Promise<BridgeResult>((resolve) => {
      startRun(
        task,
        (events) => {
          const done = [...events].reverse().find((e) => e.type === "done") as Extract<HarnessEvent, { type: "done" }> | undefined;
          const err = events.find((e) => e.type === "error") as Extract<HarnessEvent, { type: "error" }> | undefined;
          resolve(done ? bridgeResult(done.stopReason, done.text, err?.message) : { ok: false, text: "", error: err?.message ?? "the run ended early" });
        },
        pinned.app.allowedSkills,
      );
    });
  };

  const requireFeature = (feature: Feature) => {
    if (opts.license && !opts.license.has(feature))
      throw new RpcError(RPC_ERRORS.upgradeRequired, upgradeMessage(feature), { feature, tier: opts.license.status().tier });
  };
  const notYet = (m: string): never => {
    throw new RpcError(RPC_ERRORS.notFound, `${m} is not available in this build yet`);
  };

  const licenseCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!opts.license) throw new RpcError(RPC_ERRORS.notFound, "licensing is not configured in this build");
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LicenseError) throw new RpcError(RPC_ERRORS.blocked, e.message, e.code ? { code: e.code } : undefined);
      throw e;
    }
  };

  const methods: { [M in keyof AllMethods]: (p: Record<string, unknown>) => Promise<AllMethods[M]["result"]> } = {
    "daemon.hello": async () => ({ version: DAEMON_VERSION, protocol: 1 }),
    // Contract stubs (ADR-0002 work in progress): each is replaced by its implementation.
    "harness.answer": async () => notYet("harness.answer"),
    "license.trial": async () => notYet("license.trial"),
    "auth.set": async (p) => {
      const provider = providerId(p["provider"]);
      const apiKey = p["apiKey"];
      if (typeof apiKey !== "string" || apiKey === "") invalid("apiKey must be a non-empty string");
      redactor.add(apiKey);
      const config: ProviderConfig = { apiKey };
      if (p["baseUrl"] !== undefined) {
        if (typeof p["baseUrl"] !== "string" || !/^https?:\/\//.test(p["baseUrl"])) invalid("baseUrl must be an http(s) URL");
        config.baseUrl = p["baseUrl"];
      }
      keys.set(provider, config);
      logger.info(`auth set for ${provider}`);
      return { ok: true };
    },
    "auth.clear": async (p) => {
      const provider = providerId(p["provider"]);
      keys.delete(provider);
      logger.info(`auth cleared for ${provider}`);
      return { ok: true };
    },
    "auth.status": async () => {
      const out = {} as Record<ProviderId, boolean>;
      for (const id of PROVIDER_IDS) out[id] = keys.has(id);
      return out;
    },
    "models.list": async (p) => {
      const provider = providerId(p["provider"]);
      const models = await makeProvider(provider).models();
      return { models: models.map((m) => ({ id: m.id, label: m.label, ...(m.tier ? { tier: m.tier } : {}) })) };
    },
    "harness.run": async (p) => {
      const task = validateTask(p);
      if (task.origin?.kind === "app" && !apps.get(task.origin.appId))
        throw new RpcError(RPC_ERRORS.notFound, `no pinned app "${task.origin.appId}"`);
      if (!opts.providers[task.provider]) throw new RpcError(RPC_ERRORS.notFound, `no adapter for provider ${task.provider}`);
      providerConfig(task.provider);
      lastModel = { provider: task.provider, model: task.model };
      return { runId: startRun(task) };
    },
    "harness.cancel": async (p) => ({ ok: harness.cancel(str(p, "runId")!) }),
    "harness.approve": async (p) => {
      const approvalId = str(p, "approvalId")!;
      if (typeof p["approved"] !== "boolean") invalid("approved must be a boolean");
      const pending = approvals.get(approvalId);
      if (!pending) return { ok: false };
      approvals.delete(approvalId);
      const decision: ApprovalDecision = { approved: p["approved"] };
      if (typeof p["note"] === "string" && p["note"]) decision.note = p["note"];
      pending.resolve(decision);
      return { ok: true };
    },
    "skills.list": async () => ({ skills: await opts.store.list() }),
    "skills.inspect": async (p) => opts.store.inspect(parseSourceText(str(p, "source")!)),
    "skills.install": async (p) => {
      requireFeature("import_skills");
      if (p["allowWarnings"] !== undefined && typeof p["allowWarnings"] !== "boolean") invalid("allowWarnings must be a boolean");
      return opts.store.install(parseSourceText(str(p, "source")!), { allowWarnings: p["allowWarnings"] === true });
    },
    "skills.remove": async (p) => {
      const name = str(p, "name")!;
      const ok = await opts.store.remove(name);
      // Remember a removed starter skill so the next start does not put it back.
      if (ok && listBundledSkills(opts.bundledSkillsDir).some((b) => b.name === name)) removedStarters.add(name);
      return { ok };
    },
    // Searching is allowed on every plan; installing a result is skills.install (plan gate).
    "skills.search": async (p) => {
      const query = p["query"];
      if (typeof query !== "string") invalid("query must be a string");
      if (query.length > SEARCH_QUERY_MAX) invalid(`query must be at most ${SEARCH_QUERY_MAX} characters`);
      if (!opts.searchSkills) throw new RpcError(RPC_ERRORS.notFound, "skill search is not available in this build");
      if (!query.trim()) return { results: [] };
      let found: Omit<SkillSearchResult, "installed">[];
      try {
        found = await opts.searchSkills(query);
      } catch (e) {
        logger.warn(`skills.sh search failed: ${errorMessage(e)}`);
        throw new RpcError(RPC_ERRORS.internal, errorMessage(e));
      }
      const installed = await installedNames();
      return { results: found.map((r) => ({ ...r, installed: installed.has(r.skill) })) };
    },
    "skills.restorable": async () => {
      const installed = await installedNames();
      return {
        skills: listBundledSkills(opts.bundledSkillsDir)
          .filter((b) => !installed.has(b.name))
          .map((b) => ({ name: b.name, description: b.description })),
      };
    },
    // No plan gate: starter skills ship with the app. Still scanned and linted like any source.
    "skills.restore": async (p) => {
      const name = str(p, "name")!;
      const bundled = listBundledSkills(opts.bundledSkillsDir).find((b) => b.name === name);
      if (!bundled) throw new RpcError(RPC_ERRORS.notFound, `"${name}" is not one of OneSeat's starter skills`);
      if ((await installedNames()).has(name)) invalid(`"${name}" is already installed`);
      const res = await opts.store.install({ kind: "local", path: bundled.dir });
      if (res.installed) {
        removedStarters.delete(name);
        logger.info(`restored starter skill ${name}`);
      }
      return installResult(res);
    },
    "apps.pin": async (p) => {
      requireFeature("pinned_apps");
      try {
        return { app: apps.pin(p as unknown as ArtifactBundle, opts.now?.() ?? new Date()) };
      } catch (e) {
        if (e instanceof AppError) throw new RpcError(RPC_ERRORS.invalidParams, e.message, { issues: e.issues });
        throw e;
      }
    },
    "apps.list": async () => ({ apps: apps.list() }),
    "apps.unpin": async (p) => ({ ok: apps.unpin(str(p, "id")!) }),
    "apps.run": async (p) => runApp(p),
    "apps.draft": async (p) => {
      const d = harness.drafts.get(str(p, "draftId")!);
      if (!d) throw new RpcError(RPC_ERRORS.notFound, "no such draft");
      return { html: d.html, app: d.app };
    },
    "apps.drafts": async () => ({
      drafts: harness.drafts.list().map((d) => ({ id: d.id, appId: d.app.id, name: d.app.name, createdAt: d.createdAt })),
    }),
    "schedules.list": async () => ({ schedules: scheduler.list() }),
    "schedules.upsert": async (p) => {
      requireFeature("schedules");
      const id = str(p, "id")!;
      const cron = str(p, "cron")!;
      if (typeof p["enabled"] !== "boolean") invalid("enabled must be a boolean");
      const task = validateTask(p["task"], "task");
      const { origin: _origin, ...rest } = task;
      try {
        return { schedule: scheduler.upsert({ id, cron, task: rest, enabled: p["enabled"] }) };
      } catch (e) {
        if (e instanceof CronError) invalid(e.message);
        throw e;
      }
    },
    "schedules.remove": async (p) => ({ ok: scheduler.remove(str(p, "id")!) }),
    "actions.log": async (p) => {
      const limit = p["limit"];
      if (limit !== undefined && (typeof limit !== "number" || limit < 1)) invalid("limit must be a positive number");
      return { entries: harness.actions.list(typeof limit === "number" ? limit : 100) };
    },
    "mcp.status": async () => ({ servers: mcp?.status() ?? [] }),
    "license.status": async () => (opts.license ? opts.license.status() : freeEntitlement("licensing is not configured in this build")),
    "license.activate": async (p) =>
      licenseCall(async () => {
        const ent = await opts.license!.activate(str(p, "licenseKey")!);
        await startMcp();
        return ent;
      }),
    "license.deactivate": async () => licenseCall(() => opts.license!.deactivate()),
    "feedback.send": async (p) => {
      const message = str(p, "message")!;
      const rating = p["rating"];
      if (rating !== undefined && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5)) invalid("rating must be 1 to 5");
      return licenseCall(() =>
        opts.license!.sendFeedback({
          message,
          ...(typeof rating === "number" ? { rating } : {}),
          ...(str(p, "email", { optional: true }) ? { email: str(p, "email", { optional: true })! } : {}),
          ...(str(p, "topic", { optional: true }) ? { topic: str(p, "topic", { optional: true })! } : {}),
        }),
      );
    },
  };

  /** Connect MCP servers when the plan includes them (also after a license is activated). */
  async function startMcp() {
    if (!opts.mcpConfigPath || mcp || closed) return;
    if (opts.license && !opts.license.has("mcp_connectors")) {
      logger.info("MCP connectors need OneSeat Pro or Team; not loading mcp.json");
      return;
    }
    try {
      mcp = await McpManager.fromFile(opts.mcpConfigPath, { logger });
      await mcp.start();
    } catch (e) {
      logger.error("could not load MCP servers", errorMessage(e));
    }
  }

  const init = async () => {
    if (opts.license) {
      await opts.license.refreshIfDue().catch(() => undefined);
      licenseTimer = setInterval(() => void opts.license!.refreshIfDue().catch(() => undefined), 6 * 3600_000);
      (licenseTimer as { unref?: () => void }).unref?.();
    }
    await startMcp();
    if (closed) {
      await mcp?.close();
      return;
    }
    await scheduler.tick().catch(() => undefined);
    if (opts.startScheduler !== false) scheduler.start();
    logger.info(`daemon ready (deno ${sandbox.available ? "found" : "missing"})`);
  };
  const ready = init();

  const request = async (method: string, params: unknown): Promise<unknown> => {
    if (closed) throw new RpcError(RPC_ERRORS.internal, "daemon is shutting down");
    const fn = (methods as Record<string, (p: Record<string, unknown>) => Promise<unknown>>)[method];
    if (!Object.prototype.hasOwnProperty.call(methods, method) || !fn)
      throw new RpcError(RPC_ERRORS.methodNotFound, `method not found: ${method}`);
    if (!isRecord(params)) invalid("params must be an object");
    await ready;
    try {
      return await fn(params);
    } catch (e) {
      if (!(e instanceof RpcError)) logger.error(`${method} failed`, errorMessage(e));
      throw e;
    }
  };

  const daemon: Daemon = {
    ready,
    harness,
    scheduler,
    db,
    apps,
    redactor,
    logger,
    handle: (method, params) => request(method, params) as never,
    request,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect(input, output) {
      const conn = serveLines(input, output, { request, formatError: (e) => redactor.redact(errorMessage(e)) });
      const unsubscribe = daemon.subscribe((n) => conn.send({ jsonrpc: "2.0", method: n.method, params: n.params }));
      connections.add(conn);
      void conn.closed.then(() => {
        unsubscribe();
        connections.delete(conn);
      });
      return conn;
    },
    async close() {
      if (closed) return;
      closed = true;
      scheduler.stop();
      if (licenseTimer) clearInterval(licenseTimer);
      for (const id of harness.activeRuns()) harness.cancel(id);
      await ready.catch(() => undefined);
      await Promise.allSettled([...pumps]);
      for (const c of connections) c.close();
      await mcp?.close();
      keys.clear();
      db.close();
    },
  };
  return daemon;
}

/** Serve the daemon on this process's stdin/stdout. Logs go to stderr. */
export function serveStdio(daemon: Daemon, io: { input?: Readable; output?: Writable } = {}): LineConnection {
  const conn = daemon.connect(io.input ?? process.stdin, io.output ?? process.stdout);
  void conn.closed.then(() => daemon.close());
  return conn;
}

export type { DaemonMethod };
