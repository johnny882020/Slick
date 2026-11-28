// Contract 4 — ArtifactBundle.
// One self-contained HTML file plus a small app.json.
// A pinned page opens in its own native window. It has no network access:
// it can only call oneseat.run(skill, input), and only for skills in app.json.
// FROZEN at end of week 2.

export interface AppWindow {
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
}

export interface AppJson {
  /** Stable id, lowercase slug. Also the window label. */
  id: string;
  name: string;
  version: string;
  /** Either a data: URI (PNG or SVG) or a single emoji. */
  icon?: string;
  window: AppWindow;
  /** Skills the page may call through oneseat.run(). Nothing else is reachable. */
  allowedSkills: string[];
  /** The skill that made the page, if any. */
  createdBy?: string;
}

export interface ArtifactBundle {
  html: string;
  app: AppJson;
}

/** The bridge a pinned page sees. Nothing else is exposed. */
export interface OneSeatBridge {
  run(skill: string, input: string | Record<string, unknown>): Promise<BridgeResult>;
}

export interface BridgeResult {
  ok: boolean;
  /** Final text from the skill run. */
  text: string;
  /** Parsed JSON if the final text is JSON. */
  data?: unknown;
  error?: string;
}

/**
 * Content policy for pinned pages. No remote anything. ipc: and
 * http://ipc.localhost are Tauri's IPC channels (the only way out).
 */
export const PINNED_APP_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src ipc: http://ipc.localhost",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export const APP_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface ArtifactIssue {
  severity: "error" | "warning";
  rule: string;
  message: string;
}

/** Turn a name into an app id. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "app"
  );
}

export function validateAppJson(app: unknown): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const e = (rule: string, message: string) => issues.push({ severity: "error", rule, message });
  if (!app || typeof app !== "object") return [{ severity: "error", rule: "app-json", message: "app.json must be an object" }];
  const a = app as Partial<AppJson>;
  if (typeof a.id !== "string" || !APP_ID_PATTERN.test(a.id)) e("app-id", "id must be a lowercase slug");
  if (typeof a.name !== "string" || a.name.trim() === "" || a.name.length > 80) e("app-name", "name must be 1 to 80 characters");
  if (typeof a.version !== "string" || !/^\d+\.\d+\.\d+/.test(a.version)) e("app-version", "version must be semver");
  const w = a.window;
  if (!w || typeof w !== "object") e("app-window", "window is required");
  else {
    for (const k of ["width", "height"] as const)
      if (typeof w[k] !== "number" || w[k] < 200 || w[k] > 4000) e("app-window", `window.${k} must be 200 to 4000`);
  }
  if (!Array.isArray(a.allowedSkills) || !a.allowedSkills.every((s) => typeof s === "string"))
    e("app-skills", "allowedSkills must be a list of skill names");
  if (a.icon !== undefined) {
    const ok =
      typeof a.icon === "string" &&
      (/^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(a.icon) || [...a.icon].length <= 2);
    if (!ok) e("app-icon", "icon must be a PNG/SVG data: URI or one emoji");
  }
  return issues;
}

/**
 * Check that HTML is self-contained: no remote scripts, styles, images,
 * frames, forms or fetches. Pinned pages must work offline and leak nothing.
 */
export function validateArtifactHtml(html: string): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const e = (rule: string, message: string) => issues.push({ severity: "error", rule, message });
  const w = (rule: string, message: string) => issues.push({ severity: "warning", rule, message });
  if (new TextEncoder().encode(html).length > MAX_ARTIFACT_BYTES) e("size", "HTML is over 5 MB");
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html) && !/<!doctype html>/i.test(html))
    w("document", "HTML has no <html> or <body>; it will be wrapped");
  const remote = /(?:src|href|action|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//gi;
  for (const m of html.matchAll(remote)) {
    const tagStart = html.lastIndexOf("<", m.index ?? 0);
    const tag = html.slice(tagStart, (m.index ?? 0) + 1).toLowerCase();
    if (tag.startsWith("<a ") || tag.startsWith("<a\n")) {
      w("remote-link", "page links to a remote URL; links open in the system browser");
      continue;
    }
    e("remote-resource", `remote resource at offset ${m.index}: pinned pages must be self-contained`);
  }
  if (/@import\s+(url\()?["']?(https?:)?\/\//i.test(html)) e("remote-css", "CSS @import of a remote URL");
  if (/url\(\s*["']?(https?:)?\/\//i.test(html)) e("remote-css", "CSS url() to a remote URL");
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/.test(html) || /new\s+(XMLHttpRequest|WebSocket|EventSource)\b/.test(html))
    w("network-api", "page uses a network API; the content policy will block it. Use oneseat.run()");
  if (/<iframe\b/i.test(html)) e("iframe", "iframes are not allowed");
  if (/<base\b/i.test(html)) e("base", "<base> is not allowed");
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) e("refresh", "meta refresh is not allowed");
  return issues;
}

export function validateArtifactBundle(b: ArtifactBundle): ArtifactIssue[] {
  return [...validateAppJson(b.app), ...validateArtifactHtml(b.html)];
}

/** Names of skills a page calls via oneseat.run("name", ...), for checking against allowedSkills. */
export function findBridgeCalls(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/oneseat\.run\(\s*["'`]([a-z0-9-]+)["'`]/g)) out.add(m[1]!);
  return [...out].sort();
}
