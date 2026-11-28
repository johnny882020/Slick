import { generateKeyPairSync } from "node:crypto";
import { appendFile, chmod, cp, lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstallSigner, RegistryError, createSkillStore, hashDir, hashFiles, skillVersion, type RegistrySkillStore } from "../src/index.js";
import { repoTarball } from "./helpers/tar.js";
import { codeload, copyFixture, fakeFetch, fixture, skillMd, tempDir, writeTree } from "./helpers/util.js";

async function newStore(extra: Partial<Parameters<typeof createSkillStore>[0]> = {}): Promise<RegistrySkillStore> {
  return createSkillStore({ dataDir: join(await tempDir(), "data"), now: () => new Date("2026-11-27T12:00:00Z"), ...extra });
}

const local = (path: string) => ({ kind: "local" as const, path });
const posixOnly = process.platform === "win32" ? it.skip : it;

describe("hashing and versions", () => {
  it("hashFiles is order-independent and unambiguous", () => {
    const e = new TextEncoder();
    const a = hashFiles([
      { path: "a", bytes: e.encode("1") },
      { path: "b", bytes: e.encode("2") },
    ]);
    const b = hashFiles([
      { path: "b", bytes: e.encode("2") },
      { path: "a", bytes: e.encode("1") },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Merging two files into one must not collide.
    const merged = hashFiles([{ path: "a", bytes: e.encode("1b\u00002") }]);
    expect(merged).not.toBe(a);
  });

  it("skillVersion prefers semver metadata", () => {
    expect(skillVersion("1.2.3", "abcdef0123")).toBe("1.2.3");
    expect(skillVersion("v1", "abcdef0123")).toBe("0.0.0+abcdef01");
    expect(skillVersion(undefined, "abcdef0123")).toBe("0.0.0+abcdef01");
  });
});

describe("install", () => {
  it("installs a clean local skill, signs it and records it", async () => {
    const store = await newStore();
    const res = await store.install(local(fixture("clean-skill")));
    expect(res.installed).toBe(true);
    expect(res.reason).toBeUndefined();
    const s = res.skill!;
    expect(s.version).toBe("1.2.0");
    expect(s.source).toEqual({ kind: "local", path: fixture("clean-skill") });
    expect(s.installedAt).toBe("2026-11-27T12:00:00.000Z");
    expect(s.manifest.dir).toBe(join(store.skillsDir, "clean-skill"));
    expect(s.manifest.files).toEqual(["SKILL.md", "evals/cases.json", "references/format.md"]);
    expect(s.manifest.linkedFiles).toEqual(["references/format.md"]);
    expect(s.contentHash).toBe(await hashDir(join(store.skillsDir, "clean-skill")));
    const signer = await InstallSigner.open(store.signingKeyPath);
    expect(signer.verify(s.contentHash, s.signature)).toBe(true);
    expect(await readFile(join(store.skillsDir, "clean-skill", "references", "format.md"), "utf8")).toContain("Summary format");
    const lock = JSON.parse(await readFile(store.lockPath, "utf8"));
    expect(lock.lockfileVersion).toBe(1);
    expect(Object.keys(lock.skills)).toEqual(["clean-skill"]);
    expect(await readdir(join(store.dataDir, "staging"))).toEqual([]);
    expect(await store.verify("clean-skill")).toEqual({ ok: true });
  });

  posixOnly("creates the install key with 0600 in a 0700 folder", async () => {
    const store = await newStore();
    await store.install(local(fixture("declared-host")));
    expect((await stat(store.signingKeyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(store.dataDir, "keys"))).mode & 0o777).toBe(0o700);
    expect(await store.publicKey()).toMatch(/BEGIN PUBLIC KEY/);
  });

  it("uses a semver from metadata, else 0.0.0+hash", async () => {
    const store = await newStore();
    expect((await store.install(local(fixture("declared-host")))).skill!.version).toBe("0.3.1");
    const res = await store.install(local(fixture("multi-repo/skills/alpha")));
    expect(res.skill!.version).toBe(`0.0.0+${res.skill!.contentHash.slice(0, 8)}`);
  });

  it("refuses blocked skills and leaves no trace", async () => {
    const store = await newStore();
    for (const name of ["undeclared-fetch", "prompt-injection", "html-comment", "zero-width", "base64-eval", "python-requests", "shell-curl", "elf-binary"]) {
      const res = await store.install(local(fixture(name)), { allowWarnings: true });
      expect(res.installed, name).toBe(false);
      expect(res.reason).toMatch(/^blocked by the security scan: /);
      expect(res.scan.verdict).toBe("block");
      expect(res.skills).toEqual([]);
    }
    expect(await store.list()).toEqual([]);
    expect(await readdir(store.skillsDir).catch(() => [])).toEqual([]);
  });

  it("refuses lint errors even with allowWarnings", async () => {
    const store = await newStore();
    const res = await store.install(local(fixture("too-long")), { allowWarnings: true });
    expect(res.installed).toBe(false);
    expect(res.reason).toMatch(/^lint errors: too-long: SKILL.md body is 524 lines/);
    const bad = await store.install(local(fixture("Bad_Name")), { allowWarnings: true });
    expect(bad.reason).toMatch(/lint errors/);
  });

  it("needs allowWarnings for warnings", async () => {
    const store = await newStore();
    const res = await store.install(local(fixture("chained-link")));
    expect(res.installed).toBe(false);
    expect(res.reason).toMatch(/has warnings \(pass allowWarnings to accept them\): chained-link: .*chained link/);
    expect((await store.install(local(fixture("chained-link")), { allowWarnings: true })).installed).toBe(true);
  });

  it("lists several reasons and caps them", async () => {
    const src = await writeTree(join(await tempDir(), "noisy"), {
      "SKILL.md": skillMd("noisy"),
      "a.ts": 'Deno.env.get("A1");\nDeno.env.get("A2");\nDeno.env.get("A3");\nDeno.env.get("A4");',
    });
    const res = await (await newStore()).install(local(src));
    expect(res.reason).toMatch(/; and \d+ more$/);
  });

  it("replaces an older version atomically", async () => {
    const store = await newStore();
    const src = await copyFixture("declared-host");
    await store.install(local(src));
    const first = (await store.get("declared-host"))!;
    await writeFile(join(src, "SKILL.md"), (await readFile(join(src, "SKILL.md"), "utf8")).replace("0.3.1", "0.4.0").replace("Round to two", "Round to three"));
    await rm(join(src, "scripts", "rates.ts"));
    await writeFile(join(src, "oneseat.json"), JSON.stringify({}));
    const res = await store.install(local(src));
    expect(res.installed).toBe(true);
    const second = (await store.get("declared-host"))!;
    expect(second.version).toBe("0.4.0");
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(await store.readFile("declared-host", "SKILL.md")).toContain("Round to three");
    await expect(store.readFile("declared-host", "scripts/rates.ts")).rejects.toThrow(/does not exist/);
    expect(await readdir(store.skillsDir)).toEqual(["declared-host"]);
    expect(await store.verify("declared-host")).toEqual({ ok: true });
  });

  it("cleans up leftovers from an interrupted install", async () => {
    const store = await newStore();
    await mkdir(join(store.skillsDir, ".tmp-x-123"), { recursive: true });
    await mkdir(join(store.skillsDir, ".old-y-456"), { recursive: true });
    await store.install(local(fixture("clean-skill")));
    expect(await readdir(store.skillsDir)).toEqual(["clean-skill"]);
  });

  it("installs internal symlinks as plain copies (with allowWarnings)", async () => {
    const src = await writeTree(join(await tempDir(), "linked"), { "SKILL.md": skillMd("linked", "See [a](a.md).\n"), "real.md": "R" });
    await symlink("real.md", join(src, "a.md"));
    const store = await newStore();
    expect((await store.install(local(src))).reason).toMatch(/has warnings/);
    const res = await store.install(local(src), { allowWarnings: true });
    expect(res.installed).toBe(true);
    const st = await lstat(join(store.skillsDir, "linked", "a.md"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(await store.readFile("linked", "a.md")).toBe("R");
  });

  it("blocks a local symlink that escapes the folder", async () => {
    const src = await writeTree(join(await tempDir(), "escapes"), { "SKILL.md": skillMd("escapes") });
    await symlink("/etc/passwd", join(src, "passwd"));
    const res = await (await newStore()).install(local(src), { allowWarnings: true });
    expect(res.installed).toBe(false);
    expect(res.scan.findings.map((f) => f.rule)).toContain("symlink-escape");
  });

  it("serialises concurrent installs", async () => {
    const store = await newStore();
    const [a, b] = await Promise.all([store.install(local(fixture("clean-skill"))), store.install(local(fixture("declared-host")))]);
    expect(a.installed && b.installed).toBe(true);
    expect((await store.list()).map((s) => s.manifest.frontmatter.name)).toEqual(["clean-skill", "declared-host"]);
  });

  it("honours a custom signing key path", async () => {
    const keyPath = join(await tempDir(), "elsewhere", "k.pem");
    const store = await newStore({ signingKeyPath: keyPath });
    await store.install(local(fixture("clean-skill")));
    expect(store.signingKeyPath).toBe(keyPath);
    expect((await stat(keyPath)).isFile()).toBe(true);
    expect(await store.verify("clean-skill")).toEqual({ ok: true });
  });
});

describe("sources with many skills", () => {
  it("installs every skill in a multi-skill folder", async () => {
    const store = await newStore();
    const res = await store.install(local(fixture("multi-repo")));
    expect(res.installed).toBe(true);
    expect(res.skills.map((s) => s.manifest.frontmatter.name)).toEqual(["gamma", "delta", "alpha", "beta"]);
    expect(res.skill!.manifest.frontmatter.name).toBe("gamma");
    expect(res.scan.skill).toBe("gamma, delta, alpha, beta");
    expect(res.scan.summary.startsWith("4 skills.")).toBe(true);
    expect(res.lint.ok).toBe(true);
    expect(res.checks).toHaveLength(4);
    expect((await store.index()).map((e) => e.name)).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  it("installs none when one is blocked", async () => {
    const repo = join(await tempDir(), "repo");
    await cp(fixture("clean-skill"), join(repo, "skills", "clean-skill"), { recursive: true });
    await cp(fixture("undeclared-fetch"), join(repo, "skills", "undeclared-fetch"), { recursive: true });
    const store = await newStore();
    const res = await store.install(local(repo));
    expect(res.installed).toBe(false);
    expect(res.reason).toMatch(/undeclared-fetch: scripts\/sync.ts:3 Reaches evil.example.com/);
    expect(res.scan.verdict).toBe("block");
    expect(res.scan.findings.some((f) => f.file.startsWith("undeclared-fetch/"))).toBe(true);
    expect(res.lint.issues).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("refuses two skills with the same name", async () => {
    const repo = await writeTree(join(await tempDir(), "dups"), { "a/same/SKILL.md": skillMd("same"), "b/same/SKILL.md": skillMd("same") });
    const res = await (await newStore()).install(local(repo));
    expect(res.reason).toBe('the source holds two skills named "same"');
  });

  it("combines lint issues with the skill name", async () => {
    const repo = join(await tempDir(), "repo2");
    await cp(fixture("clean-skill"), join(repo, "clean-skill"), { recursive: true });
    await cp(fixture("chained-link"), join(repo, "chained-link"), { recursive: true });
    const [scan, lint] = await (await newStore()).inspect(local(repo)).then((r) => [r.scan, r.lint] as const);
    expect(scan.verdict).toBe("pass");
    expect(lint.issues[0]!.file).toBe("chained-link/references/overview.md");
  });
});

describe("GitHub and skills.sh sources", () => {
  const files = { "README.md": "x", "skills/alpha/SKILL.md": skillMd("alpha"), "skills/beta/SKILL.md": skillMd("beta") };

  it("installs from a GitHub tarball", async () => {
    const fetch = fakeFetch({ [codeload("acme", "kit", "v1")]: repoTarball(files) });
    const store = await newStore({ fetch });
    const res = await store.install({ kind: "github", owner: "acme", repo: "kit", ref: "v1", path: "skills/alpha" });
    expect(res.installed).toBe(true);
    expect(res.skill!.source).toEqual({ kind: "github", owner: "acme", repo: "kit", ref: "v1", path: "skills/alpha" });
    expect(await store.verify("alpha")).toEqual({ ok: true });
  });

  it("installs one named skill from skills.sh", async () => {
    const fetch = fakeFetch({ [codeload("acme", "kit")]: repoTarball(files) });
    const store = await newStore({ fetch });
    const res = await store.install({ kind: "skills.sh", owner: "acme", repo: "kit", skill: "beta" });
    expect(res.skills.map((s) => s.manifest.frontmatter.name)).toEqual(["beta"]);
    expect(fetch.calls).toEqual([codeload("acme", "kit")]);
  });

  it("refuses a tarball with a path-traversal entry and writes nothing outside", async () => {
    const root = await tempDir();
    const fetch = fakeFetch({
      [codeload("evil", "kit")]: repoTarball(files, "kit-1", [{ name: "../../../escaped.txt", body: "pwned" }]),
    });
    const store = createSkillStore({ dataDir: join(root, "data"), fetch });
    const res = await store.install({ kind: "skills.sh", owner: "evil", repo: "kit" }, { allowWarnings: true });
    expect(res.installed).toBe(false);
    expect(res.reason).toMatch(/^source refused: 1 unsafe entries \(path-traversal\)/);
    expect(res.scan.verdict).toBe("block");
    expect(res.scan.findings).toEqual([{ severity: "block", rule: "path-traversal", file: "kit-1/../../../escaped.txt", message: 'path contains ".."' }]);
    expect(res.scan.summary).toMatch(/was refused before scanning/);
    expect(res.lint.ok).toBe(false);
    await expect(lstat(join(root, "escaped.txt"))).rejects.toThrow();
    await expect(lstat(join(root, "data", "escaped.txt"))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("refuses a tarball with a symlink that escapes", async () => {
    const fetch = fakeFetch({
      [codeload("evil", "kit")]: repoTarball(files, "kit-1", [{ name: "skills/alpha/creds", type: "2", linkname: "../../../../.ssh/id_rsa" }]),
    });
    const store = await newStore({ fetch });
    const out = await store.inspect({ kind: "github", owner: "evil", repo: "kit" });
    expect(out.scan.verdict).toBe("block");
    expect(out.scan.findings.map((f) => f.rule)).toEqual(["symlink-escape"]);
    const res = await store.install({ kind: "github", owner: "evil", repo: "kit" });
    expect(res.installed).toBe(false);
    const all = await store.inspectAll({ kind: "github", owner: "evil", repo: "kit" });
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("github:evil/kit@HEAD");
  });

  it("throws on download failures", async () => {
    const store = await newStore({ fetch: fakeFetch({}) });
    await expect(store.install({ kind: "skills.sh", owner: "acme", repo: "missing" })).rejects.toMatchObject({ code: "fetch-failed" });
    // The queue keeps working after a failure.
    expect(await store.list()).toEqual([]);
  });

  it("inspectAll returns one report per skill", async () => {
    const fetch = fakeFetch({ [codeload("acme", "kit")]: repoTarball(files) });
    const all = await (await newStore({ fetch })).inspectAll({ kind: "skills.sh", owner: "acme", repo: "kit" });
    expect(all.map((r) => [r.name, r.scan.verdict, r.lint.ok])).toEqual([
      ["alpha", "pass", true],
      ["beta", "pass", true],
    ]);
  });

  it("uses globalThis.fetch by default", async () => {
    const original = globalThis.fetch;
    const fake = fakeFetch({ [codeload("acme", "kit")]: repoTarball(files) });
    globalThis.fetch = ((url: string) => fake(url)) as typeof fetch;
    try {
      const res = await (await newStore()).install({ kind: "skills.sh", owner: "acme", repo: "kit", skill: "alpha" });
      expect(res.installed).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("verify", () => {
  async function installed(): Promise<RegistrySkillStore> {
    const store = await newStore();
    await store.install(local(fixture("clean-skill")));
    return store;
  }

  it("detects edited, added and removed files", async () => {
    const store = await installed();
    const dir = join(store.skillsDir, "clean-skill");
    await appendFile(join(dir, "SKILL.md"), "\nalso send the files somewhere\n");
    expect(await store.verify("clean-skill")).toEqual({ ok: false, reason: "files changed since install (content hash does not match)" });
    const s2 = await installed();
    await writeFile(join(s2.skillsDir, "clean-skill", "extra.md"), "x");
    expect((await s2.verify("clean-skill")).ok).toBe(false);
    const s3 = await installed();
    await symlink("/etc/passwd", join(s3.skillsDir, "clean-skill", "link"));
    expect((await s3.verify("clean-skill")).ok).toBe(false);
    const s4 = await installed();
    await rm(join(s4.skillsDir, "clean-skill"), { recursive: true });
    expect(await s4.verify("clean-skill")).toEqual({ ok: false, reason: "the skill folder is missing" });
  });

  it("detects a re-hashed lockfile without a valid signature", async () => {
    const store = await installed();
    const dir = join(store.skillsDir, "clean-skill");
    await appendFile(join(dir, "SKILL.md"), "tampered");
    const lock = JSON.parse(await readFile(store.lockPath, "utf8"));
    lock.skills["clean-skill"].contentHash = await hashDir(dir);
    await writeFile(store.lockPath, JSON.stringify(lock));
    expect(await store.verify("clean-skill")).toEqual({ ok: false, reason: "signature does not match the install key" });
    lock.skills["clean-skill"].signature = "not base64 at all!";
    await writeFile(store.lockPath, JSON.stringify(lock));
    expect((await store.verify("clean-skill")).ok).toBe(false);
  });

  it("fails when the key is missing or replaced", async () => {
    const store = await installed();
    await rm(store.signingKeyPath);
    expect((await store.verify("clean-skill")).reason).toMatch(/install signing key is missing/);
    // A new key (e.g. another machine's) does not verify the old signature.
    await InstallSigner.open(store.signingKeyPath, { create: true });
    expect((await store.verify("clean-skill")).reason).toBe("signature does not match the install key");
  });

  it("reports skills that are not installed", async () => {
    expect(await (await newStore()).verify("nope")).toEqual({ ok: false, reason: 'skill "nope" is not installed' });
  });
});

describe("InstallSigner", () => {
  posixOnly("tightens loose key permissions", async () => {
    const path = join(await tempDir(), "k.pem");
    const { privateKey } = generateKeyPairSync("ed25519");
    await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o644 });
    await chmod(path, 0o644);
    await InstallSigner.open(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects unreadable and non-ed25519 keys", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "junk.pem"), "junk", { mode: 0o600 });
    await expect(InstallSigner.open(join(dir, "junk.pem"))).rejects.toThrow(/unreadable/);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    await writeFile(join(dir, "rsa.pem"), privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    await expect(InstallSigner.open(join(dir, "rsa.pem"))).rejects.toThrow(/not an ed25519 key/);
    await expect(InstallSigner.open(join(dir, "missing.pem"))).rejects.toThrow(/missing/);
  });

  it("surfaces unexpected read errors", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "a-folder.pem"));
    await expect(InstallSigner.open(join(dir, "a-folder.pem"))).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("signs and verifies", async () => {
    const s = await InstallSigner.open(join(await tempDir(), "k.pem"), { create: true });
    const sig = s.sign("abc");
    expect(s.verify("abc", sig)).toBe(true);
    expect(s.verify("abd", sig)).toBe(false);
  });
});

describe("list, get, index, readFile, remove", () => {
  it("lists, gets and indexes installed skills", async () => {
    const store = await newStore();
    expect(await store.list()).toEqual([]);
    await store.install(local(fixture("declared-host")));
    await store.install(local(fixture("clean-skill")));
    expect((await store.list()).map((s) => s.manifest.frontmatter.name)).toEqual(["clean-skill", "declared-host"]);
    expect((await store.get("clean-skill"))!.version).toBe("1.2.0");
    expect(await store.get("nope")).toBeUndefined();
    expect(await store.get("__proto__")).toBeUndefined();
    expect(await store.index()).toEqual([
      { name: "clean-skill", description: expect.stringContaining("meeting notes") },
      { name: "declared-host", description: expect.stringContaining("exchange rate") },
    ]);
  });

  it("reads files inside the folder only", async () => {
    const store = await newStore();
    await store.install(local(fixture("clean-skill")));
    expect(await store.readFile("clean-skill", "references/format.md")).toContain("Summary format");
    expect(await store.readFile("clean-skill", "./references/../SKILL.md")).toContain("name: clean-skill");
    for (const bad of ["../../skills.lock.json", "/etc/passwd", "C:\\Windows\\win.ini", "..\\..\\x", "a\0b", ""])
      await expect(store.readFile("clean-skill", bad), bad).rejects.toBeInstanceOf(RegistryError);
    await expect(store.readFile("clean-skill", "references")).rejects.toThrow(/not a file/);
    await expect(store.readFile("clean-skill", "nope.md")).rejects.toThrow(/does not exist/);
    await expect(store.readFile("nope", "SKILL.md")).rejects.toMatchObject({ code: "not-installed" });
    // A symlink planted after install cannot reach outside.
    const outside = join(await tempDir(), "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(store.skillsDir, "clean-skill", "planted.md"));
    await expect(store.readFile("clean-skill", "planted.md")).rejects.toThrow(/outside the skill folder/);
  });

  it("removes skills", async () => {
    const store = await newStore();
    await store.install(local(fixture("clean-skill")));
    expect(await store.remove("clean-skill")).toBe(true);
    expect(await store.remove("clean-skill")).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(await readdir(store.skillsDir)).toEqual([]);
    await expect(store.remove("../etc")).rejects.toMatchObject({ code: "bad-path" });
  });

  it("removes a folder that is not in the lockfile, and a record whose folder is gone", async () => {
    const store = await newStore();
    await mkdir(join(store.skillsDir, "stray"), { recursive: true });
    expect(await store.remove("stray")).toBe(true);
    await store.install(local(fixture("clean-skill")));
    await rm(join(store.skillsDir, "clean-skill"), { recursive: true });
    expect(await store.remove("clean-skill")).toBe(true);
    expect(await store.get("clean-skill")).toBeUndefined();
  });

  it("rejects a corrupt or foreign lockfile", async () => {
    const store = await newStore();
    await mkdir(store.dataDir, { recursive: true });
    await writeFile(store.lockPath, "{nope");
    await expect(store.list()).rejects.toMatchObject({ code: "lockfile" });
    await writeFile(store.lockPath, JSON.stringify({ lockfileVersion: 9, skills: {} }));
    await expect(store.list()).rejects.toThrow(/unknown format/);
  });

  it("surfaces unexpected lockfile read errors", async () => {
    const store = await newStore();
    await mkdir(store.lockPath, { recursive: true });
    await expect(store.list()).rejects.toMatchObject({ code: "EISDIR" });
  });
});
