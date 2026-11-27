// Tiny DOM helpers. Text is always set as text (never innerHTML), so nothing a skill,
// a model or a daemon returns can inject markup into the main window.

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  /** Attributes (aria-*, data-*, role, for, ...). `false`/`null` removes. */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
  [prop: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined) continue;
      if (k === "class") el.className = String(v);
      else if (k === "attrs") setAttrs(el, v as Props["attrs"]);
      else if (k === "on") {
        for (const [name, fn] of Object.entries(v as Record<string, EventListener>)) if (fn) el.addEventListener(name, fn);
      } else if (k === "text") el.textContent = String(v);
      else (el as unknown as Record<string, unknown>)[k] = v;
    }
  }
  append(el, children);
  return el;
}

export function setAttrs(el: Element, attrs: Props["attrs"]): void {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === false || v === null || v === undefined) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

let idSeq = 0;
/** Unique id for label/aria wiring. */
export function uid(prefix = "id"): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/** Announce a message to screen readers through the shared live region. */
export function announce(message: string): void {
  const region = document.getElementById("announcer");
  if (!region) return;
  region.textContent = "";
  // A new text node on the next frame makes repeated messages announce again.
  setTimeout(() => (region.textContent = message), 30);
}

/** A labelled form field. */
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || uid("f");
  control.id = id;
  const hintEl = hint ? h("p", { class: "hint", id: `${id}-hint`, text: hint }) : null;
  if (hintEl) control.setAttribute("aria-describedby", hintEl.id);
  return h("div", { class: "field" }, h("label", { attrs: { for: id }, text: label }), control, hintEl);
}

export interface ButtonOpts {
  kind?: "primary" | "danger" | "ghost";
  disabled?: boolean;
  /** Tooltip. */
  title?: string;
  /** Accessible name when the visible label is not specific enough ("Remove" in a list). */
  ariaLabel?: string;
  type?: "button" | "submit";
}

export function button(label: string, onClick: (ev: MouseEvent) => void, opts: ButtonOpts = {}): HTMLButtonElement {
  return h("button", {
    type: opts.type ?? "button",
    class: `btn ${opts.kind ?? ""}`.trim(),
    disabled: opts.disabled ?? false,
    title: opts.title,
    attrs: { "aria-label": opts.ariaLabel },
    text: label,
    on: { click: onClick },
  });
}
