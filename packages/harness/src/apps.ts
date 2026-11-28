// Pinned apps: <dataDir>/apps/<id>/index.html + app.json (+ pin.json with the pin time).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ID_PATTERN,
  PINNED_APP_CSP,
  validateArtifactBundle,
  type AppJson,
  type ArtifactBundle,
  type ArtifactIssue,
  type BridgeResult,
  type PinnedApp,
} from "@oneseat/contracts";

export class AppError extends Error {
  override name = "AppError";
  constructor(
    message: string,
    readonly issues: ArtifactIssue[] = [],
  ) {
    super(message);
  }
}

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PINNED_APP_CSP}">`;

/** Make the stored page a full document carrying the pinned-app content policy. */
export function prepareHtml(html: string): string {
  let doc = html;
  if (!/<html[\s>]/i.test(doc)) {
    const hasBody = /<body[\s>]/i.test(doc);
    doc = `<!doctype html>\n<html>\n<head><meta charset="utf-8"></head>\n${hasBody ? doc : `<body>\n${doc}\n</body>`}\n</html>`;
  }
  if (/http-equiv\s*=\s*["']?Content-Security-Policy/i.test(doc)) {
    // Replace any CSP the page brought with ours.
    doc = doc.replace(/<meta[^>]+http-equiv\s*=\s*["']?Content-Security-Policy[^>]*>/gi, CSP_META);
  } else if (/<head[^>]*>/i.test(doc)) doc = doc.replace(/<head[^>]*>/i, (m) => `${m}\n${CSP_META}`);
  else doc = doc.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${CSP_META}</head>`);
  return doc;
}

export class AppStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private appDir(id: string): string {
    if (!APP_ID_PATTERN.test(id)) throw new AppError(`invalid app id "${id}"`);
    return join(this.dir, id);
  }

  pin(bundle: ArtifactBundle, now = new Date()): PinnedApp {
    if (!bundle || typeof bundle !== "object" || typeof bundle.html !== "string")
      throw new AppError("apps.pin needs {html, app}");
    const issues = validateArtifactBundle(bundle);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) throw new AppError(`the app is not valid: ${errors.map((e) => e.message).join("; ")}`, issues);
    const app: AppJson = { ...bundle.app, allowedSkills: [...new Set(bundle.app.allowedSkills)] };
    const dir = this.appDir(app.id);
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    const pinnedAt = now.toISOString();
    writeFileSync(join(tmp, "index.html"), prepareHtml(bundle.html), "utf8");
    writeFileSync(join(tmp, "app.json"), JSON.stringify(app, null, 2) + "\n", "utf8");
    writeFileSync(join(tmp, "pin.json"), JSON.stringify({ pinnedAt }) + "\n", "utf8");
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { app, htmlPath: join(dir, "index.html"), pinnedAt };
  }

  get(id: string): PinnedApp | undefined {
    if (!APP_ID_PATTERN.test(id)) return undefined;
    const dir = join(this.dir, id);
    if (!existsSync(join(dir, "app.json"))) return undefined;
    try {
      const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppJson;
      let pinnedAt = "";
      try {
        pinnedAt = (JSON.parse(readFileSync(join(dir, "pin.json"), "utf8")) as { pinnedAt: string }).pinnedAt;
      } catch {
        /* older pin without pin.json */
      }
      return { app, htmlPath: join(dir, "index.html"), pinnedAt };
    } catch {
      return undefined;
    }
  }

  list(): PinnedApp[] {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && APP_ID_PATTERN.test(d.name))
      .map((d) => this.get(d.name))
      .filter((a): a is PinnedApp => a !== undefined)
      .sort((a, b) => a.app.name.localeCompare(b.app.name));
  }

  unpin(id: string): boolean {
    if (!this.get(id)) return false;
    rmSync(this.appDir(id), { recursive: true, force: true });
    return true;
  }

  allowedSkills(id: string): string[] | undefined {
    return this.get(id)?.app.allowedSkills;
  }
}

/** Parse the final text of a skill run as JSON when it is JSON (bare or in a ```json fence). */
export function parseJsonText(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  if (/^[[{"\d-]|^(true|false|null)$/.test(t)) {
    const v = tryParse(t);
    if (v !== undefined) return v;
  }
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i);
  if (fence) return tryParse(fence[1]!.trim());
  return undefined;
}

export function bridgeResult(stopReason: string, text: string, error?: string): BridgeResult {
  const okReasons = new Set(["end_turn", "stop_sequence", "max_tokens", "tool_use"]);
  const ok = okReasons.has(stopReason) && !error;
  const r: BridgeResult = { ok, text };
  const data = parseJsonText(text);
  if (data !== undefined) r.data = data;
  if (!ok) r.error = error ?? (stopReason === "max_turns" ? "the skill did not finish in time" : stopReason === "cancelled" ? "cancelled" : `stopped: ${stopReason}`);
  return r;
}
