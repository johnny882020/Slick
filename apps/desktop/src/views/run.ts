// Run: task box, model picker, streaming output, cancel.

import type { ProviderId, TaskRequest } from "@oneseat/contracts";
import { describeError } from "../api";
import type { ArtifactDraft } from "../artifacts";
import { button, field, h, replace } from "../dom";
import { providerLabel, truncate } from "../format";
import { createRunOutput, STATUS_LABEL } from "../render-run";
import { isFinished } from "../run-state";
import type { Ctx, View } from "./context";

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

export function runView(ctx: Ctx): View {
  const { api, store } = ctx;
  const modelCache = new Map<string, { id: string; label: string; tier?: string }[]>();

  const task = h("textarea", { name: "task", rows: 4, placeholder: "For example: chase overdue invoices from last month", required: true });
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

  const output = createRunOutput({
    onReview: (id) => ctx.reviewApproval(id),
    onPin: (d) => void pinDraft(ctx, d).then(() => renderRun()),
    isPinned: (d) => store.pinnedDrafts.has(d.key),
  });
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
  task.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  provider.addEventListener("change", () => void loadModels(provider.value as ProviderId));

  const el = h("section", { class: "view", attrs: { "aria-labelledby": "run-title" } }, h("h1", { id: "run-title", text: "Run a task" }), noKey, form, output.el, recentSection);

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

  function current() {
    return store.currentRunId ? store.runs.get(store.currentRunId) ?? null : null;
  }

  function renderRun(): void {
    const run = current();
    output.update(run);
    const busy = !!run && !isFinished(run);
    cancelBtn.hidden = !busy;
    runBtn.textContent = busy ? "Run another" : "Run";
    renderRecent();
  }

  function renderRecent(): void {
    const runs = [...store.runs.values()].reverse().slice(0, 10);
    recentSection.hidden = runs.length < 2;
    replace(
      recent,
      ...runs.map((r) =>
        h(
          "li",
          null,
          h("button", {
            type: "button",
            class: `link ${r.runId === store.currentRunId ? "current" : ""}`,
            attrs: { "aria-current": r.runId === store.currentRunId ? "true" : null },
            text: `${truncate(r.input ?? "Background run", 60)} — ${STATUS_LABEL[r.status]}`,
            on: {
              click: () => {
                store.currentRunId = r.runId;
                renderRun();
              },
            },
          }),
        ),
      ),
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
      store.startRun(runId, input);
      formStatus.textContent = "";
    } catch (e) {
      formStatus.textContent = describeError(e);
      ctx.notify(formStatus.textContent, "error");
    } finally {
      runBtn.disabled = store.readyProviders().length === 0;
    }
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
