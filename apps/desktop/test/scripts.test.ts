import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { checkApp, defaultBundles, exportConfig, pngFromIcon, productName } from "../scripts/export-app.mjs";
import { signingConfig } from "../scripts/signing-config.mjs";
import { drawIcon, encodePng } from "../scripts/make-icon.mjs";
import { checkReport, findReport } from "../scripts/native-smoke.mjs";

const app = { id: "invoice-tracker", name: "Invoice tracker", version: "1.2.3-beta.1", window: { width: 640, height: 480 }, allowedSkills: ["invoice-chaser"] };

describe("export-app", () => {
  it("builds a single-app Tauri config override", () => {
    const c = exportConfig(app, { appDir: "/data/exports/invoice-tracker", bundles: ["msi", "nsis"] });
    expect(c.productName).toBe("Invoice tracker");
    expect(c.version).toBe("1.2.3");
    expect(c.identifier).toBe("app.oneseat.pinned.invoice-tracker");
    expect(c.mainBinaryName).toBe("oneseat-invoice-tracker");
    expect(c.bundle.targets).toEqual(["msi", "nsis"]);
    expect(Object.values(c.bundle.resources).sort()).toEqual(["pinned/app.json", "pinned/index.html"]);
    expect(Object.keys(c.bundle.resources).every((k: string) => k.startsWith(resolve("/data/exports/invoice-tracker")))).toBe(true);
    expect(c.bundle.icon).toBeUndefined();
    const withIcons = exportConfig(app, { appDir: "/d", bundles: [], icons: ["/d/icons/icon.ico"] });
    expect(withIcons.bundle.icon).toEqual(["/d/icons/icon.ico"]);
    expect(withIcons.bundle.targets).toBeUndefined();
  });

  it("checks app.json and names", () => {
    expect(checkApp(app)).toEqual([]);
    expect(checkApp(null)).toHaveLength(1);
    expect(checkApp({ id: "Bad", name: "", version: "x" })).toHaveLength(4);
    expect(productName('A/B:"C"  D')).toBe("ABC D");
    expect(productName("   ")).toBe("OneSeat App");
    expect(defaultBundles("win32")).toEqual(["msi", "nsis"]);
    expect(defaultBundles("darwin")).toEqual(["dmg", "app"]);
    expect(defaultBundles("linux")).toEqual([]);
    expect(pngFromIcon("data:image/png;base64,iVBORw0K")?.[0]).toBe(0x89);
    expect(pngFromIcon("🧾")).toBeNull();
    expect(pngFromIcon("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
  });
});

describe("signing-config", () => {
  it("maps env to config without secrets", () => {
    expect(signingConfig({})).toEqual({});
    const c = signingConfig({
      WINDOWS_CERTIFICATE_THUMBPRINT: "AB CD".replace(" ", "") + "0".repeat(36),
      APPLE_SIGNING_IDENTITY: "Developer ID Application: OneSeat (TEAMID)",
      TAURI_SIGNING_PRIVATE_KEY: "secret-key-material",
      APPLE_PASSWORD: "app-specific-password",
    });
    expect(c.bundle!.windows.certificateThumbprint).toHaveLength(40);
    expect(c.bundle!.macOS.signingIdentity).toMatch(/Developer ID/);
    expect(c.bundle!.createUpdaterArtifacts).toBe(true);
    expect(JSON.stringify(c)).not.toMatch(/secret-key-material|app-specific-password/);
    expect(() => signingConfig({ WINDOWS_CERTIFICATE_THUMBPRINT: "nothex" })).toThrow();
  });
});

describe("make-icon", () => {
  it("writes a valid PNG", () => {
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    const icon = drawIcon(64);
    expect(icon.readUInt32BE(16)).toBe(64);
    expect(icon.readUInt32BE(20)).toBe(64);
  });
});

describe("native-smoke", () => {
  const good = {
    surface: ["run"],
    frozen: true,
    daemonCall: "denied",
    appsRunDirect: "denied",
    keyStatus: "denied",
    keySave: "denied",
    pinOpen: "denied",
    eventListen: "denied",
    opener: "denied",
    windowCreate: "denied",
    fetchRemote: "blocked",
    fetchLocal: "blocked",
    notAllowedSkill: "refused",
  };

  it("finds the probe report in shell output and checks it", () => {
    const line = `[INFO][oneseat::daemon] [fake-daemon] apps.run app=probe skill=invoice-chaser input=${JSON.stringify({ probeReport: good })}`;
    expect(findReport(`[INFO][oneseat::daemon] daemon Running\n${line}\n`)).toEqual(good);
    expect(findReport("nothing here")).toBeNull();
    expect(checkReport(good)).toEqual([]);
    const bad = { ...good, surface: ["run", "invoke"], daemonCall: "ALLOWED", fetchRemote: "ALLOWED", notAllowedSkill: "ALLOWED" };
    expect(checkReport(bad)).toHaveLength(4);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appPaths, checkFirstRun } from "../scripts/install-smoke.mjs";

describe("install-smoke", () => {
  it("knows where the installed app keeps data and logs", () => {
    expect(appPaths("win32", { APPDATA: "C:\\A", LOCALAPPDATA: "C:\\L" }, "C:\\Users\\u")).toEqual({
      data: join("C:\\A", "app.oneseat"),
      log: join("C:\\L", "app.oneseat", "logs", "oneseat.log"),
    });
    expect(appPaths("darwin", {}, "/Users/u")).toEqual({
      data: join("/Users/u", "Library", "Application Support", "app.oneseat"),
      log: join("/Users/u", "Library", "Logs", "app.oneseat", "oneseat.log"),
    });
  });

  it("accepts a healthy first run and names what is missing otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "os-smoke-"));
    const ok = "[oneseat info] daemon ready (deno found)\n[INFO] daemon Running (restarts: 0)\n";
    expect(checkFirstRun(dir, ok)).toEqual(expect.arrayContaining(["starter skill customers was not installed", "oneseat.db missing (harness did not open its database)"]));
    for (const s of ["brand-kit", "customers", "outreach", "proposals-invoices", "social-posts", "support-inbox", "weekly-report"]) {
      mkdirSync(join(dir, "skills", s), { recursive: true });
      writeFileSync(join(dir, "skills", s, "SKILL.md"), "x");
    }
    writeFileSync(join(dir, "skills.lock.json"), "{}");
    writeFileSync(join(dir, "oneseat.db"), "");
    expect(checkFirstRun(dir, ok)).toEqual([]);
    expect(checkFirstRun(dir, "daemon ready (deno missing)\ndaemon Running")).toHaveLength(1);
    expect(checkFirstRun(dir, ok + "thread 'main' panicked at")).toHaveLength(1);
  });
});
