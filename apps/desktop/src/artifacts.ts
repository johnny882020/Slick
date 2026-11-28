// Artifact drafts: an ArtifactBundle ({ html, app }) produced during a run.
//
// HarnessEvent has no dedicated artifact event, so a draft is recognised from a tool
// result whose content is a JSON ArtifactBundle (optionally wrapped as { artifact } or
// { bundle }), or from a ```oneseat-artifact fenced JSON block in the final text.

import { validateArtifactBundle, type ArtifactBundle, type ArtifactIssue } from "@oneseat/contracts";

export interface ArtifactDraft {
  /** Stable key: runId + app id. */
  key: string;
  runId: string;
  bundle: ArtifactBundle;
  issues: ArtifactIssue[];
  /** Errors block pinning; warnings are shown. */
  pinnable: boolean;
}

function asBundle(v: unknown): ArtifactBundle | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  for (const inner of [o["artifact"], o["bundle"]]) {
    const b = asBundle(inner);
    if (b) return b;
  }
  if (typeof o["html"] !== "string") return null;
  const app = o["app"];
  if (!app || typeof app !== "object" || typeof (app as { id?: unknown }).id !== "string") return null;
  return { html: o["html"], app: app as ArtifactBundle["app"] };
}

/** An ArtifactBundle in a tool result's content, if there is one. */
export function bundleFromToolContent(content: string): ArtifactBundle | null {
  const t = content.trim();
  if (!t.startsWith("{") || !t.includes('"html"')) return null;
  try {
    return asBundle(JSON.parse(t));
  } catch {
    return null;
  }
}

/** ArtifactBundles in ```oneseat-artifact blocks of the final text. */
export function bundlesFromText(text: string): ArtifactBundle[] {
  const out: ArtifactBundle[] = [];
  for (const m of text.matchAll(/```oneseat-artifact\s*\n([\s\S]*?)```/g)) {
    try {
      const b = asBundle(JSON.parse(m[1]!));
      if (b) out.push(b);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

export function makeDraft(runId: string, bundle: ArtifactBundle): ArtifactDraft {
  const issues = validateArtifactBundle(bundle);
  return {
    key: `${runId}:${bundle.app.id}`,
    runId,
    bundle,
    issues,
    pinnable: !issues.some((i) => i.severity === "error"),
  };
}
