// Approval drawer: anything that sends, pays or deletes waits here for a person.
// It shows requests from every run (including schedules and pinned apps), one at a time.

import { describeError } from "../api";
import { announce, button, field, h, replace } from "../dom";
import { effectLabel } from "../format";
import type { PendingApproval } from "../store";
import type { Ctx } from "./context";

export function createApprovalDialog(ctx: Pick<Ctx, "api" | "store" | "notify">): { el: HTMLDialogElement; open(approvalId?: string): void } {
  const { api, store } = ctx;
  const dismissed = new Set<string>();
  let current: PendingApproval | null = null;
  let busy = false;

  const title = h("h2", { id: "approval-title", text: "Approve this action?" });
  const summary = h("p", { class: "approval-summary", id: "approval-desc", attrs: { dir: "auto" } });
  const meta = h("div", { class: "approval-meta" });
  const note = h("textarea", { name: "approval-note", rows: 2, placeholder: "For example: wait until Friday", attrs: { dir: "auto" } });
  const error = h("p", { class: "error-text", attrs: { role: "alert" } });
  const approve = button("Approve", () => void decide(true), { kind: "primary" });
  const deny = button("Deny", () => void decide(false), { kind: "danger" });
  const later = button("Decide later", () => close(true), { kind: "ghost" });

  const el = h(
    "dialog",
    { class: "approval-dialog", attrs: { "aria-labelledby": "approval-title", "aria-describedby": "approval-desc" } },
    h(
      "form",
      { method: "dialog", class: "stack", on: { submit: (e) => e.preventDefault() } },
      title,
      summary,
      meta,
      field("Note for OneSeat (optional)", note, "OneSeat passes your note to the model, for example to say why you said no."),
      error,
      h("div", { class: "row" }, approve, deny, later),
    ),
  );
  el.addEventListener("cancel", (e) => {
    // Escape: keep the request waiting; it stays reviewable from the run.
    e.preventDefault();
    close(true);
  });
  // A click on the backdrop (outside the drawer) does the same as Escape. Only when the
  // press also started there, so a text selection dragged out of the drawer does not close it.
  let downOnBackdrop = false;
  el.addEventListener("pointerdown", (e) => (downOnBackdrop = e.target === el));
  el.addEventListener("click", (e) => {
    const outside = e.target === el && downOnBackdrop;
    downOnBackdrop = false;
    if (outside && !busy) close(true);
  });

  function render(a: PendingApproval): void {
    const run = store.runs.get(a.runId);
    summary.textContent = a.summary;
    replace(
      meta,
      run?.input ? h("p", { class: "muted" }, "Task: ", h("span", { attrs: { dir: "auto" }, text: run.input })) : h("p", { class: "muted", text: "From a background run (a schedule or a pinned app)." }),
      h("p", null, "Action: ", h("code", { text: a.call.name })),
      h(
        "ul",
        { class: "effects-list", attrs: { "aria-label": "What this does" } },
        ...a.effects.map((e) => h("li", { class: e === "send" || e === "pay" || e === "delete" ? "strong" : "", text: effectLabel(e) })),
      ),
      h("details", null, h("summary", { text: "Exact details" }), h("pre", { class: "code", text: JSON.stringify(a.call.input, null, 2) })),
    );
    error.textContent = "";
    note.value = "";
  }

  function next(prefer?: string): PendingApproval | null {
    const pending = store.pendingApprovals();
    if (prefer) {
      const p = pending.find((x) => x.approvalId === prefer);
      if (p) return p;
    }
    return pending.find((x) => !dismissed.has(x.approvalId)) ?? null;
  }

  function open(approvalId?: string): void {
    if (approvalId) dismissed.delete(approvalId);
    const a = next(approvalId);
    if (!a) return;
    current = a;
    render(a);
    setBusy(false);
    if (!el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    approve.focus();
    announce(`Approval needed: ${a.summary}`);
  }

  function close(dismiss: boolean): void {
    if (dismiss && current) dismissed.add(current.approvalId);
    current = null;
    if (el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
    // Show the next waiting request, if any.
    queueMicrotask(() => {
      if (!el.open && next()) open();
    });
  }

  function setBusy(b: boolean): void {
    busy = b;
    approve.disabled = b;
    deny.disabled = b;
  }

  async function decide(approved: boolean): Promise<void> {
    const a = current;
    if (!a || busy) return;
    setBusy(true);
    const text = note.value.trim();
    try {
      const r = await api.call("harness.approve", { approvalId: a.approvalId, approved, ...(text ? { note: text } : {}) });
      store.markDecided(a.approvalId, approved);
      if (!r.ok) ctx.notify("That request is no longer waiting.");
      else ctx.notify(approved ? "Approved." : "Denied.");
      close(false);
    } catch (e) {
      error.textContent = `Could not send your answer: ${describeError(e)}`;
      setBusy(false);
    }
  }

  store.subscribe((c) => {
    if (c.type !== "approvals") return;
    if (current && !store.pendingApprovals().some((p) => p.approvalId === current!.approvalId)) {
      // Answered elsewhere, or the run ended.
      close(false);
      return;
    }
    if (!el.open && next()) open();
  });

  return { el, open };
}
