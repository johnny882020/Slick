// Run: task box, model picker, streaming output, cancel. A run is a conversation: questions
// the model asks are answered in the transcript, and a finished run can be replied to (same
// session) or turned into a pinnable app.

import type { ProviderId, TaskRequest } from "@oneseat/contracts";
import { describeError } from "../api";
import type { ArtifactDraft } from "../artifacts";
import { announce, button, field, h, replace } from "../dom";
import { providerLabel, truncate } from "../format";
import { createConversation, STATUS_LABEL, submitOnCtrlEnter } from "../render-run";
import { canMakeApp, canReply, isFinished, type RunState } from "../run-state";
import type { Ctx, View } from "./context";

/** The skill that builds self-contained HTML apps (make_artifact). */
export const APP_SKILL = "brand-kit";

/** What "Turn into app" asks for, as a follow-up in the same session. */
export const TURN_INTO_APP_INPUT =
  "Turn the result above into a small, self-contained app (an HTML page) I can pin. Keep the data it shows; make it on-brand.";

/** Pick a default model: the first "frontier" one, else the first. */
export function defaultModel(models: { id: string; tier?: string }[]): string | undefined {
  return (models.find((m) => m.tier === "frontier") ?? models[0])?.id;
}

export async function pinDraft(ctx: Ctx, d: ArtifactDraft): Promise<boolean> {
  try {
    const r = await ctx.api.call("apps.pin", d.bundle);
    ctx.store.markPinned(d.key);
    ctx.notify(`Pinned “${r.app.app.name}”. Open it from Apps.`);
    return true;
  } catch (e) {
    ctx.notify(`Could not pin the app: ${describeError(e)}`, "error");
    return false;
  }
}

/**
 * The request for a follow-up turn: same session, same provider and model as the run it
 * continues (falling back to the picker for runs this UI did not start).
 */
export function followUpRequest(
  tip: RunState,
  input: string,
  fallback: { provider: string; model: string },
  skill?: string,
): TaskRequest | null {
  if (!tip.sessionId) return null;
  const provider = tip.provider || fallback.provider;
  const model = tip.model || fallback.model;
  if (!provider || !model) return null;
  return {
    input,
    provider: provider as ProviderId,
    model,
    sessionId: tip.sessionId,
    origin: { kind: "main" },
    ...(skill ? { skill } : {}),
  };
}

export function runView(ctx: Ctx): View {
  const { api, store } = ctx;
  const modelCache = new Map<string, { id: string; label: string; tier?: string }[]>();
  const installedSkills = new Set<string>();

  const task = h("textarea", { name: "task", rows: 4, placeholder: "For example: chase overdue invoices from last month", required: true, attrs: { dir: "auto" } });
  const provider = h("select", { name: "provider" });
  const model = h("select", { name: "model" });
  const skill = h("select", { name: "skill" });
  const runBtn = h("button", { type: "submit", class: "btn primary", text: "Run" });
  const cancelBtn = button("Cancel", () => void onCancel(), { kind: "danger" });
  cancelBtn.hidden = true;
  const formStatus = h("p", { class: "status", attrs: { role: "status" } });
  const noKey = h(
    "div",
    { class: "notice", attrs: { hidden: true } },
    "Add a model key first. ",
    button("Set up a key", () => ctx.navigate("setup"), { kind: "ghost" }),
  );

  // ---- Follow-ups: reply in the same session, turn the result into an app, or start over.
  const reply = h("textarea", { name: "reply", rows: 3, placeholder: "Answer OneSeat's question or ask for a change", attrs: { dir: "auto" } });
  submitOnCtrlEnter(reply);
  const replyBtn = h("button", { type: "submit", class: "btn primary", text: "Reply" });
  const makeAppBtn = button("Turn into app", () => void onTurnIntoApp(), {
    title: "Make a small app from this result that you can pin as its own window",
  });
  const newTaskBtn = button("New task", () => onNewTask(), { kind: "ghost" });
  const followStatus = h("p", { class: "status", attrs: { role: "status" } });
  const followUps = h(
    "form",
    {
      class: "card followups stack",
      attrs: { "aria-label": "Reply to OneSeat" },
      on: {
        submit: (e) => {
          e.preventDefault();
          void onReply();
        },
      },
    },
    field("Reply", reply, "OneSeat keeps the conversation. Press Ctrl+Enter (⌘+Enter on Mac) to send."),
    h("div", { class: "row" }, replyBtn, makeAppBtn, newTaskBtn),
    followStatus,
  );

  const conversation = createConversation(
    {
      onReview: (id) => ctx.reviewApproval(id),
      onPin: (d) => void pinDraft(ctx, d).then(() => renderRun()),
      isPinned: (d) => store.pinnedDrafts.has(d.key),
      onAnswer: async (questionId, answer) => {
        try {
          const r = await api.call("harness.answer", { questionId, answer });
          if (r.ok) announce(answer ? "Answer sent." : "Question skipped.");
          return r.ok;
        } catch (e) {
          throw new Error(describeError(e));
        }
      },
    },
    followUps,
  );
  const recent = h("ul", { class: "recent" });
  const recentSection = h("section", { class: "card", attrs: { "aria-labelledby": "recent-title" } }, h("h2", { id: "recent-title", text: "Recent runs" }), recent);

  const form = h(
    "form",
    {
      class: "card stack",
      attrs: { "aria-labelledby": "run-title" },
      on: {
        submit: (e) => {
          e.preventDefault();
          void onRun();
        },
      },
    },
    field("What should OneSeat do?", task, "Press Ctrl+Enter (⌘+Enter on Mac) to run."),
    h("div", { class: "grid3" }, field("Provider", provider), field("Model", model), field("Skill", skill)),
    h("div", { class: "row" }, runBtn, cancelBtn),
    formStatus,
  );
  submitOnCtrlEnter(task);
  provider.addEventListener("change", () => void loadModels(provider.value as ProviderId));

  const el = h(
    "section",
    { class: "view view-run", attrs: { "aria-labelledby": "run-title" } },
    h("h1", { id: "run-title", text: "Run a task" }),
    noKey,
    form,
    conversation.el,
    recentSection,
  );

  function renderProviders(): void {
    const ready = store.readyProviders();
    noKey.hidden = ready.length > 0;
    runBtn.disabled = ready.length === 0;
    const current = provider.value;
    replace(provider, ...ready.map((p) => h("option", { value: p, text: providerLabel(p) })));
    if (ready.includes(current)) provider.value = current;
    if (provider.value && !modelCache.has(provider.value)) void loadModels(provider.value as ProviderId);
    else if (provider.value) fillModels(provider.value);
  }

  function fillModels(p: string): void {
    const models = modelCache.get(p) ?? [];
    const current = model.value;
    replace(model, ...models.map((m) => h("option", { value: m.id, text: m.tier ? `${m.label} (${m.tier})` : m.label })));
    if (models.some((m) => m.id === current)) model.value = current;
    else {
      const d = defaultModel(models);
      if (d) model.value = d;
    }
  }

  async function loadModels(p: ProviderId): Promise<void> {
    try {
      const r = await api.call("models.list", { provider: p });
      modelCache.set(p, r.models);
      if (provider.value === p) fillModels(p);
    } catch (e) {
      formStatus.textContent = `Could not list models: ${describeError(e)}`;
    }
  }

  async function loadSkills(): Promise<void> {
    try {
      const r = await api.call("skills.list", {});
      const current = skill.value;
      installedSkills.clear();
      for (const s of r.skills) installedSkills.add(s.manifest.frontmatter.name);
      replace(
        skill,
        h("option", { value: "", text: "Let OneSeat choose" }),
        ...r.skills.map((s) => h("option", { value: s.manifest.frontmatter.name, text: s.manifest.frontmatter.name })),
      );
      skill.value = r.skills.some((s) => s.manifest.frontmatter.name === current) ? current : "";
    } catch {
      /* the run still works without the list */
    }
  }

  /** The run shown: the latest turn of the current conversation. */
  function current(): RunState | null {
    return store.currentRunId ? store.runs.get(store.currentRunId) ?? null : null;
  }

  let followBusy = false;

  function renderRun(): void {
    const run = current();
    conversation.update(run ? store.conversation(run.runId) : []);
    const busy = !!run && !isFinished(run);
    cancelBtn.hidden = !busy;
    runBtn.textContent = busy ? "Run another" : "Run";
    followUps.hidden = !run || !canReply(run);
    makeAppBtn.hidden = !run || !canMakeApp(run);
    replyBtn.disabled = followBusy;
    makeAppBtn.disabled = followBusy;
    renderRecent();
  }

  function renderRecent(): void {
    // One row per conversation, labelled by its first message.
    const tips = store.conversationTips().reverse().slice(0, 10);
    recentSection.hidden = tips.length < 2;
    const shown = current();
    replace(
      recent,
      ...tips.map((r) => {
        const chain = store.conversation(r.runId);
        const first = chain[0]?.input ?? r.input;
        const isCurrent = !!shown && r.runId === shown.runId;
        const turns = chain.length > 1 ? ` · ${chain.length} turns` : "";
        return h(
          "li",
          null,
          h("button", {
            type: "button",
            class: `link ${isCurrent ? "current" : ""}`,
            attrs: { "aria-current": isCurrent ? "true" : null, dir: "auto" },
            text: `${truncate(first ?? "Background run", 60)} — ${STATUS_LABEL[r.status]}${turns}`,
            on: {
              click: () => {
                store.currentRunId = r.runId;
                renderRun();
              },
            },
          }),
        );
      }),
    );
  }

  async function onRun(): Promise<void> {
    const input = task.value.trim();
    if (!input) {
      formStatus.textContent = "Type a task first.";
      task.focus();
      return;
    }
    if (!provider.value || !model.value) {
      formStatus.textContent = "Choose a provider and model.";
      return;
    }
    const req: TaskRequest = { input, provider: provider.value as ProviderId, model: model.value, origin: { kind: "main" } };
    if (skill.value) req.skill = skill.value;
    runBtn.disabled = true;
    formStatus.textContent = "Starting…";
    try {
      const { runId } = await api.call("harness.run", req);
      store.startRun(runId, input, { provider: req.provider, model: req.model });
      formStatus.textContent = "";
    } catch (e) {
      formStatus.textContent = describeError(e);
      ctx.notify(formStatus.textContent, "error");
    } finally {
      runBtn.disabled = store.readyProviders().length === 0;
    }
  }

  /** Start the next turn of the current conversation. */
  async function followUp(input: string, opts: { skill?: string } = {}): Promise<boolean> {
    const tip = current();
    if (!tip || followBusy) return false;
    const req = followUpRequest(tip, input, { provider: provider.value, model: model.value }, opts.skill);
    if (!req) {
      followStatus.textContent = "This run cannot be continued. Start a new task instead.";
      return false;
    }
    followBusy = true;
    followStatus.textContent = "Sending…";
    renderRun();
    try {
      const { runId } = await api.call("harness.run", req);
      store.startRun(runId, input, { provider: req.provider, model: req.model, followsRunId: tip.runId });
      followStatus.textContent = "";
      return true;
    } catch (e) {
      followStatus.textContent = describeError(e);
      ctx.notify(followStatus.textContent, "error");
      return false;
    } finally {
      followBusy = false;
      renderRun();
    }
  }

  async function onReply(): Promise<void> {
    const input = reply.value.trim();
    if (!input) {
      followStatus.textContent = "Type a reply first.";
      reply.focus();
      return;
    }
    if (await followUp(input)) {
      reply.value = "";
      announce("Reply sent.");
    }
  }

  async function onTurnIntoApp(): Promise<void> {
    // brand-kit builds the page; without it the model still has make_artifact.
    const forced = installedSkills.has(APP_SKILL) ? APP_SKILL : undefined;
    if (await followUp(TURN_INTO_APP_INPUT, forced ? { skill: forced } : {})) announce("Making an app from this result.");
  }

  function onNewTask(): void {
    store.currentRunId = null;
    reply.value = "";
    followStatus.textContent = "";
    task.value = "";
    renderRun();
    task.focus();
  }

  async function onCancel(): Promise<void> {
    const run = current();
    if (!run) return;
    cancelBtn.disabled = true;
    try {
      const r = await api.call("harness.cancel", { runId: run.runId });
      if (!r.ok) formStatus.textContent = "That run already finished.";
    } catch (e) {
      formStatus.textContent = describeError(e);
    } finally {
      cancelBtn.disabled = false;
    }
  }

  let frame = 0;
  store.subscribe((c) => {
    if (c.type === "keys") renderProviders();
    if (c.type === "run" || c.type === "drafts" || c.type === "approvals") {
      // Batch bursts of streamed events into one paint.
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), renderRun()));
    }
  });

  renderProviders();
  renderRun();

  return {
    el,
    show() {
      renderProviders();
      renderRun();
      void loadSkills();
    },
  };
}
