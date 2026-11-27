// Apps: drafts from runs (pin), pinned apps (open, export, unpin).

import type { PinnedApp } from "@oneseat/contracts";
import { describeError } from "../api";
import type { ArtifactDraft } from "../artifacts";
import { button, h, replace } from "../dom";
import { formatBytes, formatTime } from "../format";
import type { Ctx, View } from "./context";
import { pinDraft } from "./run";

/** An app icon element: data: URI image, or emoji text. */
export function appIcon(icon: string | undefined, name: string): HTMLElement {
  if (icon && /^data:image\/(png|svg\+xml);base64,/.test(icon)) {
    return h("img", { class: "app-icon", src: icon, alt: "", width: 32, height: 32 });
  }
  const glyph = icon && [...icon].length <= 2 ? icon : (name.trim()[0] ?? "?").toUpperCase();
  return h("span", { class: "app-icon", attrs: { "aria-hidden": "true" }, text: glyph });
}

export function appsView(ctx: Ctx): View {
  const { api, store } = ctx;
  const draftList = h("div", { class: "draft-list" });
  const draftsSection = h(
    "section",
    { class: "card", attrs: { "aria-labelledby": "drafts-title" } },
    h("h2", { id: "drafts-title", text: "Drafts from your runs" }),
    draftList,
  );
  const list = h("div", { class: "app-list" });
  const status = h("p", { class: "status", attrs: { role: "status" } });
  const exportOut = h("div", { class: "export-out", attrs: { "aria-live": "polite" } });

  const el = h(
    "section",
    { class: "view", attrs: { "aria-labelledby": "apps-title" } },
    h("h1", { id: "apps-title", text: "Apps" }),
    h(
      "p",
      { class: "lead" },
      "A pinned app opens in its own window. It has no internet access and can only run the skills it lists.",
    ),
    draftsSection,
    h("section", { class: "card", attrs: { "aria-labelledby": "pinned-title" } }, h("h2", { id: "pinned-title", text: "Pinned apps" }), status, list, exportOut),
  );

  function renderDrafts(): void {
    const drafts = store.drafts();
    draftsSection.hidden = drafts.length === 0;
    replace(
      draftList,
      ...drafts.map((d: ArtifactDraft) =>
        h(
          "div",
          { class: "draft-card", attrs: { "data-draft": d.bundle.app.id } },
          appIcon(d.bundle.app.icon, d.bundle.app.name),
          h("div", null, h("strong", { text: d.bundle.app.name }), h("p", { class: "muted", text: `${formatBytes(new TextEncoder().encode(d.bundle.html).length)} · can run ${d.bundle.app.allowedSkills.join(", ") || "no skills"}` })),
          button("Pin as app", () => void pinDraft(ctx, d).then((ok) => {
            if (ok) void refresh();
          }), { kind: "primary", disabled: !d.pinnable }),
        ),
      ),
    );
  }

  async function onOpen(p: PinnedApp): Promise<void> {
    try {
      const r = await api.pinOpen(p.app.id);
      // Browser (dev bridge) mode: no native window; open the page in a tab instead.
      if (r && r.url) window.open(r.url, `oneseat-app-${p.app.id}`, "noopener");
      ctx.notify(`Opened ${p.app.name}.`);
    } catch (e) {
      ctx.notify(`Could not open ${p.app.name}: ${describeError(e)}`, "error");
    }
  }

  async function onExport(p: PinnedApp): Promise<void> {
    try {
      const r = await api.appExport(p.app.id);
      const cmd = h("code", { text: r.command });
      replace(
        exportOut,
        h(
          "div",
          { class: "notice" },
          h("p", null, `Files for ${p.app.name} are in `, h("code", { text: r.dir }), "."),
          h("p", { text: "To build a standalone installer for this app, run this in the OneSeat source folder:" }),
          h("pre", { class: "code" }, cmd),
          button("Copy command", () => void navigator.clipboard?.writeText(r.command).then(() => ctx.notify("Command copied."), () => {}), { kind: "ghost" }),
        ),
      );
    } catch (e) {
      ctx.notify(`Could not export ${p.app.name}: ${describeError(e)}`, "error");
    }
  }

  async function onUnpin(p: PinnedApp): Promise<void> {
    try {
      const r = await api.call("apps.unpin", { id: p.app.id });
      ctx.notify(r.ok ? `Unpinned ${p.app.name}.` : `${p.app.name} was not pinned.`);
      await refresh();
    } catch (e) {
      ctx.notify(`Could not unpin ${p.app.name}: ${describeError(e)}`, "error");
    }
  }

  function appCard(p: PinnedApp): HTMLElement {
    const actions = h("div", { class: "row" });
    const unpin: HTMLButtonElement = button(
      "Unpin",
      () => {
        unpin.hidden = true;
        const yes = button(`Unpin ${p.app.name}`, () => void onUnpin(p), { kind: "danger" });
        const no = button("Keep", () => {
          yes.remove();
          no.remove();
          unpin.hidden = false;
          unpin.focus();
        });
        actions.append(yes, no);
        yes.focus();
      },
      { kind: "ghost" },
    );
    actions.append(button("Open", () => void onOpen(p), { kind: "primary" }), button("Export", () => void onExport(p)), unpin);
    return h(
      "article",
      { class: "app", attrs: { "data-app": p.app.id, "aria-labelledby": `app-${p.app.id}` } },
      appIcon(p.app.icon, p.app.name),
      h(
        "div",
        { class: "grow" },
        h("h3", { id: `app-${p.app.id}` }, p.app.name, h("span", { class: "muted", text: ` v${p.app.version}` })),
        h("p", { class: "muted", text: `Can run: ${p.app.allowedSkills.join(", ") || "no skills"} · ${p.app.window.width}×${p.app.window.height} · pinned ${formatTime(p.pinnedAt)}` }),
        actions,
      ),
    );
  }

  async function refresh(): Promise<void> {
    renderDrafts();
    try {
      const r = await api.call("apps.list", {});
      status.textContent = r.apps.length ? "" : "No pinned apps yet. When a run makes an app, pin it here or from the Run screen.";
      replace(list, ...r.apps.map(appCard));
    } catch (e) {
      status.textContent = `Could not load apps: ${describeError(e)}`;
    }
  }

  store.subscribe((c) => {
    if (c.type === "drafts") renderDrafts();
  });

  return { el, show: () => void refresh() };
}
