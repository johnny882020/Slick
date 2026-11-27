// Plan: which OneSeat plan this computer is on, license activation, and pilot feedback.
// The license key, a random computer id and the computer's name go to OneSeat Cloud;
// business data and model keys never do.

import { FEATURE_LABELS, PLANS, type Entitlement, type Feature } from "@oneseat/contracts";
import { describeError } from "../api";
import { button, field, h, replace } from "../dom";
import type { Ctx, View } from "./context";

export const PLANS_URL = "https://oneseat-cloud.onrender.com/#plans";

export function planSummary(e: Entitlement): string {
  const p = PLANS[e.tier];
  if (e.tier === "free") return e.reason ? `Free. ${capitalise(e.reason)}.` : "Free: one computer and the seven starter skills.";
  const until = e.expiresAt ? ` Works offline until ${new Date(e.expiresAt).toLocaleDateString()}.` : "";
  const state = e.status === "past_due" ? " Payment is past due: update it in Manage billing." : "";
  return `${p.name}, up to ${e.computers} computers${e.email ? `, for ${e.email}` : ""}.${until}${state}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function featureRows(e: Entitlement): { feature: Feature; label: string; included: boolean }[] {
  return (Object.keys(FEATURE_LABELS) as Feature[]).map((f) => ({ feature: f, label: FEATURE_LABELS[f], included: e.features.includes(f) }));
}

export function planView(ctx: Ctx): View {
  const { api } = ctx;
  const summary = h("p", { class: "lead", attrs: { "data-testid": "plan-summary" } });
  const features = h("ul", { class: "features", attrs: { "aria-label": "Plan features" } });
  const status = h("p", { class: "status", attrs: { role: "status", "aria-live": "polite" } });

  const keyInput = h("input", { name: "license-key", autocomplete: "off", spellcheck: false, placeholder: "OS-XXXX-XXXX-XXXX-XXXX", attrs: { autocapitalize: "characters" } });
  const activateBtn = button("Activate", () => void activate(), { kind: "primary" });
  const deactivateBtn = button("Use Free on this computer", () => void deactivate());
  deactivateBtn.hidden = true;

  const message = h("textarea", { name: "feedback", rows: 5, attrs: { maxlength: "5000", dir: "auto" } });
  const rating = h("select", { name: "rating" }, h("option", { value: "", text: "No rating" }), ...[5, 4, 3, 2, 1].map((n) => h("option", { value: String(n), text: `${n} of 5` })));
  const topic = h("input", { name: "topic", placeholder: "e.g. invoices, install, approvals", autocomplete: "off", attrs: { dir: "auto" } });
  const email = h("input", { type: "email", name: "email", placeholder: "Optional, if you'd like a reply", autocomplete: "email" });
  const fbStatus = h("p", { class: "status", attrs: { role: "status", "aria-live": "polite" } });
  const sendBtn = button("Send feedback", () => void sendFeedback(), { kind: "primary" });

  const el = h(
    "section",
    { class: "view view-plan", attrs: { "aria-labelledby": "plan-title" } },
    h("h1", { id: "plan-title", text: "Plan" }),
    summary,
    features,
    h(
      "section",
      { class: "card", attrs: { "aria-labelledby": "license-title" } },
      h("h2", { id: "license-title", text: "License key" }),
      h("p", { class: "hint", text: "Pro and Team unlock skill imports, pinned apps, schedules and MCP connectors. Paste the key from your welcome page. Only the key, a random id for this computer and its name are sent to OneSeat Cloud." }),
      h("form", { on: { submit: (e: Event) => (e.preventDefault(), void activate()) } }, field("License key", keyInput), h("div", { class: "row" }, activateBtn, deactivateBtn)),
      h("p", { class: "hint" }, "See plans and prices at ", h("code", { text: PLANS_URL.replace(/^https:\/\//, "").replace("/#plans", "") }), "."),
      status,
    ),
    h(
      "section",
      { class: "card", attrs: { "aria-labelledby": "feedback-title" } },
      h("h2", { id: "feedback-title", text: "Send feedback" }),
      h("p", { class: "hint", text: "Tell us what worked and what didn't. Don't include API keys or customer data." }),
      h(
        "form",
        { on: { submit: (e: Event) => (e.preventDefault(), void sendFeedback()) } },
        field("What happened?", message),
        h("div", { class: "row" }, field("Rating", rating), field("Topic", topic), field("Email", email)),
        h("div", { class: "row" }, sendBtn),
      ),
      fbStatus,
    ),
  );

  function render(e: Entitlement): void {
    summary.textContent = planSummary(e);
    replace(features, ...featureRows(e).map((r) => h("li", { class: r.included ? "yes" : "no", attrs: { "data-feature": r.feature } }, h("span", { attrs: { "aria-hidden": "true" }, text: r.included ? "✓ " : "– " }), r.label + (r.included ? "" : " (Pro and Team)"))));
    deactivateBtn.hidden = e.tier === "free";
  }

  async function refresh(): Promise<void> {
    try {
      render(await api.call("license.status", {}));
    } catch (e) {
      summary.textContent = `Could not read the plan: ${describeError(e)}`;
    }
  }

  async function activate(): Promise<void> {
    const key = keyInput.value.trim();
    if (!key) {
      status.textContent = "Paste a license key first.";
      keyInput.focus();
      return;
    }
    activateBtn.disabled = true;
    status.textContent = "Activating…";
    try {
      const e = await api.call("license.activate", { licenseKey: key });
      render(e);
      keyInput.value = "";
      status.textContent = `Activated: ${PLANS[e.tier].name}.`;
      ctx.notify(`OneSeat ${PLANS[e.tier].name} is active on this computer.`);
    } catch (e) {
      status.textContent = `Could not activate: ${describeError(e)}`;
    } finally {
      activateBtn.disabled = false;
    }
  }

  async function deactivate(): Promise<void> {
    status.textContent = "Freeing this computer's slot…";
    try {
      render(await api.call("license.deactivate", {}));
      status.textContent = "This computer is on Free. The license slot is free for another computer.";
    } catch (e) {
      status.textContent = `Could not deactivate: ${describeError(e)}`;
    }
  }

  async function sendFeedback(): Promise<void> {
    const text = message.value.trim();
    if (!text) {
      fbStatus.textContent = "Write a few words first.";
      message.focus();
      return;
    }
    sendBtn.disabled = true;
    fbStatus.textContent = "Sending…";
    try {
      await api.call("feedback.send", {
        message: text,
        ...(rating.value ? { rating: Number(rating.value) } : {}),
        ...(topic.value.trim() ? { topic: topic.value.trim() } : {}),
        ...(email.value.trim() ? { email: email.value.trim() } : {}),
      });
      message.value = "";
      fbStatus.textContent = "Thank you! Your feedback was sent.";
    } catch (e) {
      fbStatus.textContent = `Could not send feedback: ${describeError(e)}`;
    } finally {
      sendBtn.disabled = false;
    }
  }

  return { el, show: () => void refresh() };
}
