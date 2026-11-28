import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SkillPermissionsFile } from "@oneseat/contracts";
import { findDeno, pathForms, resolvePermissionPath, SandboxError, ScriptSandbox } from "../src/sandbox.js";
import { approveAll, collect, denyAll, MemorySkillStore, ofType, setup, task, tmpDir, writeSkill } from "./helpers.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const DENO = findDeno({ env: {}, from: [PKG] });

// One probe script: each action tries one thing and reports ok or the error name.
const PROBE = `
const [action, arg] = Deno.args;
async function run() {
  switch (action) {
    case "read": return Deno.readTextFileSync(arg);
    case "write": Deno.writeTextFileSync(arg, "written"); return "wrote";
    case "env": return String(Deno.env.get(arg));
    case "fetch": await fetch(arg); return "fetched";
    case "import": await import(arg); return "imported";
    case "run": { const c = new Deno.Command(arg, { args: ["--version"] }); await c.output(); return "ran"; }
    case "stdin": return (await new Response(Deno.stdin.readable).text()).toUpperCase();
    case "loop": for (;;) {}
    case "spam": for (let i = 0; i < 20000; i++) console.log("x".repeat(100)); return "spammed";
    case "exit": Deno.exit(7);
    case "cwd": return Deno.cwd();
  }
  return "unknown action";
}
try {
  console.log(JSON.stringify({ ok: true, value: await run() }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, name: e.name, message: e.message }));
}
`;

function makeSkill(oneseat: SkillPermissionsFile, name = "probe", rootDir?: string) {
  const root = rootDir ?? tmpDir();
  const dir = writeSkill(root, {
    name,
    description: "Probe the sandbox.",
    oneseat: { ...oneseat, scripts: { probe: { file: "scripts/probe.ts", description: "Probe" }, ...(oneseat.scripts ?? {}) } },
    files: { "scripts/probe.ts": PROBE, "data/info.txt": "skill data" },
  });
  const store = new MemorySkillStore();
  const skill = store.addDir(dir);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "in.txt"), "workspace data");
  const secretDir = join(root, "private");
  mkdirSync(secretDir);
  writeFileSync(join(secretDir, "oneseat.db"), "db bytes");
  const sandbox = new ScriptSandbox({
    denoPath: DENO!,
    workspaceDir: workspace,
    cacheDir: join(root, "deno-cache"),
    env: { GREETING: "hello", HOME: "/home/someone", PATH: process.env["PATH"] ?? "" },
    denyPaths: [join(secretDir, "oneseat.db")],
  });
  const probe = async (...args: string[]) => {
    const r = await sandbox.run({ manifest: skill.manifest, script: "probe", args });
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split("\n").pop()!) as { ok: boolean; value?: string; name?: string; message?: string };
  };
  return { root, dir, store, skill, workspace, sandbox, probe, secretDb: join(secretDir, "oneseat.db") };
}

describe("findDeno", () => {
  it("prefers ONESEAT_DENO, then PATH, then node_modules", () => {
    const dir = tmpDir();
    const fake = join(dir, process.platform === "win32" ? "deno.exe" : "deno");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    expect(findDeno({ env: { ONESEAT_DENO: fake } })).toBe(fake);
    expect(findDeno({ env: { ONESEAT_DENO: join(dir, "missing") } })).toBeUndefined();
    expect(findDeno({ env: { PATH: `${join(dir, "nothing")}${process.platform === "win32" ? ";" : ":"}${dir}` }, from: [] })).toBe(fake);
    expect(findDeno({ env: {}, from: [tmpDir()] })).toBeUndefined();
    // A relative PATH entry is never used, even when it holds a deno binary.
    expect(findDeno({ env: { PATH: relative(process.cwd(), dir) }, from: [] })).toBeUndefined();
    expect(DENO).toBeDefined();
    expect(DENO!.includes(`${sep}.bin${sep}`)).toBe(false);
  });
});

describe("resolvePermissionPath", () => {
  const roots = { skill: "/s/skill", workspace: "/w" };
  it("resolves roots and refuses escapes", () => {
    expect(resolvePermissionPath("data", roots, "read")).toBe(join("/s/skill", "data"));
    expect(resolvePermissionPath("$SKILL/data/x.txt", roots, "read")).toBe(join("/s/skill", "data", "x.txt"));
    expect(resolvePermissionPath("$WORKSPACE", roots, "read")).toBe("/w");
    expect(resolvePermissionPath("$workspace/out/", roots, "write")).toBe(join("/w", "out"));
    expect(() => resolvePermissionPath("$HOME/x", roots, "read")).toThrow('unknown root "$HOME"');
    expect(() => resolvePermissionPath("$WORKSPACEX", roots, "read")).toThrow("unknown root");
    expect(() => resolvePermissionPath("$WORKSPACE../x", roots, "read")).toThrow("invalid read path");
    expect(() => resolvePermissionPath("/etc", roots, "read")).toThrow("must be relative");
    expect(() => resolvePermissionPath("C:\\x", roots, "read")).toThrow("must be relative");
    expect(() => resolvePermissionPath("~/.ssh", roots, "read")).toThrow("must be relative");
    expect(() => resolvePermissionPath("$WORKSPACE/../x", roots, "read")).toThrow('must not contain ".."');
    expect(() => resolvePermissionPath("", roots, "read")).toThrow("empty");
    expect(() => resolvePermissionPath("data", roots, "write")).toThrow("must be under $WORKSPACE");
    expect(() => resolvePermissionPath("$SKILL", roots, "write")).toThrow("must be under $WORKSPACE");
  });
});

describe.skipIf(!DENO)("ScriptSandbox (Deno)", () => {
  it("builds deny-by-default flags from the declared permissions", () => {
    const none = makeSkill({});
    const plan = none.sandbox.plan({ manifest: none.skill.manifest, script: "probe", args: ["x"] });
    const skillReal = plan.cwd;
    expect(plan.command).toBe(DENO);
    expect(plan.args.slice(0, 7)).toEqual(["run", "--quiet", "--no-prompt", "--no-config", "--no-lock", "--no-npm", "--no-remote"]);
    // Only the skill folder (in its real and as-given forms) is readable.
    const readFlag = plan.args.find((a) => a.startsWith("--allow-read="))!;
    const readList = readFlag.slice("--allow-read=".length).split(",");
    expect(readList).toContain(skillReal);
    for (const r of readList) expect(pathForms(r).some((f) => pathForms(skillReal).includes(f))).toBe(true);
    for (const f of ["--allow-net", "--allow-write", "--allow-env", "--allow-run", "--allow-import", "--allow-all", "-A"])
      expect(plan.args.some((a) => a.startsWith(f))).toBe(false);
    expect(plan.args).toContain("--deny-ffi");
    expect(plan.args.at(-1)).toBe("x");
    expect(plan.args.at(-2)).toBe(join(skillReal, "scripts", "probe.ts"));
    // Windows processes need SystemRoot; nothing else from the parent environment passes.
    const base = ["DENO_DIR", "DENO_NO_UPDATE_CHECK", "NO_COLOR", ...(process.platform === "win32" && process.env["SystemRoot"] ? ["SystemRoot"] : [])];
    expect(Object.keys(plan.env).sort()).toEqual(base.sort());

    const full = makeSkill({
      permissions: { net: ["api.example.com", "registry.npmjs.org"], read: ["$WORKSPACE/in.txt"], write: ["$WORKSPACE/out"], env: ["GREETING"], run: ["git"] },
      reasons: { "api.example.com": "x", "registry.npmjs.org": "y" },
    });
    const p2 = full.sandbox.plan({ manifest: full.skill.manifest, script: "probe" });
    expect(p2.args).toContain("--allow-net=api.example.com,registry.npmjs.org");
    expect(p2.args).toContain("--allow-import=api.example.com,registry.npmjs.org");
    expect(p2.args).not.toContain("--no-remote");
    expect(p2.args).not.toContain("--no-npm");
    expect(p2.args).toContain(`--allow-env=GREETING`);
    expect(p2.args).toContain(`--allow-run=git`);
    expect(p2.args.find((a) => a.startsWith("--allow-write="))).toMatch(/workspace[/\\]out$/);
    expect(p2.args.find((a) => a.startsWith("--deny-read="))).toContain("oneseat.db");
    expect(p2.env["GREETING"]).toBe("hello");
    expect(p2.env["HOME"]).toBeUndefined();
    expect(p2.env["PATH"]).toBeDefined();
  });

  it("refuses bad declarations", () => {
    const bad = (oneseat: SkillPermissionsFile) => {
      const s = makeSkill(oneseat);
      return () => s.sandbox.plan({ manifest: s.skill.manifest, script: "probe" });
    };
    expect(bad({ permissions: { net: ["*"] }, reasons: { "*": "x" } })).toThrow('invalid network host "*"');
    expect(bad({ permissions: { env: ["OPENAI_API_KEY"] } })).toThrow("looks like a secret");
    expect(bad({ permissions: { env: ["BAD-NAME"] } })).toThrow("invalid env name");
    expect(bad({ permissions: { run: ["rm -rf"] } })).toThrow("invalid executable");
    expect(bad({ permissions: { read: ["/etc"] } })).toThrow("must be relative");
    expect(bad({ permissions: { write: ["out"] } })).toThrow("must be under $WORKSPACE");
    expect(bad({ scripts: { ghost: { file: "nope.ts", description: "x" } } })).not.toThrow();
    const s = makeSkill({ scripts: { ghost: { file: "nope.ts", description: "x" }, esc: { file: "../x.ts", description: "x" } } });
    expect(() => s.sandbox.plan({ manifest: s.skill.manifest, script: "ghost" })).toThrow("not found in the skill folder");
    expect(() => s.sandbox.plan({ manifest: s.skill.manifest, script: "esc" })).toThrow('must not contain ".."');
    expect(() => s.sandbox.plan({ manifest: s.skill.manifest, script: "missing" })).toThrow('declares no script "missing" (scripts: probe, ghost, esc)');
    expect(() => s.sandbox.plan({ manifest: { ...s.skill.manifest, dir: "" }, script: "probe" })).toThrow("no folder on disk");
    const noDeno = new ScriptSandbox({ denoPath: undefined as unknown as string, workspaceDir: tmpDir(), cacheDir: tmpDir() });
    Object.defineProperty(noDeno, "denoPath", { value: undefined });
    expect(noDeno.available).toBe(false);
    expect(() => noDeno.plan({ manifest: s.skill.manifest, script: "probe" })).toThrow(SandboxError);
  });

  it("denies undeclared file, env, network, import and process access", async () => {
    const { probe, dir, workspace, secretDb } = makeSkill({});
    expect(await probe("read", join(dir, "data", "info.txt"))).toEqual({ ok: true, value: "skill data" });
    expect(await probe("cwd")).toMatchObject({ ok: true });
    const denied = async (...a: string[]) => {
      const r = await probe(...a);
      expect(r.ok, `${a.join(" ")} should fail`).toBe(false);
      return r;
    };
    expect((await denied("read", join(workspace, "in.txt"))).message).toContain("Requires read access");
    expect((await denied("read", "/etc/hostname")).name).toBe("NotCapable");
    expect((await denied("read", secretDb)).message).toContain("Requires read access");
    expect((await denied("write", join(workspace, "x.txt"))).message).toContain("Requires write access");
    expect((await denied("write", join(dir, "data", "info.txt"))).message).toContain("Requires write access");
    expect((await denied("env", "HOME")).message).toContain("Requires env access");
    expect((await denied("fetch", "https://example.com/")).message).toContain("Requires net access");
    expect((await denied("import", "https://esm.sh/zod")).message).toContain("--no-remote");
    expect((await denied("import", "npm:zod")).message).toMatch(/npm|not.*supported|--no-npm/i);
    expect((await denied("run", process.execPath)).message).toContain("Requires run access");
    expect(existsSync(join(workspace, "x.txt"))).toBe(false);
  });

  it("grants exactly what is declared", async () => {
    const { probe, workspace } = makeSkill({
      permissions: { net: ["api.example.com"], read: ["$WORKSPACE/in.txt"], write: ["$WORKSPACE/out"], env: ["GREETING", "UNSET_VAR"] },
      reasons: { "api.example.com": "API" },
    });
    expect(await probe("read", join(workspace, "in.txt"))).toEqual({ ok: true, value: "workspace data" });
    mkdirSync(join(workspace, "out"));
    expect(await probe("write", join(workspace, "out", "r.txt"))).toEqual({ ok: true, value: "wrote" });
    expect(readFileSync(join(workspace, "out", "r.txt"), "utf8")).toBe("written");
    expect((await probe("write", join(workspace, "elsewhere.txt"))).ok).toBe(false);
    expect(await probe("env", "GREETING")).toEqual({ ok: true, value: "hello" });
    expect(await probe("env", "UNSET_VAR")).toEqual({ ok: true, value: "undefined" });
    expect((await probe("env", "HOME")).ok).toBe(false);
    // A declared host passes the permission check; others do not.
    expect((await probe("fetch", "https://other.example.org/")).message).toContain("Requires net access");
    expect((await probe("import", "https://esm.sh/zod")).message).toContain("Requires import access");
  });

  it("passes stdin, reports exit codes, caps output, and enforces the timeout and abort", async () => {
    const { sandbox, skill } = makeSkill({});
    const m = skill.manifest;
    const echo = await sandbox.run({ manifest: m, script: "probe", args: ["stdin"], stdin: "abc" });
    expect(JSON.parse(echo.stdout)).toEqual({ ok: true, value: "ABC" });
    const exit = await sandbox.run({ manifest: m, script: "probe", args: ["exit"] });
    expect(exit.exitCode).toBe(7);
    const capped = new ScriptSandbox({ denoPath: DENO!, workspaceDir: tmpDir(), cacheDir: tmpDir(), outputCap: 1000 });
    const spam = await capped.run({ manifest: m, script: "probe", args: ["spam"] });
    expect(spam.truncated).toBe(true);
    expect(spam.stdout.length).toBe(1000);
    const t0 = Date.now();
    const loop = await sandbox.run({ manifest: m, script: "probe", args: ["loop"], timeoutMs: 700 });
    expect(loop.timedOut).toBe(true);
    expect(loop.exitCode).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    const ac = new AbortController();
    const p = sandbox.run({ manifest: m, script: "probe", args: ["loop"], signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    const aborted = await p;
    expect(aborted.aborted).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect((await sandbox.run({ manifest: m, script: "probe", args: ["cwd"], signal: pre.signal })).aborted).toBe(true);
    const broken = new ScriptSandbox({ denoPath: join(tmpDir(), "no-deno"), workspaceDir: tmpDir(), cacheDir: tmpDir() });
    await expect(broken.run({ manifest: m, script: "probe" })).rejects.toThrow("could not start Deno");
  });

  it("runs skill scripts from the harness, asking first when the skill can send", async () => {
    // A skill that can really send: it declares a mail API host for its scripts.
    const s = makeSkill({ effects: ["send"], permissions: { net: ["api.mail.test"] }, reasons: { "api.mail.test": "Sends the email." } }, "mailer");
    const script = [
      { steps: [{ tool: "load_skill", input: { name: "mailer" } }] },
      { steps: [{ tool: "run_skill_script", input: { skill: "mailer", script: "probe", args: ["stdin"], input: "hi" } }] },
      { steps: [{ tool: "run_skill_script", input: { skill: "mailer", script: "probe", args: ["exit"] } }] },
      { steps: [{ text: "done" }] },
    ];
    const ok = setup(script, { store: s.store, sandbox: s.sandbox });
    const events = await collect(ok.harness.run(task("mail"), approveAll));
    const reqs = ofType(events, "approval_request");
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.effects).toEqual(["network", "send"]);
    expect(reqs[0]!.summary).toBe('Run script "probe" of skill mailer - Probe with stdin (can send)');
    const ends = ofType(events, "tool_end");
    expect(JSON.parse(ends[1]!.result.content)).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(JSON.parse(ends[1]!.result.content).stdout)).toEqual({ ok: true, value: "HI" });
    expect(ends[2]!.result.isError).toBe(true);

    const denied = setup(script.slice(0, 2).concat([{ steps: [{ text: "ok" }] }]), { store: s.store, sandbox: s.sandbox });
    const ev2 = await collect(denied.harness.run(task("mail"), denyAll("no")));
    expect(ofType(ev2, "tool_end")[1]!.result.content).toContain("The person declined");
  });

  it("runs a script with no network, write or program access without asking, even in a sending skill", async () => {
    // Like proposals-invoices: the skill sends through a connected tool; its totals script only computes.
    const s = makeSkill({ effects: ["send", "delete"] }, "invoicer");
    const script = [
      { steps: [{ tool: "load_skill", input: { name: "invoicer" } }] },
      { steps: [{ tool: "run_skill_script", input: { skill: "invoicer", script: "probe", args: ["stdin"], input: "total" } }] },
      { steps: [{ text: "done" }] },
    ];
    const r = setup(script, { store: s.store, sandbox: s.sandbox });
    const events = await collect(r.harness.run(task("invoice"), denyAll("should not be asked")));
    expect(ofType(events, "approval_request")).toHaveLength(0);
    expect(JSON.parse(JSON.parse(ofType(events, "tool_end")[1]!.result.content).stdout)).toEqual({ ok: true, value: "TOTAL" });
  });
});

describe("pathForms (symlinked folders, e.g. macOS /var -> /private/var)", () => {
  it("lists the logical and real form, including for paths that do not exist yet", async () => {
    const { mkdtempSync, symlinkSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // .native also expands Windows 8.3 short names (RUNNER~1), as pathForms does.
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "os-forms-")));
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    symlinkSync(real, link, "junction");
    expect(pathForms(join(link, "a", "b.txt"))).toEqual([join(link, "a", "b.txt"), join(real, "a", "b.txt")]);
    expect(pathForms(real)).toEqual([real]);
  });

  it.runIf(!!DENO)("lets a script read a declared file through a symlinked path", async () => {
    const { mkdtempSync, symlinkSync, realpathSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "os-link-")));
    const real = join(base, "real");
    mkdirSync(real);
    symlinkSync(real, join(base, "link"), "junction");
    const { probe, workspace } = makeSkill({ permissions: { read: ["$WORKSPACE/in.txt"] } }, "probe", join(base, "link"));
    writeFileSync(join(workspace, "in.txt"), "via link");
    expect(await probe("read", join(workspace, "in.txt"))).toEqual({ ok: true, value: "via link" });
  });
});
