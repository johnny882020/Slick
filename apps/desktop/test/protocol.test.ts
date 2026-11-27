import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PINNED_APP_CSP } from "@oneseat/contracts";
import { describe, expect, it } from "vitest";
import * as dev from "../dev/protocol.mjs";
import { COMMANDS, SHELL_ONLY_METHODS, UI_METHODS, isUiMethod } from "../src/protocol";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Method names in `interface DaemonMethods` (harness.ts). */
function contractMethods(): string[] {
  const src = read("../../../packages/contracts/src/harness.ts");
  const body = src.slice(src.indexOf("export interface DaemonMethods {"));
  return [...body.slice(0, body.indexOf("\n}")).matchAll(/^\s*"([a-z]+\.[a-zA-Z]+)"\s*:/gm)].map((m) => m[1]!).sort();
}

/** A Rust `&[&str]` constant's strings. */
function rustList(src: string, name: string): string[] {
  const start = src.indexOf(`pub const ${name}: &[&str] = &[`);
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("];", start));
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("protocol surface", () => {
  it("UI allowlist + shell-only methods = DaemonMethods", () => {
    expect([...UI_METHODS, ...SHELL_ONLY_METHODS].sort()).toEqual(contractMethods());
    expect(isUiMethod("apps.run")).toBe(false);
    expect(isUiMethod("auth.set")).toBe(false);
    expect(isUiMethod("harness.run")).toBe(true);
  });

  it("the UI, the dev bridge and the Rust core use the same allowlist", () => {
    expect(dev.UI_METHODS).toEqual([...UI_METHODS]);
    expect(dev.SHELL_ONLY_METHODS).toEqual([...SHELL_ONLY_METHODS]);
    const rust = read("../src-tauri/src/allowlist.rs");
    expect(rustList(rust, "UI_METHODS")).toEqual([...UI_METHODS]);
    expect(rustList(rust, "SHELL_ONLY_METHODS")).toEqual([...SHELL_ONLY_METHODS]);
  });

  it("every shell command is declared in build.rs and granted by a capability", () => {
    const build = read("../src-tauri/build.rs");
    const declared = rustList(build, "COMMANDS");
    expect(declared.sort()).toEqual([...COMMANDS, "bridge_run"].sort());
    const main = JSON.parse(read("../src-tauri/capabilities/main.json")) as { windows: string[]; permissions: string[] };
    const pinned = JSON.parse(read("../src-tauri/capabilities/pinned-apps.json")) as { windows: string[]; permissions: string[] };
    expect(main.windows).toEqual(["main"]);
    expect(pinned.windows).toEqual(["app-*"]);
    // Pinned windows get exactly one permission: bridge_run.
    expect(pinned.permissions).toEqual(["allow-bridge-run"]);
    // Main gets every command but bridge_run.
    const perm = (c: string) => `allow-${c.replace(/_/g, "-")}`;
    expect(main.permissions.filter((p) => p.startsWith("allow-")).sort()).toEqual(COMMANDS.map(perm).sort());
    expect(main.permissions).not.toContain("allow-bridge-run");
  });

  it("the dev bridge reads the same pinned-app CSP as contracts", () => {
    expect(dev.readPinnedCsp()).toBe(PINNED_APP_CSP);
    expect(read("../src-tauri/src/pinned.rs")).toContain(`pub const PINNED_APP_CSP: &str = "${PINNED_APP_CSP}";`);
  });

  it("tauri.conf.json: identity, bundles, sidecar, no secrets", () => {
    const conf = JSON.parse(read("../src-tauri/tauri.conf.json"));
    expect(conf.identifier).toBe("app.oneseat");
    expect(conf.productName).toBe("OneSeat");
    expect(conf.bundle.targets).toEqual(["msi", "nsis", "dmg", "app"]);
    expect(conf.bundle.externalBin).toEqual(["binaries/oneseat-daemon", "binaries/deno"]);
    expect(conf.bundle.resources).toEqual({ "../../../skills/": "skills/" });
    expect(conf.bundle.windows.certificateThumbprint).toBeNull();
    expect(conf.bundle.macOS.signingIdentity).toBeNull();
    expect(conf.app.security.capabilities).toEqual(["main", "pinned-apps"]);
    expect(conf.app.security.csp).toContain("default-src 'self'");
    expect(conf.app.security.csp).not.toContain("unsafe-eval");
    expect(JSON.stringify(conf)).not.toMatch(/PRIVATE KEY|sk-|password/i);
  });
});
