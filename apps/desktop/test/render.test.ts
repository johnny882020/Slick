import { describe, expect, it, vi } from "vitest";
import { h, field, replace, setAttrs, uid } from "../src/dom";
import { createRunOutput } from "../src/render-run";
import { initialRun, reduceRun } from "../src/run-state";
import { makeDraft } from "../src/artifacts";
import { appIcon } from "../src/views/apps";
import type { HarnessEvent } from "@oneseat/contracts";

describe("dom helpers", () => {
  it("creates elements with text, attributes, events and children, never parsing HTML", () => {
    const onClick = vi.fn();
    const el = h(
      "div",
      { class: "a b", attrs: { "data-x": 1, hidden: false, "aria-label": "lbl", title: null }, on: { click: onClick }, id: "d" },
      "<b>not bold</b>",
      3,
      null,
      false,
      [h("span", { text: "s" })],
    );
    expect(el.className).toBe("a b");
    expect(el.id).toBe("d");
    expect(el.getAttribute("data-x")).toBe("1");
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.querySelector("b")).toBeNull();
    expect(el.textContent).toBe("<b>not bold</b>3s");
    el.click();
    expect(onClick).toHaveBeenCalledOnce();
    setAttrs(el, { "data-x": null, flag: true });
    expect(el.hasAttribute("data-x")).toBe(false);
    expect(el.getAttribute("flag")).toBe("");
    replace(el, "only");
    expect(el.textContent).toBe("only");
    expect(uid("q")).not.toBe(uid("q"));
  });

  it("field wires label and hint", () => {
    const input = h("input", {});
    const f = field("Name", input, "hint text");
    const label = f.querySelector("label")!;
    expect(label.getAttribute("for")).toBe(input.id);
    expect(input.getAttribute("aria-describedby")).toBe(`${input.id}-hint`);
  });

  it("app icons: data URI image, emoji, or initial", () => {
    expect(appIcon("data:image/png;base64,AAAA", "x").tagName).toBe("IMG");
    expect(appIcon("🧾", "x").textContent).toBe("🧾");
    expect(appIcon(undefined, "invoice").textContent).toBe("I");
    expect(appIcon("javascript:alert(1)", "zed").textContent).toBe("Z");
  });
});

describe("run output", () => {
  const events: HarnessEvent[] = [
    { type: "skill_loaded", name: "weekly-report", reason: "router" },
    { type: "tool_start", call: { id: "c1", name: "db_query", input: { sql: "select 1" } }, effects: ["read"] },
    { type: "text_delta", text: "Hello" },
  ];

  it("renders skills chips, tool rows and streams text into the same node", () => {
    const handlers = { onReview: vi.fn(), onPin: vi.fn(), isPinned: () => false };
    const out = createRunOutput(handlers);
    document.body.appendChild(out.el);
    let s = events.reduce(reduceRun, initialRun("r1", "task"));
    out.update(s);
    expect(out.el.querySelector('[data-skill="weekly-report"]')?.textContent).toContain("weekly-report");
    const row = out.el.querySelector('[data-tool="db_query"]') as HTMLElement;
    expect(row.dataset["status"]).toBe("running");
    const text = out.el.querySelector(".out-text")!;
    expect(text.textContent).toBe("Hello");
    s = reduceRun(s, { type: "text_delta", text: " world" });
    s = reduceRun(s, { type: "tool_end", result: { callId: "c1", name: "db_query", content: "[1]", isError: false }, durationMs: 12 });
    out.update(s);
    expect(out.el.querySelector(".out-text")).toBe(text);
    expect(text.textContent).toBe("Hello world");
    expect(row.dataset["status"]).toBe("ok");
    expect(row.textContent).toContain("12 ms");
    expect(out.el.querySelector(".run-status")?.textContent).toBe("Working…");
  });

  it("shows approvals with a review button, drafts with Pin, and usage", () => {
    const onReview = vi.fn();
    const onPin = vi.fn();
    const out = createRunOutput({ onReview, onPin, isPinned: () => false });
    const bundle = {
      html: "<html><body>hi</body></html>",
      app: { id: "tracker", name: "Tracker", version: "1.0.0", window: { width: 500, height: 400 }, allowedSkills: ["a"] },
    };
    let s = initialRun("r2");
    s = reduceRun(s, { type: "approval_request", approvalId: "ap1", call: { id: "x", name: "email_send", input: {} }, effects: ["send"], summary: "Send the email" });
    s = { ...s, artifacts: [makeDraft("r2", bundle)] };
    s = reduceRun(s, { type: "turn_end", turn: 1, usage: { inputTokens: 1000, outputTokens: 20 } });
    out.update(s);
    expect(out.el.querySelector(".run-status")?.textContent).toBe("Waiting for your approval");
    const review = [...out.el.querySelectorAll("button")].find((b) => b.textContent === "Review request")!;
    review.click();
    expect(onReview).toHaveBeenCalledWith("ap1");
    const pin = [...out.el.querySelectorAll("button")].find((b) => b.textContent === "Pin as app")!;
    pin.click();
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ key: "r2:tracker" }));
    expect(out.el.querySelector(".usage")?.textContent).toBe("Usage: 1,000 in · 20 out tokens");
    s = reduceRun(s, { type: "approval_result", approvalId: "ap1", approved: false });
    out.update(s);
    expect((out.el.querySelector('[data-approval="ap1"]') as HTMLElement).dataset["status"]).toBe("denied");
    expect([...out.el.querySelectorAll("button")].some((b) => b.textContent === "Review request")).toBe(false);
  });

  it("resets when switching runs and hides with no run", () => {
    const out = createRunOutput({ onReview: () => {}, onPin: () => {}, isPinned: () => true });
    out.update(reduceRun(initialRun("a"), { type: "text_delta", text: "A" }));
    out.update(reduceRun(initialRun("b"), { type: "error", message: "bad", retryable: false }));
    expect(out.el.textContent).not.toContain("A");
    expect(out.el.querySelector('[role="alert"]')?.textContent).toContain("bad");
    out.update(null);
    expect(out.el.hidden).toBe(true);
  });
});
