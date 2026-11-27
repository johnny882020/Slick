// ArtifactBundle conformance (contract 4): one self-contained HTML file + app.json,
// bridge calls limited to app.allowedSkills.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBridgeCalls, validateAppJson, validateArtifactHtml, type ArtifactBundle } from "@oneseat/contracts";

/** Load a bundle from a folder holding index.html and app.json. */
export function loadArtifactBundle(dir: string): ArtifactBundle {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as ArtifactBundle["app"];
  return { html, app };
}

export interface ArtifactBundleReport {
  id: string;
  checks: Record<string, string[]>;
}

export const ARTIFACT_CHECKS = [
  "app.json is valid",
  "HTML is self-contained (no remote resources, frames or base)",
  "oneseat.run() calls only allowed skills",
  "no inline script reaches for globals outside the bridge",
] as const;

/** Run every bundle check. Never throws. */
export function checkArtifactBundle(bundle: ArtifactBundle): ArtifactBundleReport {
  const checks: Record<string, string[]> = Object.fromEntries(ARTIFACT_CHECKS.map((c) => [c, [] as string[]]));
  const id = typeof bundle?.app?.id === "string" ? bundle.app.id : "unknown";
  if (!bundle || typeof bundle.html !== "string") {
    checks[ARTIFACT_CHECKS[1]]!.push("bundle.html must be a string");
    return { id, checks };
  }
  for (const i of validateAppJson(bundle.app)) if (i.severity === "error") checks[ARTIFACT_CHECKS[0]]!.push(`[${i.rule}] ${i.message}`);
  for (const i of validateArtifactHtml(bundle.html)) if (i.severity === "error") checks[ARTIFACT_CHECKS[1]]!.push(`[${i.rule}] ${i.message}`);
  const allowed = Array.isArray(bundle.app?.allowedSkills) ? bundle.app.allowedSkills : [];
  for (const s of findBridgeCalls(bundle.html)) if (!allowed.includes(s)) checks[ARTIFACT_CHECKS[2]]!.push(`page calls oneseat.run("${s}") but app.json allowedSkills does not list it`);
  if (/oneseat\.run\(\s*[^"'`\s)]/.test(bundle.html)) checks[ARTIFACT_CHECKS[2]]!.push("oneseat.run() must name its skill with a string literal so it can be checked");
  // The bridge is the only way out. Tauri internals must not be touched from a pinned page.
  for (const g of ["__TAURI__", "__TAURI_INTERNALS__", "__TAURI_IPC__", "window.ipc"]) if (bundle.html.includes(g)) checks[ARTIFACT_CHECKS[3]]!.push(`page references ${g}; use oneseat.run() only`);
  return { id, checks };
}

/** Register ArtifactBundle conformance (vitest). Accepts bundles or folders with index.html + app.json. */
export function describeArtifactBundleConformance(bundle: ArtifactBundle | string | readonly (ArtifactBundle | string)[]): void {
  const list = Array.isArray(bundle) ? bundle : [bundle];
  describe("conformance: ArtifactBundle", () => {
    for (const [i, b] of list.entries()) {
      let loaded: ArtifactBundle | undefined;
      let loadError: string | undefined;
      try {
        loaded = typeof b === "string" ? loadArtifactBundle(b) : (b as ArtifactBundle);
      } catch (e) {
        loadError = (e as Error).message;
      }
      const label = typeof b === "string" ? b : (loaded?.app?.id ?? `#${i}`);
      describe(label, () => {
        if (loadError !== undefined || !loaded) {
          it("loads", () => expect(loadError).toBeUndefined());
          return;
        }
        const report = checkArtifactBundle(loaded);
        for (const c of ARTIFACT_CHECKS) it(c, () => expect(report.checks[c]).toEqual([]));
      });
    }
  });
}
