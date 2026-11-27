// Schedules: list, add, enable/disable, remove.

import type { ProviderId, Schedule } from "@oneseat/contracts";
import { describeError } from "../api";
import { CRON_PRESETS, cronError, describeCron } from "../cron";
import { button, field, h, replace, uid } from "../dom";
import { formatTime, providerLabel, truncate } from "../format";
import type { Ctx, View } from "./context";
import { defaultModel } from "./run";

export function newScheduleId(rand: () => number = Math.random): string {
  return `sch-${Date.now().toString(36)}-${Math.floor(rand() * 1e8).toString(36)}`;
}

export function schedulesView(ctx: Ctx): View {
  const { api, store } = ctx;
  const tbody = h("tbody");
  const listStatus = h("p", { class: "status", attrs: { role: "status" } });

  const preset = h(
    "select",
    { name: "preset" },
    h("option", { value: "", text: "Choose a common time…" }),
    ...CRON_PRESETS.map((p) => h("option", { value: p.cron, text: p.label })),
  );
  const cron = h("input", { type: "text", name: "cron", value: "0 9 * * 1-5", spellcheck: false, autocomplete: "off" });
  const cronField = field("Schedule (cron: minute hour day month weekday)", cron, describeCron("0 9 * * 1-5"));
  const cronHint = cronField.querySelector(".hint")!;
  const task = h("textarea", { name: "schedule-task", rows: 3, placeholder: "For example: send me the weekly report" });
  const provider = h("select", { name: "schedule-provider" });
  const model = h("select", { name: "schedule-model" });
  const enabledId = uid("enabled");
  const enabled = h("input", { type: "checkbox", id: enabledId, checked: true });
  const formStatus = h("p", { class: "status", attrs: { role: "status" } });

  function updateCronHint(): void {
    const err = cronError(cron.value);
    cronHint.textContent = err ?? describeCron(cron.value);
    cron.setAttribute("aria-invalid", err ? "true" : "false");
  }
  cron.addEventListener("input", () => {
    preset.value = "";
    updateCronHint();
  });
  preset.addEventListener("change", () => {
    if (preset.value) {
      cron.value = preset.value;
      updateCronHint();
    }
  });

  async function fillModels(): Promise<void> {
    const p = provider.value as ProviderId;
    if (!p) return replace(model);
    try {
      const r = await api.call("models.list", { provider: p });
      replace(model, ...r.models.map((m) => h("option", { value: m.id, text: m.label })));
      const d = defaultModel(r.models);
      if (d) model.value = d;
    } catch {
      replace(model);
    }
  }
  provider.addEventListener("change", () => void fillModels());

  function renderProviders(): void {
    const ready = store.readyProviders();
    const cur = provider.value;
    replace(provider, ...ready.map((p) => h("option", { value: p, text: providerLabel(p) })));
    if (ready.includes(cur)) provider.value = cur;
    void fillModels();
  }

  const form = h(
    "form",
    {
      class: "card stack",
      attrs: { "aria-labelledby": "add-schedule-title" },
      on: {
        submit: (e) => {
          e.preventDefault();
          void onAdd();
        },
      },
    },
    h("h2", { id: "add-schedule-title", text: "Add a schedule" }),
    field("Common times", preset),
    cronField,
    field("Task", task),
    h("div", { class: "grid2" }, field("Provider", provider), field("Model", model)),
    h("div", { class: "check" }, enabled, h("label", { attrs: { for: enabledId }, text: "Enabled" })),
    h("div", { class: "row" }, h("button", { type: "submit", class: "btn primary", text: "Add schedule" })),
    formStatus,
  );

  const el = h(
    "section",
    { class: "view", attrs: { "aria-labelledby": "schedules-title" } },
    h("h1", { id: "schedules-title", text: "Schedules" }),
    h("p", { class: "lead", text: "Run a task automatically at set times. Anything that sends, pays or deletes still waits for your approval." }),
    h(
      "section",
      { class: "card", attrs: { "aria-labelledby": "sched-list-title" } },
      h("h2", { id: "sched-list-title", text: "Your schedules" }),
      listStatus,
      h(
        "table",
        { class: "table" },
        h(
          "thead",
          null,
          h("tr", null, ...["When", "Task", "Model", "Next run", "Last run", "Enabled", ""].map((t) => h("th", { scope: "col", text: t }))),
        ),
        tbody,
      ),
    ),
    form,
  );

  async function onAdd(): Promise<void> {
    const err = cronError(cron.value);
    if (err) {
      formStatus.textContent = err;
      cron.focus();
      return;
    }
    const input = task.value.trim();
    if (!input) {
      formStatus.textContent = "Describe the task to run.";
      task.focus();
      return;
    }
    if (!provider.value || !model.value) {
      formStatus.textContent = "Add a model key first, then choose a model.";
      return;
    }
    try {
      const r = await api.call("schedules.upsert", {
        id: newScheduleId(),
        cron: cron.value.trim(),
        task: { input, provider: provider.value as ProviderId, model: model.value },
        enabled: enabled.checked,
      });
      task.value = "";
      formStatus.textContent = `Added: ${describeCron(r.schedule.cron)}.`;
      ctx.notify(formStatus.textContent);
      await refresh();
    } catch (e) {
      formStatus.textContent = `Could not add the schedule: ${describeError(e)}`;
    }
  }

  async function onToggle(s: Schedule, on: boolean): Promise<void> {
    try {
      await api.call("schedules.upsert", { id: s.id, cron: s.cron, task: s.task, enabled: on });
      ctx.notify(`${on ? "Enabled" : "Paused"}: ${describeCron(s.cron)}.`);
      await refresh();
    } catch (e) {
      ctx.notify(`Could not update the schedule: ${describeError(e)}`, "error");
    }
  }

  async function onRemove(s: Schedule): Promise<void> {
    try {
      await api.call("schedules.remove", { id: s.id });
      ctx.notify(`Removed: ${describeCron(s.cron)}.`);
      await refresh();
    } catch (e) {
      ctx.notify(`Could not remove the schedule: ${describeError(e)}`, "error");
    }
  }

  function row(s: Schedule): HTMLElement {
    const id = uid("sched-on");
    const toggle = h("input", { type: "checkbox", id, checked: s.enabled, on: { change: () => void onToggle(s, toggle.checked) } });
    return h(
      "tr",
      { attrs: { "data-schedule": s.id } },
      h("td", null, describeCron(s.cron), h("div", { class: "muted" }, h("code", { text: s.cron }))),
      h("td", { text: truncate(s.task.input, 80) }),
      h("td", { text: `${providerLabel(s.task.provider)} · ${s.task.model}` }),
      h("td", { text: s.enabled ? formatTime(s.nextRunAt) || "—" : "Paused" }),
      h("td", { text: formatTime(s.lastRunAt) || "Never" }),
      h("td", null, toggle, h("label", { class: "visually-hidden", attrs: { for: id }, text: `Enabled: ${describeCron(s.cron)}` })),
      h("td", null, button("Remove", () => void onRemove(s), { kind: "ghost", ariaLabel: `Remove ${describeCron(s.cron)}` })),
    );
  }

  async function refresh(): Promise<void> {
    try {
      const r = await api.call("schedules.list", {});
      listStatus.textContent = r.schedules.length ? "" : "No schedules yet.";
      replace(tbody, ...r.schedules.map(row));
    } catch (e) {
      listStatus.textContent = `Could not load schedules: ${describeError(e)}`;
    }
  }

  store.subscribe((c) => {
    if (c.type === "keys") renderProviders();
    if (c.type === "schedule.fired") void refresh();
  });

  return {
    el,
    show() {
      renderProviders();
      updateCronHint();
      void refresh();
    },
  };
}
