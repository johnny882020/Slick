// App shell: navigation, routing, daemon status, notifications. Light theme only.

import { Api } from "./api";
import { announce, h, replace } from "./dom";
import type { DaemonStatus } from "./protocol";
import { Store } from "./store";
import type { Transport } from "./transport";
import { activityView } from "./views/activity";
import { planView } from "./views/plan";
import { appsView } from "./views/apps";
import { createApprovalDialog } from "./views/approval";
import { ROUTES, type Ctx, type Route, type View } from "./views/context";
import { runView } from "./views/run";
import { schedulesView } from "./views/schedules";
import { setupView } from "./views/setup";
import { skillsView } from "./views/skills";

export function parseRoute(hash: string): Route | null {
  const id = hash.replace(/^#\/?/, "").split(/[/?]/)[0];
  return ROUTES.some((r) => r.id === id) ? (id as Route) : null;
}

export function daemonBanner(s: DaemonStatus | null): string | null {
  if (!s) return null;
  switch (s.state) {
    case "running":
      return null;
    case "starting":
      return "Starting OneSeat's engine…";
    case "restarting":
      return `OneSeat's engine stopped and is restarting${s.lastError ? ` (${s.lastError})` : ""}.`;
    case "failed":
      return `OneSeat's engine could not start${s.lastError ? `: ${s.lastError}` : ""}. Retrying.`;
    case "stopped":
      return "OneSeat's engine has stopped.";
  }
}

export async function startApp(root: HTMLElement, transport: Transport): Promise<{ ctx: Ctx; store: Store }> {
  const api = new Api(transport);
  const store = new Store();

  // Visual only: screen readers get the same message once, from the #announcer live region.
  const toast = h("div", { class: "toast", attrs: { "aria-hidden": "true", hidden: true } });
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const banner = h("div", { class: "banner", attrs: { role: "status", hidden: true } });

  const views = new Map<Route, View>();
  const main = h("main", { id: "main", tabIndex: -1 });
  const navLinks = new Map<Route, HTMLAnchorElement>();
  let route: Route | null = null;

  const ctx: Ctx = {
    api,
    store,
    navigate(r) {
      if (location.hash !== `#/${r}`) location.hash = `#/${r}`;
      else show(r);
    },
    notify(message, kind = "info") {
      announce(message);
      toast.textContent = message;
      toast.dataset["kind"] = kind;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.hidden = true), kind === "error" ? 8000 : 3500);
    },
    reviewApproval(id) {
      approvals.open(id);
    },
  };

  const approvals = createApprovalDialog(ctx);

  const factories: Record<Route, (c: Ctx) => View> = {
    setup: setupView,
    run: runView,
    skills: skillsView,
    apps: appsView,
    schedules: schedulesView,
    activity: activityView,
    plan: planView,
  };

  function show(r: Route): void {
    let v = views.get(r);
    if (!v) {
      v = factories[r](ctx);
      views.set(r, v);
    }
    const changed = route !== r;
    route = r;
    replace(main, v.el);
    for (const [id, a] of navLinks) {
      if (id === r) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    const label = ROUTES.find((x) => x.id === r)?.label ?? r;
    document.title = `${label} · OneSeat`;
    v.show();
    if (changed) main.focus({ preventScroll: true });
  }

  const nav = h(
    "nav",
    { attrs: { "aria-label": "Main" } },
    h(
      "ul",
      null,
      ...ROUTES.map((r) => {
        const a = h("a", { href: `#/${r.id}`, text: r.label });
        navLinks.set(r.id, a);
        return h("li", null, a);
      }),
    ),
  );

  replace(
    root,
    h("a", { class: "skip", href: "#main", text: "Skip to content", on: { click: (e) => (e.preventDefault(), main.focus()) } }),
    h("header", { class: "top" }, h("div", { class: "brand", text: "OneSeat" }), nav),
    banner,
    main,
    toast,
    approvals.el,
    h("div", { id: "announcer", class: "visually-hidden", attrs: { "aria-live": "polite" } }),
  );

  function renderBanner(): void {
    const text = daemonBanner(store.daemon);
    banner.hidden = !text;
    banner.textContent = text ?? "";
  }
  store.subscribe((c) => {
    if (c.type === "daemon" || c.type === "keys") renderBanner();
  });

  store.setDraftFetcher((draftId) => api.call("apps.draft", { draftId }));
  await api.onNotification((n) => store.handleNotification(n));
  await api.onStatus((s) => {
    store.setDaemon(s);
    // After a restart the engine reloads keys from the keychain; refresh what we show.
    if (s.state === "running") void api.keyStatus().then((k) => store.setKeyStatus(k), () => {});
  });

  window.addEventListener("hashchange", () => {
    const r = parseRoute(location.hash);
    if (r) show(r);
  });

  try {
    store.setKeyStatus(await api.keyStatus());
  } catch (e) {
    ctx.notify(`Could not reach OneSeat's engine: ${e instanceof Error ? e.message : String(e)}`, "error");
  }

  // First run: no key yet -> setup.
  const initial = parseRoute(location.hash);
  if (!store.hasAnyKey()) ctx.navigate("setup");
  else if (initial) show(initial);
  else ctx.navigate("run");
  return { ctx, store };
}
