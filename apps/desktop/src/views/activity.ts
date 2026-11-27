// Activity: the action log (every tool action, with approvals).

import type { ActionLogEntry } from "@oneseat/contracts";
import { describeError } from "../api";
import { button, field, h, replace } from "../dom";
import { effectLabel, formatTime } from "../format";
import type { Ctx, View } from "./context";

export function approvalLabel(a: boolean | null): string {
  return a === null ? "Not needed" : a ? "Approved" : "Denied";
}

export function activityView(ctx: Ctx): View {
  const { api } = ctx;
  const tbody = h("tbody");
  const status = h("p", { class: "status", attrs: { role: "status" } });
  const limit = h(
    "select",
    { name: "limit", on: { change: () => void refresh() } },
    ...[50, 100, 500].map((n) => h("option", { value: String(n), text: `Last ${n}` })),
  );

  const el = h(
    "section",
    { class: "view view-activity", attrs: { "aria-labelledby": "activity-title" } },
    h("h1", { id: "activity-title", text: "Activity" }),
    h("p", { class: "lead", text: "Every action OneSeat took for you, newest first." }),
    h("div", { class: "row" }, field("Show", limit), button("Refresh", () => void refresh())),
    status,
    h(
      "div",
      { class: "card table-card" },
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, ...["Time", "Action", "What it does", "Approval", "Result", "Details"].map((t) => h("th", { scope: "col", text: t })))),
          tbody,
        ),
      ),
    ),
  );

  function row(e: ActionLogEntry): HTMLElement {
    return h(
      "tr",
      { attrs: { "data-tool": e.tool, "data-approved": e.approved === null ? "none" : String(e.approved) } },
      h("td", null, h("time", { attrs: { datetime: e.at }, text: formatTime(e.at) })),
      h("td", null, h("code", { text: e.tool })),
      h("td", { text: e.effects.map(effectLabel).join(", ") || "—" }),
      h("td", { class: e.approved === false ? "denied" : "", text: approvalLabel(e.approved) }),
      h("td", { class: e.isError ? "error-text" : "", text: e.isError ? "Error" : "OK" }),
      h("td", { attrs: { dir: "auto" }, text: e.summary }),
    );
  }

  async function refresh(): Promise<void> {
    status.textContent = "Loading…";
    try {
      const r = await api.call("actions.log", { limit: Number(limit.value) });
      status.textContent = r.entries.length ? `${r.entries.length} action${r.entries.length === 1 ? "" : "s"}.` : "Nothing yet.";
      replace(tbody, ...r.entries.map(row));
    } catch (e) {
      status.textContent = `Could not load activity: ${describeError(e)}`;
    }
  }

  return { el, show: () => void refresh() };
}
