// Build tar archives in memory, including malformed and malicious entries,
// so the safe reader can be tested without touching the network.

import { gzipSync } from "node:zlib";

export interface TarSpec {
  name: string;
  /** Tar type flag. Default "0" (file), or "5" when name ends with "/". */
  type?: string;
  body?: string | Uint8Array;
  linkname?: string;
  prefix?: string;
  /** Write the size in GNU base-256 form. */
  base256?: boolean;
  /** Corrupt the header checksum. */
  badChecksum?: boolean;
  /** Write raw bytes for the name field (e.g. invalid UTF-8). */
  rawName?: Uint8Array;
  /** Override the size field (to make an entry run past the end). */
  sizeField?: number;
  /** Override the magic field (e.g. "" for pre-POSIX v7 headers). */
  magic?: string;
}

const enc = new TextEncoder();

function put(buf: Uint8Array, off: number, len: number, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? enc.encode(value) : value;
  buf.set(bytes.subarray(0, len), off);
}

function octal(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, "0")}\0`;
}

export function paxRecords(records: Record<string, string>): string {
  let out = "";
  for (const [k, v] of Object.entries(records)) {
    const body = ` ${k}=${v}\n`;
    let len = body.length + 1;
    while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
    out += `${len}${body}`;
  }
  return out;
}

export function header(spec: TarSpec, size: number): Uint8Array {
  const h = new Uint8Array(512);
  put(h, 0, 100, spec.rawName ?? spec.name);
  put(h, 100, 8, octal(0o644, 8));
  put(h, 108, 8, octal(0, 8));
  put(h, 116, 8, octal(0, 8));
  const sizeValue = spec.sizeField ?? size;
  if (spec.base256) {
    h[124] = 0x80;
    let v = sizeValue;
    for (let i = 135; i > 124; i -= 1) {
      h[i] = v % 256;
      v = Math.floor(v / 256);
    }
  } else put(h, 124, 12, octal(sizeValue, 12));
  put(h, 136, 12, octal(1_700_000_000, 12));
  put(h, 148, 8, "        ");
  const type = spec.type ?? (spec.name.endsWith("/") ? "5" : "0");
  put(h, 156, 1, type);
  put(h, 157, 100, spec.linkname ?? "");
  put(h, 257, 6, spec.magic ?? "ustar\0");
  put(h, 263, 2, "00");
  put(h, 345, 155, spec.prefix ?? "");
  let sum = 0;
  for (const b of h) sum += b;
  if (spec.badChecksum) sum += 1;
  put(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** Recompute the checksum of the header at `off` after patching it by hand. */
export function fixChecksum(buf: Uint8Array, off = 0): void {
  put(buf, off + 148, 8, "        ");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += buf[off + i]!;
  put(buf, off + 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
}

export function tar(entries: TarSpec[], opts: { trailer?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const body = e.body === undefined ? new Uint8Array(0) : typeof e.body === "string" ? enc.encode(e.body) : e.body;
    parts.push(header(e, body.length));
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    parts.push(padded);
  }
  if (opts.trailer !== false) parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function tarGz(entries: TarSpec[]): Uint8Array {
  return new Uint8Array(gzipSync(tar(entries)));
}

/** A codeload-style tarball: pax global header, "<root>/" folder, then the files. */
export function repoTarball(files: Record<string, string | Uint8Array>, root = "repo-0123abc", extra: TarSpec[] = []): Uint8Array {
  const entries: TarSpec[] = [
    { name: "pax_global_header", type: "g", body: paxRecords({ comment: "0123abc0123abc0123abc0123abc0123abc0123" }) },
    { name: `${root}/` },
  ];
  const dirs = new Set<string>();
  for (const path of Object.keys(files).sort()) {
    const segs = path.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      const d = segs.slice(0, i).join("/");
      if (!dirs.has(d)) {
        dirs.add(d);
        entries.push({ name: `${root}/${d}/` });
      }
    }
    entries.push({ name: `${root}/${path}`, body: files[path]! });
  }
  return tarGz([...entries, ...extra.map((e) => ({ ...e, name: e.name.startsWith("/") || e.rawName ? e.name : `${root}/${e.name}` }))]);
}
