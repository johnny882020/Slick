import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLint, formatScan, parseArgs, resolveSourceArg, runCli, type FetchLike } from "../src/index.js";
import { repoTarball } from "./helpers/tar.js";
import { FIXTURES, codeload, fakeFetch, fixture, skillMd, tempDir, writeTree } from "./helpers/util.js";

async function run(argv: string[], opts: { env?: Record<string, string>; cwd?: string; fetch?: FetchLike } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    cwd: opts.cwd ?? FIXTURES,
    env: opts.env ?? { HOME: "/nonexistent-home" },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("argument parsing", () => {
  it("parses commands and options", () => {
    expect(parseArgs(["install", "x", "--allow-warnings", "--json", "--data-dir", "/d"])).toEqual({
      command: "install",
      positional: ["x"],
      json: true,
      allowWarnings: true,
      dataDir: "/d",
      help: false,
    });
    expect(parseArgs(["list", "--data-dir=/e"]).dataDir).toBe("/e");
  });

  it("prints usage", async () => {
    expect((await run([])).code).toBe(2);
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("oneseat-skills <command>");
    expect((await run(["help"])).code).toBe(0);
  });

  it("rejects bad options and commands", async () => {
    expect((await run(["lint", "--nope"])).code).toBe(2);
    expect((await run(["list", "--data-dir"])).err).toContain("--data-dir needs a folder");
    expect((await run(["frobnicate"])).err).toContain('unknown command "frobnicate"');
    expect((await run(["lint"])).err).toContain("lint needs at least one path");
    expect((await run(["install"])).code).toBe(2);
    expect((await run(["remove"])).code).toBe(2);
    expect((await run(["scan"])).code).toBe(2);
    expect((await run(["check"])).code).toBe(2);
  });
});

describe("resolveSourceArg", () => {
  it("prefers local paths, then skills.sh / GitHub syntax", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, "acme", "kit"), { recursive: true });
    expect(await resolveSourceArg("acme/kit", cwd)).toEqual({ kind: "local", path: join(cwd, "acme", "kit") });
    expect(await resolveSourceArg("other/kit@one", cwd)).toEqual({ kind: "skills.sh", owner: "other", repo: "kit", skill: "one" });
    expect(await resolveSourceArg("./x", cwd)).toEqual({ kind: "local", path: join(cwd, "x") });
    expect(await resolveSourceArg("~/x", cwd, { HOME: "/home/me" })).toEqual({ kind: "local", path: "/home/me/x" });
    expect(await resolveSourceArg("https://github.com/o/r/tree/main/skills/a", cwd)).toEqual({ kind: "github", owner: "o", repo: "r", ref: "main", path: "skills/a" });
    expect(await resolveSourceArg("just-a-name", cwd)).toEqual({ kind: "local", path: join(cwd, "just-a-name") });
  });
});

describe("lint", () => {
  it("passes a clean skill and fails a bad one", async () => {
    const ok = await run(["lint", "clean-skill"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("clean-skill  lint ok");
    const bad = await run(["lint", "too-long", "chained-link"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("too-long  lint FAILED (1 error, 0 warnings)");
    expect(bad.out).toContain("chained-link  lint ok (0 errors, 1 warning)");
  });

  it("prints JSON", async () => {
    const r = await run(["lint", "multi-repo", "--json"]);
    const json = JSON.parse(r.out);
    expect(json.ok).toBe(true);
    expect(json.results.map((x: { skill: string }) => x.skill)).toEqual(["gamma", "delta", "alpha", "beta"]);
  });

  it("errors when a path holds no skills", async () => {
    const empty = await tempDir();
    const r = await run(["lint", empty]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/no SKILL.md found/);
    const j = await run(["lint", empty, "--json"]);
    expect(JSON.parse(j.out)).toEqual({ ok: false, error: { code: "no-skills", message: expect.stringContaining("no SKILL.md") } });
  });
});

describe("scan", () => {
  it("scans local sources", async () => {
    const ok = await run(["scan", "./declared-host"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("declared-host  scan PASS");
    expect(ok.out).toContain("(1 info finding not shown; use --json for all)");
    const bad = await run(["scan", fixture("shell-curl"), "--json"]);
    expect(bad.code).toBe(1);
    const json = JSON.parse(bad.out);
    expect(json.ok).toBe(false);
    expect(json.results[0].scan.verdict).toBe("block");
  });

  it("scans skills.sh sources through the injected fetch", async () => {
    const fetch = fakeFetch({ [codeload("acme", "kit")]: repoTarball({ "skills/alpha/SKILL.md": skillMd("alpha") }) });
    const r = await run(["scan", "acme/kit"], { fetch, cwd: await tempDir() });
    expect(r.code).toBe(0);
    expect(r.out).toContain("alpha  scan PASS");
  });

  it("reports unsafe archives as blocked", async () => {
    const fetch = fakeFetch({ [codeload("evil", "kit")]: repoTarball({ "SKILL.md": skillMd("kit") }, "kit-1", [{ name: "../x", body: "x" }]) });
    const r = await run(["scan", "evil/kit"], { fetch, cwd: await tempDir() });
    expect(r.code).toBe(1);
    expect(r.out).toContain("scan BLOCK");
    expect(r.out).toContain("path-traversal");
  });

  it("reports download failures", async () => {
    const r = await run(["scan", "acme/missing"], { fetch: fakeFetch({}), cwd: await tempDir() });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/HTTP 404/);
  });
});

describe("check (lint:skills)", () => {
  it("handles a missing or empty skills folder", async () => {
    const root = await tempDir();
    const missing = await run(["check", join(root, "skills")]);
    expect(missing.code).toBe(0);
    expect(missing.out).toContain("nothing to check");
    await mkdir(join(root, "skills"));
    const empty = await run(["check", join(root, "skills"), "--json"]);
    expect(JSON.parse(empty.out)).toEqual({ ok: true, notes: [expect.stringContaining("no skills in")], results: [] });
  });

  it("passes clean skills and fails on lint errors or blocks", async () => {
    const root = await writeTree(await tempDir(), { "skills/one/SKILL.md": skillMd("one"), "skills/two/SKILL.md": skillMd("two") });
    const ok = await run(["check", join(root, "skills")]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("2 skills checked: all passed gates 3 and 4");
    const all = await run(["check", FIXTURES]);
    expect(all.code).toBe(1);
    expect(all.out).toContain("FAILED");
  });
});

describe("install, list, verify, remove", () => {
  it("runs the whole lifecycle", async () => {
    const dataDir = join(await tempDir(), "data");
    const dd = ["--data-dir", dataDir];
    expect((await run(["list", ...dd])).out).toBe("no skills installed");
    expect((await run(["verify", ...dd])).out).toBe("no skills installed");
    const inst = await run(["install", "clean-skill", ...dd]);
    expect(inst.code).toBe(0);
    expect(inst.out).toContain("installed clean-skill@1.2.0");
    const list = await run(["list", ...dd]);
    expect(list.out).toMatch(/^clean-skill\s+1\.2\.0\s+\/.*clean-skill$/);
    const listJson = JSON.parse((await run(["list", "--json", ...dd])).out);
    expect(listJson[0].manifest.frontmatter.name).toBe("clean-skill");
    expect((await run(["verify", "clean-skill", ...dd])).out).toBe("clean-skill  ok");
    await appendFile(join(dataDir, "skills", "clean-skill", "SKILL.md"), "x");
    const tampered = await run(["verify", ...dd]);
    expect(tampered.code).toBe(1);
    expect(tampered.out).toContain("clean-skill  FAILED: files changed since install");
    expect((await run(["remove", "clean-skill", ...dd])).out).toBe("removed clean-skill");
    const again = await run(["remove", "clean-skill", ...dd]);
    expect(again.code).toBe(1);
    expect(again.out).toBe("clean-skill is not installed");
  });

  it("refuses blocked skills and needs --allow-warnings for warnings", async () => {
    const dataDir = join(await tempDir(), "data");
    const blocked = await run(["install", "undeclared-fetch", `--data-dir=${dataDir}`]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toMatch(/^not installed: blocked by the security scan/);
    expect((await run(["install", "chained-link", `--data-dir=${dataDir}`])).code).toBe(1);
    const allowed = await run(["install", "chained-link", "--allow-warnings", "--json", `--data-dir=${dataDir}`]);
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.out).installed).toBe(true);
  });

  it("uses ONESEAT_DATA_DIR and HOME for the default data folder", async () => {
    const dataDir = join(await tempDir(), "envdata");
    expect((await run(["install", "declared-host"], { env: { ONESEAT_DATA_DIR: dataDir } })).code).toBe(0);
    expect((await run(["list"], { env: { ONESEAT_DATA_DIR: dataDir } })).out).toContain("declared-host");
    const home = await tempDir();
    expect((await run(["install", "declared-host"], { env: { HOME: home } })).code).toBe(0);
    expect((await run(["list", "--data-dir", "~/.oneseat"], { env: { HOME: home } })).out).toContain("declared-host");
  });

  it("lists GitHub and skills.sh sources", async () => {
    const dataDir = join(await tempDir(), "data");
    const tarball = repoTarball({ "skills/alpha/SKILL.md": skillMd("alpha"), "skills/beta/SKILL.md": skillMd("beta") });
    const fetch = fakeFetch({ [codeload("acme", "kit")]: tarball, [codeload("acme", "kit", "v1")]: tarball });
    const cwd = await tempDir();
    expect((await run(["install", "acme/kit@alpha", "--data-dir", dataDir], { fetch, cwd })).code).toBe(0);
    expect((await run(["install", "https://github.com/acme/kit/tree/v1/skills/beta", "--data-dir", dataDir], { fetch, cwd })).code).toBe(0);
    const list = (await run(["list", "--data-dir", dataDir], { cwd })).out;
    expect(list).toMatch(/alpha\s+0\.0\.0\+[0-9a-f]{8}\s+acme\/kit@alpha/);
    expect(list).toMatch(/beta\s+0\.0\.0\+[0-9a-f]{8}\s+github:acme\/kit@v1\/skills\/beta/);
  });
});

describe("formatters", () => {
  it("formats lint and scan reports", () => {
    expect(formatLint({ skill: "s", ok: true, issues: [] })).toBe("s  lint ok");
    expect(formatLint({ skill: "s", ok: false, issues: [{ severity: "error", rule: "r", message: "m" }] })).toContain("s  lint FAILED (1 error, 0 warnings)");
    const scan = formatScan(
      {
        skill: "s",
        verdict: "warn",
        summary: "a\n\nb",
        findings: [
          { severity: "warn", rule: "w", file: "f", line: 2, message: "m" },
          { severity: "info", rule: "i", file: "f", message: "n" },
          { severity: "info", rule: "i2", file: "f", message: "o" },
        ],
        declared: { net: [], read: [], write: [], env: [], run: [] },
        observed: { net: [], read: [], write: [], env: [], run: [] },
        filesRead: 1,
        bytesRead: 3,
      },
      false,
    );
    expect(scan).toContain("s  scan WARN  (1 files, 3 bytes read)");
    expect(scan).toContain("f:2");
    expect(scan).toContain("(2 info findings not shown; use --json for all)");
  });
});
