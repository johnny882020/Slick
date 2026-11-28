// First-run key setup (and key management later).

import type { ProviderId } from "@oneseat/contracts";
import { describeError } from "../api";
import { button, field, h, replace, uid } from "../dom";
import { PROVIDERS, providerLabel } from "../format";
import type { KeyStatus } from "../protocol";
import type { Ctx, View } from "./context";

export function keyStatusRows(s: KeyStatus | null): { provider: ProviderId; label: string; stored: boolean; engine: string }[] {
  return (s?.providers ?? []).map((p) => ({
    provider: p.provider,
    label: providerLabel(p.provider),
    stored: p.stored,
    engine: p.active === null ? "Unknown" : p.active ? "Ready" : "Not loaded",
  }));
}

export function setupView(ctx: Ctx): View {
  const { api, store } = ctx;
  let provider: ProviderId = "anthropic";

  const keychainNotice = h("div", { class: "notice error", attrs: { role: "alert", hidden: true } });
  const status = h("p", { class: "status", attrs: { role: "status", "aria-live": "polite" } });

  const keyInput = h("input", {
    type: "password",
    name: "api-key",
    autocomplete: "off",
    spellcheck: false,
    attrs: { autocapitalize: "off", autocorrect: "off" },
  });
  const urlInput = h("input", { type: "url", name: "base-url", placeholder: "http://localhost:11434/v1", autocomplete: "off", spellcheck: false });
  const keyField = field("API key", keyInput, PROVIDERS[0]!.keyHint);
  const urlField = field("Server address (base URL)", urlInput, "Where your local model server listens.");
  urlField.hidden = true;
  const keyHint = keyField.querySelector(".hint")!;

  const radios = PROVIDERS.map((p) => {
    const id = uid("prov");
    const input = h("input", {
      type: "radio",
      name: "provider",
      id,
      value: p.id,
      checked: p.id === provider,
      on: {
        change: () => {
          provider = p.id;
          keyHint.textContent = p.keyHint;
          urlField.hidden = p.id !== "local";
          keyField.querySelector("label")!.textContent = p.id === "local" ? "API key (optional)" : "API key";
        },
      },
    });
    return h("div", { class: "radio" }, input, h("label", { attrs: { for: id }, text: p.label }));
  });

  const save = h("button", { type: "submit", class: "btn primary", text: "Save key" });
  const form = h(
    "form",
    {
      class: "card stack",
      attrs: { "aria-labelledby": "setup-form-title" },
      on: {
        submit: (e) => {
          e.preventDefault();
          void onSave();
        },
      },
    },
    h("h2", { id: "setup-form-title", text: "Add a key" }),
    h("fieldset", { class: "radios" }, h("legend", { text: "Model provider" }), ...radios),
    keyField,
    urlField,
    h("div", { class: "row" }, save),
  );

  const table = h("tbody");
  const continueBtn = button("Continue to Run", () => ctx.navigate("run"), { kind: "primary" });
  continueBtn.hidden = true;

  const el = h(
    "section",
    { class: "view view-setup", attrs: { "aria-labelledby": "setup-title" } },
    h("h1", { id: "setup-title", text: "Connect a model" }),
    h(
      "p",
      { class: "lead" },
      "OneSeat works with the model you choose. Paste a key from your model provider below. ",
      "Your key is stored in your operating system's keychain (Keychain on macOS, Credential Manager on Windows), ",
      "not in a file. OneSeat sends it only to its engine on this computer and to your model provider. ",
      "It is never shown again, and it never appears in logs.",
    ),
    keychainNotice,
    form,
    status,
    h(
      "section",
      { class: "card", attrs: { "aria-labelledby": "keys-title" } },
      h("h2", { id: "keys-title", text: "Your keys" }),
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "table" },
          h("thead", null, h("tr", null, h("th", { scope: "col", text: "Provider" }), h("th", { scope: "col", text: "In keychain" }), h("th", { scope: "col", text: "Engine" }), h("th", { scope: "col", text: "" }))),
          table,
        ),
      ),
    ),
    h("div", { class: "row" }, continueBtn),
  );

  async function onSave(): Promise<void> {
    const key = keyInput.value;
    const baseUrl = provider === "local" ? urlInput.value.trim() : undefined;
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      const s = await api.keySave(provider, key, baseUrl);
      keyInput.value = "";
      store.setKeyStatus(s);
      const row = s.providers.find((p) => p.provider === provider);
      status.textContent = row?.stored
        ? `${providerLabel(provider)} key saved in your keychain${row.active ? " and ready to use" : ""}.`
        : `${providerLabel(provider)} key was not saved.`;
      ctx.notify(status.textContent);
    } catch (e) {
      status.textContent = describeError(e);
      ctx.notify(status.textContent, "error");
    } finally {
      save.disabled = false;
    }
  }

  async function onDelete(p: ProviderId): Promise<void> {
    try {
      store.setKeyStatus(await api.keyDelete(p));
      status.textContent = `${providerLabel(p)} key removed from your keychain.`;
      ctx.notify(status.textContent);
    } catch (e) {
      status.textContent = describeError(e);
      ctx.notify(status.textContent, "error");
    }
  }

  function render(): void {
    const s = store.keyStatus;
    keychainNotice.hidden = !s || s.keychain.available;
    keychainNotice.textContent = s?.keychain.message ?? "";
    save.disabled = !!s && !s.keychain.available;
    replace(
      table,
      ...keyStatusRows(s).map((r) =>
        h(
          "tr",
          { attrs: { "data-provider": r.provider } },
          h("th", { scope: "row", text: r.label }),
          h("td", { text: r.stored ? "Saved" : "No key" }),
          h("td", { text: r.stored ? r.engine : "—" }),
          h("td", null, r.stored ? button("Remove", () => void onDelete(r.provider), { kind: "ghost", ariaLabel: `Remove the ${r.label} key` }) : null),
        ),
      ),
    );
    continueBtn.hidden = !store.hasAnyKey();
  }

  store.subscribe((c) => {
    if (c.type === "keys") render();
  });
  render();

  return {
    el,
    show() {
      render();
      void api.keyStatus().then((s) => store.setKeyStatus(s), () => {});
    },
  };
}
