#!/usr/bin/env node
// Fake OneSeat harness daemon for development and end-to-end tests.
//
// Speaks the real protocol from packages/contracts/src/harness.ts (DaemonMethods /
// DaemonNotifications): newline-delimited JSON-RPC 2.0 on stdin/stdout, logs on stderr.
// Everything is canned and in memory, except pinned apps, which are written to
// $ONESEAT_HOME/apps/<id>/{index.html,app.json} exactly where the shell serves them from.
//
// Scripted runs (harness.run) pick a script from the task input:
//   contains "send" / "email" / "remind"   -> approval flow (approval_request, waits for harness.approve)
//   contains "app" / "dashboard" / "tracker" -> produces an artifact draft (tool_end with an ArtifactBundle)
//   contains "fail"                         -> emits an error event
//   contains "slow"                         -> streams slowly (for cancel)
//   anything else                           -> skill_loaded + a read tool + streamed text
//
// Env:
//   ONESEAT_HOME            data dir (pinned apps are written under it)
//   FAKE_DAEMON_STEP_MS     delay between streamed events (default 25)
//   FAKE_DAEMON_EXIT_AFTER  exit(3) after this many requests (restart tests)
//
// Test-only method (not in DaemonMethods, so the shell's allowlist never lets the UI call it):
//   fake.crash -> exits with code 3 after replying.

import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const VERSION = "0.0.0-fake";
const STEP_MS = Number(process.env.FAKE_DAEMON_STEP_MS ?? 25);
const EXIT_AFTER = process.env.FAKE_DAEMON_EXIT_AFTER ? Number(process.env.FAKE_DAEMON_EXIT_AFTER) : Infinity;
const HOME = process.env.ONESEAT_HOME || "";

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  notAuthorised: -32001,
  blocked: -32002,
  notFound: -32004,
};

const PROVIDERS = ["anthropic", "openai", "google", "local"];
const APP_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const log = (...a) => process.stderr.write(`[fake-daemon] ${a.join(" ")}\n`);
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- state

const auth = new Map(); // provider -> { baseUrl? }   (the key itself is dropped on purpose)
const runs = new Map(); // runId -> { cancelled, approvals: Map<approvalId, resolve> }
const apps = new Map(); // id -> PinnedApp

// Like the real daemon, pinned apps survive a restart: reload them from $ONESEAT_HOME/apps.
if (HOME && existsSync(join(HOME, "apps"))) {
  for (const id of readdirSync(join(HOME, "apps"))) {
    try {
      const dir = join(HOME, "apps", id);
      const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
      if (app.id === id && APP_ID.test(id) && existsSync(join(dir, "index.html")))
        apps.set(id, { app, htmlPath: join(dir, "index.html"), pinnedAt: statSync(join(dir, "app.json")).mtime.toISOString() });
    } catch {
      /* not an app folder */
    }
  }
}
const schedules = new Map(); // id -> Schedule
const actions = []; // ActionLogEntry, newest last

function perms(p = {}) {
  return { net: [], read: [], write: [], env: [], run: [], ...p };
}

function makeSkill(name, description, source, extra = {}) {
  return {
    manifest: {
      frontmatter: { name, description, license: "MIT", metadata: { version: extra.version ?? "1.0.0" } },
      body: `# ${name}\n\n${description}\n`,
      dir: HOME ? join(HOME, "skills", name) : `/skills/${name}`,
      files: ["SKILL.md", ...(extra.files ?? [])],
      linkedFiles: extra.files ?? [],
      permissions: perms(extra.permissions),
      effects: extra.effects ?? [],
      reasons: extra.reasons ?? {},
      scripts: {},
    },
    source,
    version: extra.version ?? "1.0.0",
    contentHash: "sha256:" + Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64),
    signature: Buffer.from(`sig:${name}`).toString("base64"),
    installedAt: "2026-11-01T09:00:00.000Z",
  };
}

const skills = new Map(
  [
    makeSkill(
      "invoice-chaser",
      "Drafts and sends polite payment reminders for overdue invoices. Use when invoices are past due.",
      { kind: "local", path: "/skills/invoice-chaser" },
      { effects: ["send"], files: ["templates/reminder.md"] },
    ),
    makeSkill(
      "weekly-report",
      "Summarises the week's sales, tickets and posts into a short report. Use on Mondays or when asked for a recap.",
      { kind: "skills.sh", owner: "oneseat", repo: "starter", skill: "weekly-report" },
    ),
  ].map((s) => [s.manifest.frontmatter.name, s]),
);

// ---------------------------------------------------------------- helpers

function requireObject(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new RpcError(ERR.invalidParams, "params must be an object");
  return params;
}

function requireString(p, key) {
  if (typeof p[key] !== "string" || p[key].length === 0) throw new RpcError(ERR.invalidParams, `${key} must be a non-empty string`);
  return p[key];
}

function requireProvider(p) {
  const provider = requireString(p, "provider");
  if (!PROVIDERS.includes(provider)) throw new RpcError(ERR.invalidParams, `unknown provider "${provider}"`);
  return provider;
}

function parseSource(input) {
  const s = input.trim();
  const gh = s.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+))?)?\/?$/);
  if (gh) return { kind: "github", owner: gh[1], repo: gh[2], ...(gh[3] ? { ref: gh[3] } : {}), ...(gh[4] ? { path: gh[4] } : {}) };
  const short = s.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:@([a-z0-9-]+))?$/);
  if (short && !s.startsWith(".") && !s.startsWith("/"))
    return { kind: "skills.sh", owner: short[1], repo: short[2], ...(short[3] ? { skill: short[3] } : {}) };
  return { kind: "local", path: s };
}

function skillNameFor(source) {
  let raw;
  if (source.kind === "local") raw = source.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  else if (source.kind === "github") raw = (source.path ?? source.repo).split("/").pop();
  else raw = source.skill ?? source.repo;
  return (raw ?? "skill").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function inspect(sourceText) {
  if (/missing|does-not-exist/i.test(sourceText)) throw new RpcError(ERR.notFound, `no skill found at ${sourceText}`);
  const source = parseSource(sourceText);
  const name = skillNameFor(source);
  const declared = perms();
  if (/block|evil|malware|exfil/i.test(sourceText)) {
    return {
      source,
      scan: {
        skill: name,
        verdict: "block",
        summary:
          "This skill reads your customer list and uploads it to a web address it does not declare. OneSeat will not install it.",
        findings: [
          {
            severity: "block",
            rule: "undeclared-network",
            file: "scripts/sync.ts",
            line: 14,
            message: 'Script contacts "paste.example.net", which is not declared in oneseat.json.',
          },
          { severity: "warn", rule: "reads-env", file: "scripts/sync.ts", line: 3, message: "Script reads environment variables." },
        ],
        declared,
        observed: perms({ net: ["paste.example.net"], env: ["HOME"] }),
        filesRead: 4,
        bytesRead: 5120,
      },
      lint: { skill: name, ok: true, issues: [] },
    };
  }
  if (/warn/i.test(sourceText)) {
    return {
      source,
      scan: {
        skill: name,
        verdict: "warn",
        summary: "This skill formats meeting notes. It writes files in your workspace folder. It needs no network access.",
        findings: [{ severity: "warn", rule: "writes-workspace", file: "SKILL.md", line: 20, message: "Writes files under $WORKSPACE." }],
        declared: perms({ write: ["$WORKSPACE/notes"] }),
        observed: perms({ write: ["$WORKSPACE/notes"] }),
        filesRead: 2,
        bytesRead: 2048,
      },
      lint: {
        skill: name,
        ok: true,
        issues: [{ severity: "warning", rule: "description-when", message: "description should say when to use the skill", file: "SKILL.md" }],
      },
    };
  }
  return {
    source,
    scan: {
      skill: name,
      verdict: "pass",
      summary:
        "This skill drafts replies to customer support tickets. It reads the tickets and customers tables and saves drafts. It needs no network access and never sends anything by itself.",
      findings: [{ severity: "info", rule: "tables", file: "SKILL.md", message: "Uses tables: tickets, customers." }],
      declared,
      observed: perms(),
      filesRead: 3,
      bytesRead: 3072,
    },
    lint: { skill: name, ok: true, issues: [] },
  };
}

function logAction(runId, tool, effects, approved, isError, summary) {
  actions.push({ at: now(), runId, tool, effects, approved, isError, summary });
}

function usage(i, o) {
  return { inputTokens: i, outputTokens: o };
}

function nextRun(cron) {
  // Good enough for a fake: the next whole minute.
  const d = new Date(Date.now() + 60_000);
  d.setSeconds(0, 0);
  void cron;
  return d.toISOString();
}

function validateCron(cron) {
  if (typeof cron !== "string") return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^(\*|[a-z0-9]+(-[a-z0-9]+)?)(\/\d+)?(,(\*|[a-z0-9]+(-[a-z0-9]+)?)(\/\d+)?)*$/i.test(p));
}

function artifactBundle() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Invoice tracker</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 24px; color: #1f2430; background: #fff; }
  button { font: inherit; padding: 6px 14px; border-radius: 8px; border: 1px solid #4f46e5; background: #4f46e5; color: #fff; }
  pre { background: #f4f4f8; padding: 12px; border-radius: 8px; white-space: pre-wrap; }
  @media (prefers-color-scheme: dark) { body { background: #16171d; color: #e8e8ee; } pre { background: #23252e; } }
</style>
</head>
<body>
<h1>Invoice tracker</h1>
<p>Overdue invoices, checked by the invoice-chaser skill.</p>
<button id="check" type="button">Check overdue invoices</button>
<pre id="out" aria-live="polite"></pre>
<script>
  document.getElementById("check").addEventListener("click", async () => {
    const out = document.getElementById("out");
    out.textContent = "Checking...";
    const r = await oneseat.run("invoice-chaser", { action: "list-overdue" });
    out.textContent = r.ok ? r.text : "Error: " + r.error;
  });
</script>
</body>
</html>`;
  return {
    html,
    app: {
      id: "invoice-tracker",
      name: "Invoice tracker",
      version: "1.0.0",
      icon: "🧾",
      window: { width: 640, height: 520, minWidth: 400, minHeight: 300, resizable: true },
      allowedSkills: ["invoice-chaser"],
      createdBy: "invoice-chaser",
    },
  };
}

// ---------------------------------------------------------------- scripted runs

async function emit(runId, event) {
  notify("harness.event", { runId, event });
  await sleep(STEP_MS);
}

async function streamText(run, runId, text, chunk = 12) {
  for (let i = 0; i < text.length; i += chunk) {
    if (run.cancelled) return false;
    await emit(runId, { type: "text_delta", text: text.slice(i, i + chunk) });
  }
  return !run.cancelled;
}

function waitApproval(run, approvalId) {
  return new Promise((resolve) => run.approvals.set(approvalId, resolve));
}

async function finishCancelled(runId, text) {
  await emit(runId, { type: "done", stopReason: "cancelled", text, usage: usage(0, 0) });
}

async function runScript(runId, task) {
  const run = runs.get(runId);
  const input = String(task.input ?? "");
  const sessionId = task.sessionId ?? `ses_${randomUUID().slice(0, 8)}`;
  const forced = typeof task.skill === "string" && task.skill.length > 0;
  await emit(runId, { type: "session_start", sessionId, runId });

  if (/fail/i.test(input)) {
    await emit(runId, { type: "error", message: "The model provider returned an error (overloaded). Try again in a minute.", retryable: true });
    runs.delete(runId);
    return;
  }

  const lower = input.toLowerCase();
  let text = "";
  if (/\b(send|email|remind)/.test(lower)) {
    const skill = forced ? task.skill : "invoice-chaser";
    if (!task.disableSkills) {
      await emit(runId, { type: "skill_loaded", name: skill, reason: forced ? "forced" : "router" });
      await emit(runId, { type: "skill_file_read", skill, file: "templates/reminder.md" });
    }
    await emit(runId, {
      type: "tool_start",
      call: { id: "call_q1", name: "db_query", input: { sql: "SELECT number, customer_id FROM invoices WHERE status = 'overdue'" } },
      effects: ["read"],
    });
    await emit(runId, {
      type: "tool_end",
      result: { callId: "call_q1", name: "db_query", content: '[{"number":"INV-1042","customer":"Acme Ltd"}]', isError: false },
      durationMs: 14,
    });
    logAction(runId, "db_query", ["read"], null, false, "Read overdue invoices");
    if (!(await streamText(run, runId, "Invoice INV-1042 for Acme Ltd is 12 days overdue. I drafted a reminder. "))) return finishCancelled(runId, text);
    const approvalId = `apr_${randomUUID().slice(0, 8)}`;
    const call = {
      id: "call_s1",
      name: "email_send",
      input: { to: "billing@acme.example", subject: "Friendly reminder: invoice INV-1042", body: "Hi Acme team, ..." },
    };
    await emit(runId, {
      type: "approval_request",
      approvalId,
      call,
      effects: ["send"],
      summary: "Send an email to billing@acme.example: “Friendly reminder: invoice INV-1042”",
    });
    const decision = await waitApproval(run, approvalId);
    run.approvals.delete(approvalId);
    if (run.cancelled) return finishCancelled(runId, text);
    await emit(runId, { type: "approval_result", approvalId, approved: decision.approved });
    if (decision.approved) {
      await emit(runId, { type: "tool_start", call, effects: ["send"] });
      await emit(runId, { type: "tool_end", result: { callId: "call_s1", name: "email_send", content: '{"sent":true}', isError: false }, durationMs: 230 });
      logAction(runId, "email_send", ["send"], true, false, "Sent reminder to billing@acme.example");
      text = "Done. I sent the reminder to Acme Ltd.";
    } else {
      logAction(runId, "email_send", ["send"], false, false, "Reminder to billing@acme.example was not sent");
      text = decision.note ? `Okay, I did not send it. Your note: "${decision.note}".` : "Okay, I did not send it.";
    }
    if (!(await streamText(run, runId, text))) return finishCancelled(runId, text);
    await emit(runId, { type: "turn_end", turn: 1, usage: usage(1830, 240) });
    await emit(runId, { type: "done", stopReason: "end_turn", text, usage: usage(1830, 240) });
  } else if (/\b(app|dashboard|tracker)\b/.test(lower)) {
    const skill = forced ? task.skill : "invoice-chaser";
    if (!task.disableSkills) await emit(runId, { type: "skill_loaded", name: skill, reason: forced ? "forced" : "router" });
    const bundle = artifactBundle();
    await emit(runId, { type: "tool_start", call: { id: "call_a1", name: "artifact_create", input: { name: bundle.app.name } }, effects: ["write"] });
    await emit(runId, {
      type: "tool_end",
      result: { callId: "call_a1", name: "artifact_create", content: JSON.stringify(bundle), isError: false },
      durationMs: 41,
    });
    logAction(runId, "artifact_create", ["write"], null, false, "Drafted the Invoice tracker app");
    text = "I made a small Invoice tracker app. Pin it to open it in its own window.";
    if (!(await streamText(run, runId, text))) return finishCancelled(runId, text);
    await emit(runId, { type: "turn_end", turn: 1, usage: usage(2410, 1630) });
    await emit(runId, { type: "done", stopReason: "end_turn", text, usage: usage(2410, 1630) });
  } else {
    const skill = forced ? task.skill : "weekly-report";
    if (!task.disableSkills) {
      await emit(runId, { type: "skill_loaded", name: skill, reason: forced ? "forced" : "router" });
      await emit(runId, { type: "skill_file_read", skill, file: "SKILL.md" });
    }
    await emit(runId, {
      type: "tool_start",
      call: { id: "call_m1", name: "db_query", input: { sql: "SELECT name, value FROM metrics WHERE period_start >= date('now','-7 day')" } },
      effects: ["read"],
    });
    await emit(runId, {
      type: "tool_end",
      result: { callId: "call_m1", name: "db_query", content: '[{"name":"revenue","value":12450}]', isError: false },
      durationMs: 9,
    });
    logAction(runId, "db_query", ["read"], null, false, "Read this week's metrics");
    text = "Weekly summary: revenue was $12,450, up 8% on last week. Three tickets are still open. Two posts went out.";
    if (/slow/i.test(input)) text = text.repeat(20);
    const chunk = /slow/i.test(input) ? 4 : 12;
    if (/slow/i.test(input)) await sleep(STEP_MS * 4);
    if (!(await streamText(run, runId, text, chunk))) return finishCancelled(runId, text);
    await emit(runId, { type: "turn_end", turn: 1, usage: usage(1520, 96) });
    await emit(runId, { type: "done", stopReason: "end_turn", text, usage: usage(1520, 96) });
  }
  runs.delete(runId);
}

// ---------------------------------------------------------------- methods

const methods = {
  "daemon.hello": (p) => {
    requireObject(p);
    log(`hello from ${String(p.client ?? "unknown").slice(0, 40)}`);
    return { version: VERSION, protocol: 1 };
  },
  "auth.set": (p) => {
    requireObject(p);
    const provider = requireProvider(p);
    if (typeof p.apiKey !== "string") throw new RpcError(ERR.invalidParams, "apiKey must be a string");
    if (provider !== "local" && p.apiKey.length === 0) throw new RpcError(ERR.invalidParams, "apiKey must not be empty");
    // Never keep or log the key.
    auth.set(provider, { baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : undefined });
    log(`auth.set provider=${provider}`);
    return { ok: true };
  },
  "auth.clear": (p) => {
    const provider = requireProvider(requireObject(p));
    auth.delete(provider);
    return { ok: true };
  },
  "auth.status": () => Object.fromEntries(PROVIDERS.map((id) => [id, auth.has(id)])),
  "models.list": (p) => {
    const provider = requireProvider(requireObject(p));
    const models = {
      anthropic: [
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", tier: "frontier" },
        { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", tier: "balanced" },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", tier: "fast" },
      ],
      openai: [
        { id: "gpt-5", label: "GPT-5", tier: "frontier" },
        { id: "gpt-5-mini", label: "GPT-5 mini", tier: "fast" },
      ],
      google: [
        { id: "gemini-3-pro", label: "Gemini 3 Pro", tier: "frontier" },
        { id: "gemini-3-flash", label: "Gemini 3 Flash", tier: "fast" },
      ],
      local: [{ id: "local-model", label: "Local model", tier: "balanced" }],
    };
    return { models: models[provider] };
  },
  "harness.run": (p) => {
    requireObject(p);
    requireString(p, "input");
    const provider = requireProvider(p);
    requireString(p, "model");
    if (!auth.has(provider)) throw new RpcError(ERR.notAuthorised, `no key set for ${provider}`);
    const runId = `run_${randomUUID().slice(0, 8)}`;
    runs.set(runId, { cancelled: false, approvals: new Map() });
    setImmediate(() =>
      runScript(runId, p).catch((e) => {
        log(`run ${runId} crashed: ${e.message}`);
        notify("harness.event", { runId, event: { type: "error", message: "internal error", retryable: false } });
      }),
    );
    return { runId };
  },
  "harness.cancel": (p) => {
    const runId = requireString(requireObject(p), "runId");
    const run = runs.get(runId);
    if (!run) return { ok: false };
    run.cancelled = true;
    for (const resolve of run.approvals.values()) resolve({ approved: false, note: "cancelled" });
    return { ok: true };
  },
  "harness.approve": (p) => {
    requireObject(p);
    const approvalId = requireString(p, "approvalId");
    if (typeof p.approved !== "boolean") throw new RpcError(ERR.invalidParams, "approved must be a boolean");
    for (const run of runs.values()) {
      const resolve = run.approvals.get(approvalId);
      if (resolve) {
        resolve({ approved: p.approved, note: typeof p.note === "string" ? p.note : undefined });
        return { ok: true };
      }
    }
    return { ok: false };
  },
  "skills.list": () => ({ skills: [...skills.values()] }),
  "skills.inspect": (p) => {
    const source = requireString(requireObject(p), "source");
    const { scan, lint } = inspect(source);
    return { scan, lint };
  },
  "skills.install": (p) => {
    requireObject(p);
    const sourceText = requireString(p, "source");
    const { source, scan, lint } = inspect(sourceText);
    if (scan.verdict === "block") return { installed: false, scan, lint, reason: "The security scan blocked this skill." };
    if (scan.verdict === "warn" && p.allowWarnings !== true)
      return { installed: false, scan, lint, reason: "This skill has warnings. Confirm to install it anyway." };
    const skill = makeSkill(scan.skill, scan.summary, source, { permissions: scan.declared });
    skill.installedAt = now();
    skills.set(scan.skill, skill);
    return { installed: true, skill, scan, lint };
  },
  "skills.remove": (p) => {
    const name = requireString(requireObject(p), "name");
    return { ok: skills.delete(name) };
  },
  "apps.pin": (p) => {
    requireObject(p);
    if (typeof p.html !== "string" || !p.app || typeof p.app !== "object") throw new RpcError(ERR.invalidParams, "expected an ArtifactBundle");
    const app = p.app;
    if (typeof app.id !== "string" || !APP_ID.test(app.id)) throw new RpcError(ERR.invalidParams, "app.id must be a lowercase slug");
    if (/<iframe\b/i.test(p.html)) throw new RpcError(ERR.blocked, "iframes are not allowed in pinned apps");
    let htmlPath = `/apps/${app.id}/index.html`;
    if (HOME) {
      const dir = join(HOME, "apps", app.id);
      mkdirSync(dir, { recursive: true });
      htmlPath = join(dir, "index.html");
      writeFileSync(htmlPath, p.html);
      writeFileSync(join(dir, "app.json"), JSON.stringify(app, null, 2));
    }
    const pinned = { app, htmlPath, pinnedAt: now() };
    apps.set(app.id, pinned);
    return { app: pinned };
  },
  "apps.list": () => ({ apps: [...apps.values()] }),
  "apps.unpin": (p) => {
    const id = requireString(requireObject(p), "id");
    const had = apps.delete(id);
    if (had && HOME && APP_ID.test(id)) {
      const dir = join(HOME, "apps", id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    return { ok: had };
  },
  "apps.run": (p) => {
    requireObject(p);
    const appId = requireString(p, "appId");
    const skill = requireString(p, "skill");
    const pinned = apps.get(appId);
    if (!pinned) throw new RpcError(ERR.notFound, `no pinned app "${appId}"`);
    if (!pinned.app.allowedSkills.includes(skill))
      return { ok: false, text: "", error: `skill "${skill}" is not allowed for this app` };
    const data = { overdue: [{ number: "INV-1042", customer: "Acme Ltd", daysOverdue: 12 }], input: p.input };
    logAction(`app:${appId}`, `skill:${skill}`, ["read"], null, false, `Pinned app ${appId} ran ${skill}`);
    log(`apps.run app=${appId} skill=${skill} input=${JSON.stringify(p.input).slice(0, 2000)}`);
    return { ok: true, text: JSON.stringify(data), data };
  },
  "schedules.list": () => ({ schedules: [...schedules.values()] }),
  "schedules.upsert": (p) => {
    requireObject(p);
    const id = requireString(p, "id");
    if (!validateCron(p.cron)) throw new RpcError(ERR.invalidParams, "cron must have 5 fields");
    if (!p.task || typeof p.task !== "object" || typeof p.task.input !== "string") throw new RpcError(ERR.invalidParams, "task.input is required");
    const prev = schedules.get(id);
    const schedule = {
      id,
      cron: p.cron.trim(),
      task: p.task,
      enabled: p.enabled !== false,
      ...(prev?.lastRunAt ? { lastRunAt: prev.lastRunAt } : {}),
      ...(p.enabled !== false ? { nextRunAt: nextRun(p.cron) } : {}),
    };
    schedules.set(id, schedule);
    return { schedule };
  },
  "schedules.remove": (p) => {
    const id = requireString(requireObject(p), "id");
    return { ok: schedules.delete(id) };
  },
  "actions.log": (p) => {
    const limit = p && typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 1000) : 100;
    return { entries: actions.slice(-limit).reverse() };
  },
  "fake.crash": () => {
    setTimeout(() => process.exit(3), 10);
    return { ok: true };
  },
};

// ---------------------------------------------------------------- loop

let requests = 0;

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "parse error" } });
    return;
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: ERR.invalidRequest, message: "invalid request" } });
    return;
  }
  const isNotification = msg.id === undefined;
  const fn = methods[msg.method];
  try {
    if (!fn) throw new RpcError(ERR.methodNotFound, `method not found: ${msg.method}`);
    const result = await fn(msg.params ?? {});
    if (!isNotification) send({ jsonrpc: "2.0", id: msg.id, result });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : ERR.internal;
    if (!isNotification) send({ jsonrpc: "2.0", id: msg.id, error: { code, message: e.message, ...(e.data ? { data: e.data } : {}) } });
  }
  requests += 1;
  if (requests >= EXIT_AFTER) {
    log(`exiting after ${requests} requests (FAKE_DAEMON_EXIT_AFTER)`);
    setTimeout(() => process.exit(3), 10);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim()) void handle(line);
});
rl.on("close", () => process.exit(0));
log(`ready (protocol 1, home=${HOME ? "set" : "unset"})`);
