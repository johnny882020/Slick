import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RegistryError,
  UnsafeSourceError,
  copyTree,
  describeSource,
  discoverSkillDirs,
  download,
  loadSkillDir,
  skillNameOf,
  stageSource,
  tarballUrl,
} from "../src/index.js";
import { repoTarball } from "./helpers/tar.js";
import { codeload, fakeFetch, fixture, skillMd, tempDir, writeTree } from "./helpers/util.js";

const noFetch = fakeFetch({});

async function multiRepoCopy(): Promise<string> {
  const root = join(await tempDir(), "multi-repo");
  await cp(fixture("multi-repo"), root, { recursive: true });
  // node_modules is git-ignored, so the fixture adds it here: it must be skipped.
  await writeTree(root, { "node_modules/pkg/skills/ignored/SKILL.md": skillMd("ignored") });
  return root;
}

describe("describeSource and tarballUrl", () => {
  it("labels sources", () => {
    expect(describeSource({ kind: "local", path: "/x" })).toBe("local:/x");
    expect(describeSource({ kind: "github", owner: "o", repo: "r" })).toBe("github:o/r@HEAD");
    expect(describeSource({ kind: "github", owner: "o", repo: "r", ref: "v1", path: "skills/a" })).toBe("github:o/r@v1/skills/a");
    expect(describeSource({ kind: "skills.sh", owner: "o", repo: "r" })).toBe("skills.sh:o/r");
    expect(describeSource({ kind: "skills.sh", owner: "o", repo: "r", skill: "s" })).toBe("skills.sh:o/r@s");
  });

  it("builds codeload URLs and rejects odd names", () => {
    expect(tarballUrl("anthropics", "skills")).toBe("https://codeload.github.com/anthropics/skills/tar.gz/HEAD");
    expect(tarballUrl("o", "r", "feature/x y")).toBe("https://codeload.github.com/o/r/tar.gz/feature/x%20y");
    expect(() => tarballUrl("o/x", "r")).toThrow(RegistryError);
    expect(() => tarballUrl("o", ".git")).toThrow(/invalid GitHub repository/);
    expect(() => tarballUrl("o", "r", "../x")).toThrow(/invalid git ref/);
    expect(() => tarballUrl("o", "r", "")).toThrow(/invalid git ref/);
  });
});

describe("download", () => {
  const url = "https://dl.example.com/x";
  it("reads streamed and non-streamed bodies", async () => {
    expect(await download(fakeFetch({ [url]: new Uint8Array([1, 2, 3]) }), url, 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await download(fakeFetch({ [url]: { body: new Uint8Array([4]), noStream: true } }), url, 10)).toEqual(new Uint8Array([4]));
  });

  it("fails on errors, bad status and oversize bodies", async () => {
    await expect(download(fakeFetch({ [url]: { error: new Error("offline") } }), url, 10)).rejects.toThrow(/could not download.*offline/);
    await expect(download(fakeFetch({}), url, 10)).rejects.toThrow(/HTTP 404/);
    await expect(download(fakeFetch({ [url]: { body: new Uint8Array(4), headers: { "content-length": "99" } } }), url, 10)).rejects.toThrow(/larger than 10/);
    await expect(download(fakeFetch({ [url]: new Uint8Array(20) }), url, 10)).rejects.toThrow(/larger than 10/);
    await expect(download(fakeFetch({ [url]: { body: new Uint8Array(20), noStream: true } }), url, 10)).rejects.toThrow(/larger than 10/);
  });
});

describe("discoverSkillDirs", () => {
  it("finds skills in common locations up to depth 4, skipping node_modules", async () => {
    const root = await multiRepoCopy();
    const found = (await discoverSkillDirs(root)).map((d) => d.slice(root.length + 1));
    expect(found).toEqual([".claude/skills/gamma", "deep/a/b/delta", "skills/alpha", "skills/beta"]);
  });

  it("returns the folder itself when it is a skill", async () => {
    expect(await discoverSkillDirs(fixture("clean-skill"))).toEqual([fixture("clean-skill")]);
  });

  it("returns nothing for a missing folder", async () => {
    expect(await discoverSkillDirs(join(await tempDir(), "nope"))).toEqual([]);
  });
});

describe("stageSource: local", () => {
  it("copies one skill folder", async () => {
    const staging = await tempDir();
    const s = await stageSource({ kind: "local", path: fixture("clean-skill") }, staging, { fetch: noFetch });
    expect(s.label).toBe(`local:${fixture("clean-skill")}`);
    expect(s.skillDirs).toHaveLength(1);
    expect(basename(s.skillDirs[0]!)).toBe("clean-skill");
    expect((await loadSkillDir(s.skillDirs[0]!)).entries.map((e) => e.path)).toEqual(["SKILL.md", "evals/cases.json", "references/format.md"]);
  });

  it("copies every skill in a folder of skills", async () => {
    const s = await stageSource({ kind: "local", path: await multiRepoCopy() }, await tempDir(), { fetch: noFetch });
    expect(s.skillDirs.map((d) => basename(d))).toEqual(["gamma", "delta", "alpha", "beta"]);
  });

  it("fails for a missing folder or one with no skills", async () => {
    await expect(stageSource({ kind: "local", path: "/definitely/not/here" }, await tempDir(), { fetch: noFetch })).rejects.toThrow(/not a folder/);
    const empty = await tempDir();
    await expect(stageSource({ kind: "local", path: empty }, await tempDir(), { fetch: noFetch })).rejects.toMatchObject({ code: "no-skills" });
  });

  it("keeps symlinks as symlinks, skips .git and enforces caps", async () => {
    const src = await writeTree(join(await tempDir(), "linky"), { "SKILL.md": skillMd("linky"), ".git/HEAD": "ref", "a.md": "a" });
    await symlink("a.md", join(src, "b.md"));
    await symlink("/etc/passwd", join(src, "c.md"));
    const dest = join(await tempDir(), "copy");
    await copyTree(src, dest);
    expect((await readdir(dest)).sort()).toEqual(["SKILL.md", "a.md", "b.md", "c.md"]);
    const loaded = await loadSkillDir(dest);
    expect(loaded.entries.find((e) => e.path === "b.md")).toMatchObject({ kind: "symlink", resolved: "a.md" });
    expect(loaded.entries.find((e) => e.path === "c.md")).toMatchObject({ kind: "symlink" });
    expect(loaded.entries.find((e) => e.path === "c.md")).not.toHaveProperty("resolved");
    await expect(copyTree(src, join(await tempDir(), "x"), { maxFiles: 2, maxBytes: 1e6 })).rejects.toMatchObject({ code: "too-many-files" });
    await expect(copyTree(src, join(await tempDir(), "y"), { maxFiles: 100, maxBytes: 10 })).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses FIFOs in a local source", async () => {
    const src = await writeTree(join(await tempDir(), "fifo"), { "SKILL.md": skillMd("fifo") });
    try {
      execFileSync("mkfifo", [join(src, "pipe")]);
    } catch {
      return; // mkfifo unavailable on this platform
    }
    const err = await copyTree(src, join(await tempDir(), "x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsafeSourceError);
    expect((err as UnsafeSourceError).entries[0]).toMatchObject({ path: "pipe", rule: "special-file" });
    const loaded = await loadSkillDir(src);
    expect(loaded.entries.find((e) => e.path === "pipe")).toEqual({ kind: "special", path: "pipe", type: "fifo" });
  });
});

describe("loadSkillDir", () => {
  it("rejects non-folders and enforces caps", async () => {
    await expect(loadSkillDir(fixture("clean-skill/SKILL.md"))).rejects.toThrow(/not a folder/);
    await expect(loadSkillDir(fixture("clean-skill"), { maxFiles: 1, maxBytes: 1e6 })).rejects.toMatchObject({ code: "too-many-files" });
    await expect(loadSkillDir(fixture("clean-skill"), { maxFiles: 100, maxBytes: 10 })).rejects.toMatchObject({ code: "too-large" });
  });

  it("describes dangling and chained symlinks", async () => {
    const src = await writeTree(join(await tempDir(), "links"), { "SKILL.md": skillMd("links"), "real.md": "r", "sub/x.md": "x" });
    await symlink("nothing.md", join(src, "dangling.md"));
    await symlink("real.md", join(src, "one.md"));
    await symlink("one.md", join(src, "two.md"));
    await symlink("../..", join(src, "sub", "up"));
    const outside = await tempDir();
    await writeFile(join(outside, "secret.md"), "s");
    await symlink(join(outside, "secret.md"), join(src, "abs.md"));
    await mkdir(join(src, "dir"));
    await symlink("../real.md", join(src, "dir", "back.md"));
    const loaded = await loadSkillDir(src);
    const by = (p: string) => loaded.entries.find((e) => e.path === p);
    expect(by("dangling.md")).toMatchObject({ kind: "symlink", resolved: "nothing.md", dangling: true });
    expect(by("two.md")).toMatchObject({ kind: "symlink", resolved: "real.md" });
    expect(by("dir/back.md")).toMatchObject({ kind: "symlink", resolved: "real.md" });
    expect(by("sub/up")).not.toHaveProperty("resolved");
    expect(by("abs.md")).not.toHaveProperty("resolved");
  });
});

describe("stageSource: GitHub and skills.sh", () => {
  const files = {
    "README.md": "# repo",
    "skills/alpha/SKILL.md": skillMd("alpha"),
    "skills/beta/SKILL.md": skillMd("beta"),
    "other/broken/SKILL.md": "not frontmatter",
  };

  it("downloads HEAD by default and finds every skill", async () => {
    const fetch = fakeFetch({ [codeload("acme", "skills")]: repoTarball(files) });
    const s = await stageSource({ kind: "github", owner: "acme", repo: "skills" }, await tempDir(), { fetch });
    expect(fetch.calls).toEqual([codeload("acme", "skills")]);
    expect(s.skillDirs.map((d) => basename(d))).toEqual(["broken", "alpha", "beta"]);
  });

  it("uses ref and path", async () => {
    const fetch = fakeFetch({ [codeload("acme", "skills", "v2")]: repoTarball(files) });
    const s = await stageSource({ kind: "github", owner: "acme", repo: "skills", ref: "v2", path: "skills/beta" }, await tempDir(), { fetch });
    expect(s.skillDirs.map((d) => basename(d))).toEqual(["beta"]);
    await expect(stageSource({ kind: "github", owner: "acme", repo: "skills", ref: "v2", path: "nope" }, await tempDir(), { fetch })).rejects.toMatchObject({ code: "no-skills" });
    await expect(stageSource({ kind: "github", owner: "acme", repo: "skills", ref: "v2", path: "../x" }, await tempDir(), { fetch })).rejects.toThrow(/invalid path/);
  });

  it("resolves skills.sh sources and selects @skill by frontmatter name", async () => {
    const renamed = { ...files, "skills/folder-name/SKILL.md": skillMd("display-name") };
    const fetch = fakeFetch({ [codeload("acme", "skills")]: repoTarball(renamed) });
    const all = await stageSource({ kind: "skills.sh", owner: "acme", repo: "skills" }, await tempDir(), { fetch });
    expect(all.skillDirs).toHaveLength(4);
    const one = await stageSource({ kind: "skills.sh", owner: "acme", repo: "skills", skill: "display-name" }, await tempDir(), { fetch });
    expect(one.skillDirs.map((d) => basename(d))).toEqual(["folder-name"]);
    await expect(stageSource({ kind: "skills.sh", owner: "acme", repo: "skills", skill: "nope" }, await tempDir(), { fetch })).rejects.toThrow(
      'no skill named "nope" in acme/skills (found: alpha, beta, broken, display-name)',
    );
  });

  it("reports a repo with no skills", async () => {
    const fetch = fakeFetch({ [codeload("acme", "empty")]: repoTarball({ "README.md": "x" }) });
    await expect(stageSource({ kind: "skills.sh", owner: "acme", repo: "empty", skill: "x" }, await tempDir(), { fetch })).rejects.toThrow(/no skill named "x" in acme\/empty$/);
    await expect(stageSource({ kind: "github", owner: "acme", repo: "empty" }, await tempDir(), { fetch })).rejects.toThrow(/no SKILL.md found in github:acme\/empty@HEAD/);
  });

  it("skillNameOf falls back to the folder name", async () => {
    const d = await writeTree(join(await tempDir(), "fallback"), { "SKILL.md": "---\nname: 3\n---\n" });
    expect(await skillNameOf(d)).toBe("fallback");
    expect(await skillNameOf(join(d, "missing"))).toBe("missing");
  });
});
