// The CI workflows are part of the gates: parse them and check the structure gates 1-6 rely on.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { findRepoRoot } from "../src/index.js";

const root = findRepoRoot(import.meta.dirname);
const dir = join(root, ".github", "workflows");

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; if?: string; shell?: string; "working-directory"?: string };
type Job = { name?: string; "runs-on"?: string; needs?: string | string[]; uses?: string; strategy?: { matrix?: Record<string, unknown> }; steps?: Step[]; permissions?: Record<string, string>; if?: string; env?: Record<string, string> };
type Workflow = { name: string; on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group: string; "cancel-in-progress": boolean }; jobs: Record<string, Job> };

function load(file: string): Workflow {
  return parse(readFileSync(join(dir, file), "utf8"), { strict: true, uniqueKeys: true }) as Workflow;
}
const steps = (j: Job) => j.steps ?? [];
const runs = (j: Job) => steps(j).map((s) => s.run ?? "").join("\n");

const ALLOWED_ACTIONS = new Set([
  "actions/checkout@v4",
  "actions/setup-node@v4",
  "pnpm/action-setup@v4",
  "dtolnay/rust-toolchain@stable",
  "Swatinem/rust-cache@v2",
  "actions/upload-artifact@v4",
  "actions/cache@v4",
  "tauri-apps/tauri-action@v0",
]);

describe("workflow files", () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();

  it("exist", () => expect(files).toEqual(["ci.yml", "nightly-live.yml", "pilot-release.yml", "release.yml"]));

  for (const f of files)
    it(`${f} is valid YAML with pinned actions, minimal permissions and no secrets on PRs`, () => {
      const wf = load(f);
      expect(typeof wf.name).toBe("string");
      expect(wf.permissions).toEqual({ contents: "read" });
      expect(wf.concurrency?.group).toBeTruthy();
      for (const [id, job] of Object.entries(wf.jobs)) {
        if (job.uses) continue;
        expect(job["runs-on"], `${f} ${id}`).toBeTruthy();
        for (const s of steps(job)) {
          expect(!!s.uses !== !!s.run, `${f} ${id}: a step has exactly one of uses/run`).toBe(true);
          if (s.uses) expect(ALLOWED_ACTIONS.has(s.uses), `${f} ${id}: ${s.uses} is not a pinned, allowed action`).toBe(true);
        }
      }
      if (f === "ci.yml" || f === "pilot-release.yml") expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/secrets\./);
    });
});

describe("ci.yml", () => {
  const wf = load("ci.yml");

  it("runs on pull requests and pushes to main, cancels stale runs, and can be called by release", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["pull_request", "push", "workflow_call", "workflow_dispatch"]);
    expect(wf.on["push"]).toEqual({ branches: ["main"] });
    expect(wf.concurrency!["cancel-in-progress"]).toBe(true);
  });

  it("tests on all three OSes with node 22 and pnpm from packageManager", () => {
    const t = wf.jobs["test"]!;
    expect(t.strategy!.matrix!["os"]).toEqual(["ubuntu-latest", "windows-latest", "macos-latest"]);
    expect(steps(t).find((s) => s.name === "Audit shipped dependencies")?.run).toBe("pnpm audit --prod --audit-level high");
    const pnpm = steps(t).find((s) => s.uses === "pnpm/action-setup@v4")!;
    expect(pnpm.with?.["version"]).toBeUndefined();
    expect(steps(t).find((s) => s.uses === "actions/setup-node@v4")!.with).toEqual({ "node-version": 22, cache: "pnpm" });
    const r = runs(t);
    expect(r).toContain("pnpm install --frozen-lockfile");
    expect(r).toContain("pnpm typecheck");
    expect(r).toContain("pnpm gates --only 1");
    expect(r).toContain("pnpm gates --only 2,3,4,5");
    const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string; scripts?: Record<string, string> };
    expect(pkgJson.packageManager).toMatch(/^pnpm@/);
    expect(pkgJson.scripts?.["gates"]).toBe("pnpm --filter @oneseat/testkit run gates");
  });

  it("wires gates 1 to 6 on every pull request", () => {
    const all = Object.values(wf.jobs).map(runs).join("\n");
    for (const g of ["--only 1", "--only 2,3,4,5", "--only 6"]) expect(all).toContain(`pnpm gates ${g}`);
    const e2e = wf.jobs["e2e"]!;
    expect(e2e.strategy!.matrix!["os"]).toEqual(["ubuntu-latest", "windows-latest", "macos-latest"]);
    expect(runs(e2e)).toContain("playwright install --with-deps");
    const gates = wf.jobs["gates"]!;
    expect(gates.needs).toEqual(["test", "rust", "desktop-build", "e2e", "cloud-db"]);
    // The cloud store is tested on a real Postgres service, on Linux.
    expect(wf.jobs["cloud-db"]!.env?.["ONESEAT_TEST_PG_URL"]).toMatch(/^postgres:\/\//);
    expect(gates.if).toBe("${{ always() }}");
  });

  it("builds and tests the Rust core with the Tauri Linux deps and caches", () => {
    const rust = wf.jobs["rust"]!;
    expect(rust["runs-on"]).toBe("ubuntu-latest");
    for (const dep of ["libwebkit2gtk-4.1-dev", "libgtk-3-dev", "librsvg2-dev", "libayatana-appindicator3-dev", "libsecret-1-dev"]) expect(runs(rust)).toContain(dep);
    expect(steps(rust).some((s) => s.uses === "dtolnay/rust-toolchain@stable")).toBe(true);
    expect(steps(rust).some((s) => s.uses === "Swatinem/rust-cache@v2")).toBe(true);
    const cargo = steps(rust).find((s) => s.run === "cargo test")!;
    expect(cargo["working-directory"]).toBe("apps/desktop/src-tauri");
    expect(runs(rust)).toContain("pnpm --filter @oneseat/daemon run build:sidecar");
  });

  it("builds the desktop app unsigned on Windows and macOS", () => {
    const b = wf.jobs["desktop-build"]!;
    expect(b.strategy!.matrix!["os"]).toEqual(["windows-latest", "macos-latest"]);
    expect(runs(b)).toContain("pnpm --filter @oneseat/daemon run build:sidecar");
    expect(runs(b)).toMatch(/pnpm --filter @oneseat\/desktop tauri build --ci/);
    expect(JSON.stringify(b)).not.toMatch(/APPLE_|WINDOWS_CERTIFICATE|TAURI_SIGNING/);
  });
});

describe("nightly-live.yml", () => {
  const wf = load("nightly-live.yml");
  const job = wf.jobs["live"]!;
  it("runs daily with the three provider keys, live and recording", () => {
    expect((wf.on["schedule"] as { cron: string }[])[0]!.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(job.env).toMatchObject({ ONESEAT_LIVE: "1", ONESEAT_RECORD: "1", ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}", OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}", GEMINI_API_KEY: "${{ secrets.GEMINI_API_KEY }}" });
  });
  it("skips providers with empty keys, runs gateway live tests and live evals, uploads artifacts without committing", () => {
    const r = runs(job);
    expect(r).toMatch(/skipped: its API key secret is empty/);
    expect(r).toContain("pnpm --filter @oneseat/gateway test");
    expect(r).toMatch(/oneseat-evals\.js --live (--concurrency \d+ )?--providers/);
    // Evals share the keys with live QA, so they run after it, not beside it.
    expect(job.needs).toBe("qa");
    expect(r).not.toMatch(/git (commit|push)/);
    const uploads = steps(job).filter((s) => s.uses === "actions/upload-artifact@v4").map((s) => String(s.with?.["path"]));
    expect(uploads.join()).toContain("eval-report/");
    expect(uploads.join()).toContain("packages/gateway/");
  });
});

describe("nightly-live.yml live QA", () => {
  const qa = load("nightly-live.yml").jobs["qa"]!;
  it("runs the shipped daemon on Windows, macOS and Linux, finding each OS's sidecars", () => {
    expect(qa.strategy?.matrix?.["os"]).toBe(`\${{ fromJSON(inputs.os == 'linux' && '["ubuntu-latest"]' || '["ubuntu-latest","windows-latest","macos-latest"]') }}`);
    expect(qa["runs-on"]).toBe("${{ matrix.os }}");
    const r = runs(qa);
    expect(r).toContain('ls "$bin"/oneseat-daemon-*');
    expect(r).toContain('ls "$bin"/deno-*');
    expect(r).toContain("free-tier quota is kept for the Linux run");
    expect(r).toContain('--repeat "$QA_REPEAT"');
    // Regression: QA_REPEAT once landed on another job's step, so --repeat got "" and QA exited 2.
    const qaStep = steps(qa).find((s) => s.name === "Live QA")!;
    expect(qaStep.env?.["QA_REPEAT"]).toBe("${{ github.event_name == 'schedule' && '1' || '3' }}");
    // Run on demand: one of the two jobs alone (inputs.jobs), or both.
    expect(qa.if).toContain("inputs.jobs != 'evals'");
    expect(load("nightly-live.yml").jobs["live"]!.if).toContain("inputs.jobs != 'qa'");
    // A manual run can name scenarios; the input reaches the script only through QA_ONLY.
    expect(qaStep.env?.["QA_ONLY"]).toBe("${{ inputs.scenarios }}");
    expect(r).toContain('only=(--only "$QA_ONLY")');
    expect(r).not.toContain("inputs.scenarios");
  });
});

describe("release.yml", () => {
  const wf = load("release.yml");
  it("runs on v* tags after gates 1-6", () => {
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
    expect(wf.jobs["gates"]!.uses).toBe("./.github/workflows/ci.yml");
    expect(wf.jobs["build"]!.needs).toBe("gates");
    expect(wf.jobs["build"]!.permissions).toEqual({ contents: "write" });
  });
  it("builds the sidecar, then signed Windows and universal macOS installers into a draft release", () => {
    const b = wf.jobs["build"]!;
    const matrix = (b.strategy!.matrix!["include"] as { os: string; "tauri-args": string }[]).map((m) => [m.os, m["tauri-args"]]);
    expect(matrix).toEqual([["windows-latest", "--bundles msi,nsis"], ["macos-latest", "--target universal-apple-darwin --bundles dmg"]]);
    const all = steps(b);
    const sidecar = all.findIndex((s) => (s.run ?? "").includes("pnpm --filter @oneseat/daemon run build:sidecar"));
    const tauri = all.findIndex((s) => s.uses === "tauri-apps/tauri-action@v0");
    expect(sidecar).toBeGreaterThan(-1);
    expect(tauri).toBeGreaterThan(sidecar);
    expect(runs(b)).toContain("lipo -create -output oneseat-daemon-universal-apple-darwin");
    const action = all[tauri]!;
    expect(action.with).toMatchObject({ projectPath: "apps/desktop", releaseDraft: true, tagName: "${{ github.ref_name }}" });
    for (const s of ["TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"])
      expect(action.env?.[s]).toBe(`\${{ secrets.${s} }}`);
    const win = all.find((s) => s.name === "Import Windows signing certificate")!;
    expect(win.env).toEqual({ WINDOWS_CERTIFICATE: "${{ secrets.WINDOWS_CERTIFICATE }}", WINDOWS_CERTIFICATE_PASSWORD: "${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}" });
    expect(win.run).toMatch(/certificateThumbprint/);
  });
});

describe("pilot-release.yml", () => {
  const wf = load("pilot-release.yml");
  const job = wf.jobs["publish"]!;
  it("runs from the pilot-release label or by hand, with write access only in the publishing job", () => {
    expect(wf.on).toEqual({ workflow_dispatch: null, pull_request: { types: ["labeled"] } });
    expect(job.if).toContain("github.event.label.name == 'pilot-release'");
    expect(job.permissions).toEqual({ contents: "write", actions: "read" });
  });
  it("publishes the installers CI built and tested, never a rebuild, under fixed names", () => {
    const r = runs(job);
    expect(r).toContain("--workflow ci.yml --commit \"$SHA\" --status success");
    expect(r).toContain("-n unsigned-windows-latest");
    expect(r).toContain("-n unsigned-macos-latest");
    expect(r).toContain("dist/OneSeat-Windows-x64-setup.exe");
    expect(r).toContain("dist/OneSeat-macOS-AppleSilicon.dmg");
    expect(r).toContain("gh release create pilot");
    expect(r).not.toMatch(/tauri build|build:sidecar/);
  });
});
