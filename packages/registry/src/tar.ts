// A small, defensive tar reader for GitHub tarballs (ustar, pax and GNU long
// names). Nothing is written until the whole archive has been checked.
// Refused: absolute paths, ".." segments, backslashes, NUL bytes, symlinks or
// hardlinks that point outside the archive root, paths that pass through a
// symlink, device files and FIFOs, and unknown entry types. Symlinks and
// hardlinks that stay inside become plain copies of their target file.

import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { posix } from "node:path";
import { RegistryError, UnsafeSourceError, type UnsafeEntry } from "./errors.js";
import { DEFAULT_LIMITS, type SourceLimits } from "./limits.js";

const BLOCK = 512;

export interface TarOptions {
  /** Leading path components to drop (GitHub tarballs have one: "<repo>-<sha>/"). */
  strip?: number;
  limits?: SourceLimits;
}

export interface TarFile {
  path: string;
  bytes: Uint8Array;
}

/** Gunzip with an output cap, so a small "zip bomb" cannot exhaust memory. */
export function gunzipLimited(gz: Uint8Array, maxOutput: number): Uint8Array {
  try {
    return new Uint8Array(gunzipSync(gz, { maxOutputLength: maxOutput }));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError)
      throw new RegistryError("too-large", `archive expands to more than ${maxOutput} bytes`);
    throw new RegistryError("bad-source", `archive is not valid gzip: ${err.message}`);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function cstring(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  while (end < start + len && buf[end] !== 0) end += 1;
  try {
    return utf8.decode(buf.subarray(start, end));
  } catch {
    // Invalid UTF-8 in a name: keep a visible marker so the path is refused below.
    return "�\0";
  }
}

function parseNumber(buf: Uint8Array, start: number, len: number): number {
  if ((buf[start]! & 0x80) !== 0) {
    // GNU base-256: big-endian, top bit of the first byte is the flag.
    let n = buf[start]! & 0x7f;
    for (let i = start + 1; i < start + len; i += 1) n = n * 256 + buf[i]!;
    return n;
  }
  const s = cstring(buf, start, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new RegistryError("bad-source", "corrupt tar header (number field)");
  return parseInt(s, 8);
}

function checksumOk(buf: Uint8Array, off: number): boolean {
  const stored = parseNumber(buf, off + 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : buf[off + i]!;
  return sum === stored;
}

function isZeroBlock(buf: Uint8Array, off: number): boolean {
  for (let i = 0; i < BLOCK; i += 1) if (buf[off + i] !== 0) return false;
  return true;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(" ", i);
    if (sp === -1) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

type PathCheck = { ok: true; path: string | undefined } | { ok: false; rule: string; message: string };

/** Validate an archive path and drop `strip` leading components. */
export function checkArchivePath(raw: string, strip: number): PathCheck {
  if (raw.includes("\0")) return { ok: false, rule: "bad-path", message: "path contains a NUL byte or invalid UTF-8" };
  if (raw.includes("\\")) return { ok: false, rule: "bad-path", message: "path contains a backslash" };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw))
    return { ok: false, rule: "absolute-path", message: "absolute path" };
  const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) return { ok: false, rule: "path-traversal", message: 'path contains ".."' };
  const rest = segs.slice(strip);
  return { ok: true, path: rest.length ? rest.join("/") : undefined };
}

interface RawLink {
  path: string;
  /** Archive-relative target (already validated and stripped). */
  target: string;
}

/**
 * Parse a tar archive in memory and return the files it holds, with internal
 * links resolved to copies. Throws UnsafeSourceError listing every unsafe entry.
 */
export function readTar(tar: Uint8Array, opts: TarOptions = {}): TarFile[] {
  const strip = opts.strip ?? 0;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const symlinks: RawLink[] = [];
  const hardlinks: RawLink[] = [];
  const unsafe: UnsafeEntry[] = [];
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let longLink: string | undefined;
  let entries = 0;
  let bytes = 0;
  let off = 0;

  const countEntry = () => {
    entries += 1;
    if (entries > limits.maxFiles) throw new RegistryError("too-many-files", `archive has more than ${limits.maxFiles} files`);
  };
  const addBytes = (n: number) => {
    bytes += n;
    if (bytes > limits.maxBytes) throw new RegistryError("too-large", `archive holds more than ${limits.maxBytes} bytes`);
  };

  while (off + BLOCK <= tar.length) {
    if (isZeroBlock(tar, off)) break;
    if (!checksumOk(tar, off)) throw new RegistryError("bad-source", "corrupt tar header (checksum)");
    const type = String.fromCharCode(tar[off + 156]!);
    const magic = cstring(tar, off + 257, 6);
    let name = cstring(tar, off + 0, 100);
    const prefix = magic.startsWith("ustar") ? cstring(tar, off + 345, 155) : "";
    if (prefix) name = `${prefix}/${name}`;
    let size = parseNumber(tar, off + 124, 12);
    let linkname = cstring(tar, off + 157, 100);
    if (pax["size"] !== undefined && /^\d+$/.test(pax["size"])) size = parseInt(pax["size"], 10);
    const dataStart = off + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new RegistryError("bad-source", "corrupt tar (entry runs past the end)");
    const data = tar.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    // Meta entries that change the next header.
    if (type === "x") {
      pax = parsePax(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = cstring(data, 0, data.length);
      continue;
    }
    if (type === "K") {
      longLink = cstring(data, 0, data.length);
      continue;
    }
    if (pax["path"] !== undefined) name = pax["path"];
    else if (longName !== undefined) name = longName;
    if (pax["linkpath"] !== undefined) linkname = pax["linkpath"];
    else if (longLink !== undefined) linkname = longLink;
    pax = {};
    longName = undefined;
    longLink = undefined;

    const checked = checkArchivePath(name, strip);
    if (!checked.ok) {
      unsafe.push({ path: name, rule: checked.rule, message: checked.message });
      continue;
    }
    const path = checked.path;
    if (path === undefined) continue; // the stripped root folder itself

    switch (type) {
      case "0":
      case "\0":
      case "7":
        countEntry();
        addBytes(size);
        files.set(path, new Uint8Array(data));
        break;
      case "5":
        dirs.add(path);
        break;
      case "2": {
        countEntry();
        if (linkname.startsWith("/") || /^[A-Za-z]:/.test(linkname) || linkname.includes("\\") || linkname.includes("\0")) {
          unsafe.push({ path: name, rule: "symlink-escape", message: `symlink to absolute path "${linkname}"` });
          break;
        }
        const target = posix.normalize(posix.join(posix.dirname(path), linkname));
        if (target === ".." || target.startsWith("../")) {
          unsafe.push({ path: name, rule: "symlink-escape", message: `symlink points outside the archive ("${linkname}")` });
          break;
        }
        symlinks.push({ path, target });
        break;
      }
      case "1": {
        countEntry();
        const t = checkArchivePath(linkname, strip);
        if (!t.ok || t.path === undefined) {
          unsafe.push({ path: name, rule: "hardlink-escape", message: `hardlink points outside the archive ("${linkname}")` });
          break;
        }
        hardlinks.push({ path, target: t.path });
        break;
      }
      case "3":
      case "4":
      case "6":
        unsafe.push({
          path: name,
          rule: "special-file",
          message: `${type === "6" ? "FIFO" : type === "3" ? "character device" : "block device"} is not allowed`,
        });
        break;
      default:
        unsafe.push({ path: name, rule: "unsupported-entry", message: `unsupported tar entry type "${type}"` });
    }
  }

  // Nothing may live under a symlink (that is how archives smuggle writes outside).
  const linkPaths = new Set(symlinks.map((l) => l.path));
  for (const p of [...files.keys(), ...hardlinks.map((h) => h.path), ...symlinks.map((s) => s.path), ...dirs]) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      const prefix = segs.slice(0, i).join("/");
      if (linkPaths.has(prefix)) {
        unsafe.push({ path: p, rule: "path-through-symlink", message: `path passes through symlink "${prefix}"` });
        break;
      }
    }
  }
  if (unsafe.length) throw new UnsafeSourceError(unsafe);

  for (const h of hardlinks) {
    const target = files.get(h.target);
    if (!target) continue; // a link to a missing file or a folder is dropped
    addBytes(target.length);
    files.set(h.path, target);
  }
  const symlinkMap = new Map(symlinks.map((s) => [s.path, s.target]));
  for (const s of symlinks) {
    let target = s.target;
    for (let hop = 0; hop < 8 && symlinkMap.has(target); hop += 1) {
      const next = symlinkMap.get(target)!;
      target = next;
    }
    const bytesOf = files.get(target);
    if (!bytesOf) continue; // links to folders or missing files are dropped
    addBytes(bytesOf.length);
    files.set(s.path, bytesOf);
  }

  // A path cannot be both a file and a folder.
  const all = [...files.keys()].sort();
  const fileSet = new Set(all);
  for (const p of all) {
    const segs = p.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      const prefix = segs.slice(0, i).join("/");
      if (fileSet.has(prefix)) throw new RegistryError("bad-source", `corrupt tar: "${prefix}" is both a file and a folder`);
    }
  }
  return all.map((path) => ({ path, bytes: files.get(path)! }));
}

/** Gunzip, check and write a .tar.gz into `dest`. Returns the written paths. */
export async function extractTarGz(gz: Uint8Array, dest: string, opts: TarOptions = {}): Promise<string[]> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  // Headers and padding add up to ~1.5 KB per entry on top of the content cap.
  const tar = gunzipLimited(gz, limits.maxBytes + limits.maxFiles * 3 * BLOCK + 1024 * 1024);
  const files = readTar(tar, { ...opts, limits });
  await mkdir(dest, { recursive: true });
  for (const f of files) {
    const out = join(dest, ...f.path.split("/"));
    await mkdir(dirname(out), { recursive: true });
    try {
      await writeFile(out, f.bytes, { mode: 0o644, flag: "wx" });
    } catch (e) {
      // Two archive paths that differ only by case collide on case-insensitive disks.
      throw new RegistryError("bad-source", `cannot write "${f.path}": ${(e as Error).message}`);
    }
  }
  return files.map((f) => f.path);
}
