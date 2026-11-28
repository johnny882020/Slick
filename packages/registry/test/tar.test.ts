import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RegistryError, UnsafeSourceError, checkArchivePath, extractTarGz, gunzipLimited, readTar } from "../src/index.js";
import { fixChecksum, paxRecords, repoTarball, tar, tarGz, type TarSpec } from "./helpers/tar.js";
import { tempDir } from "./helpers/util.js";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const R = "repo-abc/";

function unsafe(entries: TarSpec[], strip = 1): UnsafeSourceError {
  try {
    readTar(tar(entries), { strip });
  } catch (e) {
    if (e instanceof UnsafeSourceError) return e;
    throw e;
  }
  throw new Error("expected UnsafeSourceError");
}

function registryError(fn: () => unknown): RegistryError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryError) return e;
    throw e;
  }
  throw new Error("expected RegistryError");
}

describe("checkArchivePath", () => {
  it("strips components and rejects unsafe paths", () => {
    expect(checkArchivePath("repo/a/b.md", 1)).toEqual({ ok: true, path: "a/b.md" });
    expect(checkArchivePath("./repo/./a", 1)).toEqual({ ok: true, path: "a" });
    expect(checkArchivePath("repo/", 1)).toEqual({ ok: true, path: undefined });
    expect(checkArchivePath("/etc/passwd", 0)).toMatchObject({ ok: false, rule: "absolute-path" });
    expect(checkArchivePath("C:/x", 0)).toMatchObject({ ok: false, rule: "absolute-path" });
    expect(checkArchivePath("a/../../x", 0)).toMatchObject({ ok: false, rule: "path-traversal" });
    expect(checkArchivePath("a\\..\\x", 0)).toMatchObject({ ok: false, rule: "bad-path" });
    expect(checkArchivePath("a\0b", 0)).toMatchObject({ ok: false, rule: "bad-path" });
  });
});

describe("readTar", () => {
  it("reads files, skips folders and the pax global header, and strips the root", () => {
    const files = readTar(
      tar([
        { name: "pax_global_header", type: "g", body: paxRecords({ comment: "abc" }) },
        { name: R },
        { name: `${R}skills/`, type: "5" },
        { name: `${R}skills/a/SKILL.md`, body: "hello" },
        { name: `${R}README.md`, body: "x".repeat(700) },
        { name: `${R}contiguous.txt`, type: "7", body: "c" },
        { name: `${R}empty.txt`, type: "\0" },
      ]),
      { strip: 1 },
    );
    expect(files.map((f) => f.path)).toEqual(["README.md", "contiguous.txt", "empty.txt", "skills/a/SKILL.md"]);
    expect(text(files.find((f) => f.path === "README.md")!.bytes)).toHaveLength(700);
  });

  it("rejects path traversal, absolute paths and bad names, listing every one", () => {
    const e = unsafe([
      { name: `${R}ok.md`, body: "ok" },
      { name: `${R}../../etc/cron.d/evil`, body: "x" },
      { name: "/etc/passwd", body: "x" },
      { name: `${R}win\\evil`, body: "x" },
      { name: "bad", rawName: new Uint8Array([0x72, 0x2f, 0xff, 0xfe]), body: "x" },
    ]);
    expect(e.entries.map((x) => x.rule)).toEqual(["path-traversal", "absolute-path", "bad-path", "bad-path"]);
    expect(e.code).toBe("unsafe-source");
  });

  it("rejects symlinks that escape and paths through symlinks", () => {
    const e = unsafe([
      { name: `${R}up`, type: "2", linkname: "../../outside" },
      { name: `${R}abs`, type: "2", linkname: "/etc/passwd" },
      { name: `${R}dir`, type: "2", linkname: "sub" },
      { name: `${R}dir/evil.txt`, body: "through the link" },
    ]);
    expect(e.entries.map((x) => x.rule).sort()).toEqual(["path-through-symlink", "symlink-escape", "symlink-escape"]);
  });

  it("rejects hardlinks outside, device files, FIFOs and unknown types", () => {
    const e = unsafe([
      { name: `${R}h`, type: "1", linkname: "../../etc/shadow" },
      { name: `${R}h2`, type: "1", linkname: "/etc/shadow" },
      { name: `${R}c`, type: "3" },
      { name: `${R}b`, type: "4" },
      { name: `${R}f`, type: "6" },
      { name: `${R}s`, type: "S" },
    ]);
    expect(e.entries.map((x) => x.rule)).toEqual(["hardlink-escape", "hardlink-escape", "special-file", "special-file", "special-file", "unsupported-entry"]);
  });

  it("turns internal symlinks and hardlinks into copies and drops dangling ones", () => {
    const files = readTar(
      tar([
        { name: `${R}a.md`, body: "A" },
        { name: `${R}docs/link.md`, type: "2", linkname: "../a.md" },
        { name: `${R}chain.md`, type: "2", linkname: "docs/link.md" },
        { name: `${R}hard.md`, type: "1", linkname: `${R}a.md` },
        { name: `${R}gone.md`, type: "2", linkname: "missing.md" },
        { name: `${R}hardgone.md`, type: "1", linkname: `${R}missing.md` },
        { name: `${R}self`, type: "2", linkname: "." },
        { name: `${R}sub/`, type: "5" },
        { name: `${R}tosub`, type: "2", linkname: "sub" },
      ]),
      { strip: 1 },
    );
    expect(files.map((f) => [f.path, text(f.bytes)])).toEqual([
      ["a.md", "A"],
      ["chain.md", "A"],
      ["docs/link.md", "A"],
      ["hard.md", "A"],
    ]);
  });

  it("supports pax path/linkpath/size, GNU long names, ustar prefix and base-256 sizes", () => {
    const long = `${R}${"d/".repeat(60)}deep.md`;
    const files = readTar(
      tar([
        { name: "PaxHeader", type: "x", body: paxRecords({ path: `${R}pax-named.md`, size: "3" }) },
        { name: "ignored", body: "pax" },
        { name: "././@LongLink", type: "L", body: `${long}\0` },
        { name: "trunc", body: "long" },
        { name: "x/prefixed.md", prefix: "repo-abc", body: "pre" },
        { name: `${R}big.md`, base256: true, body: "b256" },
        { name: "PaxHeader", type: "x", body: paxRecords({ linkpath: "pax-named.md" }) },
        { name: `${R}paxlink.md`, type: "2" },
        { name: "././@LongLink", type: "K", body: "pax-named.md\0" },
        { name: `${R}gnulink.md`, type: "2" },
      ]),
      { strip: 1 },
    );
    const map = Object.fromEntries(files.map((f) => [f.path, text(f.bytes)]));
    expect(map["pax-named.md"]).toBe("pax");
    expect(map[long.slice(R.length)]).toBe("long");
    expect(map["x/prefixed.md"]).toBe("pre");
    expect(map["big.md"]).toBe("b256");
    expect(map["paxlink.md"]).toBe("pax");
    expect(map["gnulink.md"]).toBe("pax");
  });

  it("ignores the prefix field in pre-POSIX headers", () => {
    const files = readTar(tar([{ name: "a.md", prefix: "zzz", magic: "\0\0\0\0\0\0", body: "v7" }]));
    expect(files.map((f) => f.path)).toEqual(["a.md"]);
  });

  it("stops at the end without a trailer", () => {
    expect(readTar(tar([{ name: "a.md", body: "x" }], { trailer: false })).map((f) => f.path)).toEqual(["a.md"]);
  });

  it("rejects corrupt archives", () => {
    expect(registryError(() => readTar(tar([{ name: "a", body: "x", badChecksum: true }]))).code).toBe("bad-source");
    expect(registryError(() => readTar(tar([{ name: "a", body: "x", sizeField: 99999 }], { trailer: false }))).message).toMatch(/past the end/);
    const bad = tar([{ name: "a", body: "x" }]);
    bad.set(new TextEncoder().encode("zzzzzzzzzzz\0"), 124);
    fixChecksum(bad);
    expect(registryError(() => readTar(bad)).message).toMatch(/number field/);
    expect(registryError(() => readTar(tar([{ name: "a", body: "1" }, { name: "a/b", body: "2" }]))).message).toMatch(/both a file and a folder/);
  });

  it("enforces the file-count and size caps", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, body: "x" }));
    expect(registryError(() => readTar(tar(many), { limits: { maxFiles: 4, maxBytes: 1000 } })).code).toBe("too-many-files");
    expect(registryError(() => readTar(tar([{ name: "big", body: "x".repeat(2000) }]), { limits: { maxFiles: 10, maxBytes: 1000 } })).code).toBe("too-large");
    // Materialised link copies count toward the size cap too.
    const linked = tar([
      { name: "a", body: "x".repeat(600) },
      { name: "b", type: "1", linkname: "a" },
    ]);
    expect(registryError(() => readTar(linked, { limits: { maxFiles: 10, maxBytes: 1000 } })).code).toBe("too-large");
  });
});

describe("gunzipLimited and extractTarGz", () => {
  it("rejects invalid gzip and outputs over the cap", () => {
    expect(registryError(() => gunzipLimited(new Uint8Array([1, 2, 3]), 100)).code).toBe("bad-source");
    const bomb = new Uint8Array(gzipSync(new Uint8Array(1024 * 1024)));
    expect(registryError(() => gunzipLimited(bomb, 1024)).code).toBe("too-large");
  });

  it("extracts a codeload tarball into a folder", async () => {
    const dest = join(await tempDir(), "out");
    const written = await extractTarGz(repoTarball({ "skills/a/SKILL.md": "A", "README.md": "R" }), dest, { strip: 1 });
    expect(written).toEqual(["README.md", "skills/a/SKILL.md"]);
    expect(await readFile(join(dest, "skills", "a", "SKILL.md"), "utf8")).toBe("A");
  });

  it("never writes anything when an entry is unsafe", async () => {
    const root = await tempDir();
    const dest = join(root, "out");
    const gz = tarGz([
      { name: `${R}fine.md`, body: "ok" },
      { name: `${R}../escape.txt`, body: "x" },
    ]);
    await expect(extractTarGz(gz, dest, { strip: 1 })).rejects.toBeInstanceOf(UnsafeSourceError);
    await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
    await expect(readFile(join(dest, "fine.md"))).rejects.toThrow();
  });

  it("reports a file that cannot be written", async () => {
    const dest = join(await tempDir(), "out");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "a.md"), "already here");
    await expect(extractTarGz(tarGz([{ name: "a.md", body: "x" }]), dest)).rejects.toThrow(/cannot write "a.md"/);
  });
});
