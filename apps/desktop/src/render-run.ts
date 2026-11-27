// Renders a RunState into DOM incrementally: each item keeps its element, so streaming
// text only updates one text node and focus/scroll are not disturbed.

import { button, h, replace } from "./dom";
import { effectLabel, formatBytes, formatDuration, formatUsage, truncate } from "./format";
import type { ApprovalItem, ErrorItem, RunItem, RunState, RunStatus, TextItem, ToolItem } from "./run-state";
import type { ArtifactDraft } from "./artifacts";

export interface RunOutputHandlers {
  onReview(approvalId: string): void;
  onPin(draft: ArtifactDraft): void;
  isPinned(draft: ArtifactDraft): boolean;
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Working…",
  waiting: "Waiting for your approval",
  done: "Done",
  cancelled: "Cancelled",
  error: "Stopped with an error",
};

interface Entry {
  el: HTMLElement;
  update(item: RunItem): void;
}

function textEntry(item: TextItem): Entry {
  const el = h("div", { class: "out-text" });
  el.textContent = item.text;
  return {
    el,
    update(i) {
      const t = (i as TextItem).text;
      if (el.textContent !== t) el.textContent = t;
    },
  };
}

function toolEntry(item: ToolItem): Entry {
  const icon = h("span", { class: "tool-icon", attrs: { "aria-hidden": "true" } });
  const state = h("span", { class: "visually-hidden" });
  const duration = h("span", { class: "muted" });
  const details = h("details", { class: "tool-details" });
  const el = h(
    "li",
    { class: "tool-row", attrs: { "data-tool": item.name } },
    h(
      "div",
      { class: "tool-head" },
      icon,
      state,
      h("span", { class: "tool-name", text: item.name }),
      item.effects.length ? h("span", { class: "effects", text: item.effects.map(effectLabel).join(", ") }) : null,
      duration,
    ),
    details,
  );
  const update = (i: RunItem) => {
    const t = i as ToolItem;
    el.dataset["status"] = t.status;
    icon.textContent = t.status === "running" ? "⏳" : t.status === "ok" ? "✓" : "✕";
    state.textContent = t.status === "running" ? "Running: " : t.status === "ok" ? "Finished: " : "Failed: ";
    duration.textContent = t.durationMs !== undefined ? formatDuration(t.durationMs) : "";
    replace(
      details,
      h("summary", { text: t.status === "running" ? "Input" : "Input and result" }),
      h("pre", { class: "code", text: JSON.stringify(t.input, null, 2) }),
      t.result !== undefined ? h("pre", { class: "code", text: truncate(t.result, 4000) }) : null,
    );
  };
  update(item);
  return { el, update };
}

function approvalEntry(item: ApprovalItem, handlers: RunOutputHandlers): Entry {
  const label = h("p", { class: "approval-state" });
  const actions = h("div", { class: "row" });
  const el = h(
    "div",
    { class: "approval-card", attrs: { "data-approval": item.approvalId } },
    h("p", { class: "approval-summary" }, h("strong", { text: "Needs your approval: " }), item.summary),
    h("p", { class: "muted", text: `${item.call.name} · ${item.effects.map(effectLabel).join(", ")}` }),
    label,
    actions,
  );
  const update = (i: RunItem) => {
    const a = i as ApprovalItem;
    el.dataset["status"] = a.status;
    label.textContent = a.status === "pending" ? "Waiting for you." : a.status === "approved" ? "You approved this." : "Not approved.";
    replace(actions, a.status === "pending" ? button("Review request", () => handlers.onReview(a.approvalId), { kind: "primary" }) : null);
  };
  update(item);
  return { el, update };
}

function errorEntry(item: ErrorItem): Entry {
  const el = h(
    "div",
    { class: "notice error", attrs: { role: "alert" } },
    item.message,
    item.retryable ? h("span", { class: "muted", text: " You can try again." }) : null,
  );
  return { el, update: () => {} };
}

export function createRunOutput(handlers: RunOutputHandlers): { el: HTMLElement; update(run: RunState | null): void } {
  const statusEl = h("p", { class: "run-status", attrs: { role: "status" } });
  const chips = h("ul", { class: "chips", attrs: { "aria-label": "Skills loaded" } });
  const files = h("p", { class: "muted files" });
  const list = h("div", { class: "out-items", attrs: { "aria-live": "polite", "aria-relevant": "additions text" } });
  const usage = h("p", { class: "usage muted" });
  const drafts = h("div", { class: "drafts" });
  const el = h("section", { class: "run-output card", attrs: { "aria-label": "Run output" } }, statusEl, chips, files, list, drafts, usage);
  const entries = new Map<string, Entry>();
  let currentRun: string | null = null;
  let toolList: HTMLUListElement | null = null;

  function entryFor(item: RunItem): Entry {
    switch (item.kind) {
      case "text":
        return textEntry(item);
      case "tool":
        return toolEntry(item);
      case "approval":
        return approvalEntry(item, handlers);
      case "error":
        return errorEntry(item);
    }
  }

  function update(run: RunState | null): void {
    if (!run) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (run.runId !== currentRun) {
      currentRun = run.runId;
      entries.clear();
      replace(list);
      toolList = null;
    }
    el.dataset["status"] = run.status;
    statusEl.textContent = STATUS_LABEL[run.status];
    replace(
      chips,
      ...run.skills.map((s) =>
        h("li", { class: "chip", attrs: { "data-skill": s.name, title: s.reason === "forced" ? "Chosen by you" : "Chosen by OneSeat" } }, h("span", { attrs: { "aria-hidden": "true" }, text: "◆ " }), s.name),
      ),
    );
    chips.hidden = run.skills.length === 0;
    files.textContent = run.filesRead.length ? `Read: ${run.filesRead.map((f) => `${f.skill}/${f.file}`).join(", ")}` : "";
    for (const item of run.items) {
      const existing = entries.get(item.key);
      if (existing) {
        existing.update(item);
        continue;
      }
      const entry = entryFor(item);
      entries.set(item.key, entry);
      if (item.kind === "tool") {
        // Consecutive tool rows share one list.
        const last = list.lastElementChild;
        if (!toolList || last !== toolList) {
          toolList = h("ul", { class: "tool-list", attrs: { "aria-label": "Tool calls" } });
          list.appendChild(toolList);
        }
        toolList.appendChild(entry.el);
      } else {
        list.appendChild(entry.el);
      }
    }
    const hasUsage = run.usage.inputTokens > 0 || run.usage.outputTokens > 0;
    usage.textContent = hasUsage ? `Usage: ${formatUsage(run.usage)}${run.turns > 1 ? ` over ${run.turns} turns` : ""}` : "";
    replace(
      drafts,
      ...run.artifacts.map((d) => {
        const pinned = handlers.isPinned(d);
        const errors = d.issues.filter((i) => i.severity === "error");
        return h(
          "div",
          { class: "draft-card", attrs: { "data-draft": d.bundle.app.id } },
          h("p", null, h("strong", { text: d.bundle.app.name }), h("span", { class: "muted", text: ` · app draft · ${formatBytes(new TextEncoder().encode(d.bundle.html).length)}` })),
          h("p", { class: "muted", text: `Can run: ${d.bundle.app.allowedSkills.join(", ") || "no skills"}` }),
          errors.length ? h("ul", { class: "issues" }, ...errors.map((i) => h("li", { text: i.message }))) : null,
          pinned
            ? h("p", { class: "ok", text: "Pinned. Find it under Apps." })
            : button("Pin as app", () => handlers.onPin(d), { kind: "primary", disabled: !d.pinnable, title: d.pinnable ? undefined : "Fix the issues above first" }),
        );
      }),
    );
  }

  return { el, update };
}

