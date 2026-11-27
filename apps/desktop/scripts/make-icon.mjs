// Write a simple 1024x1024 placeholder app icon as PNG, with no dependencies.
// Then `tauri icon src-tauri/icons/source.png -o src-tauri/icons` makes the full set
// (PNG sizes, icon.ico, icon.icns). Run both with `pnpm icons`.
//
// The icon: a rounded square with a vertical indigo gradient and a white "seat"
// glyph (a back rest and a seat). Replace source.png with real art before release.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;

/** CRC-32 for PNG chunks. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Encode RGBA pixels (Uint8Array, width*height*4) as a PNG buffer. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Coverage (0..1) of a rounded rectangle at pixel centre (x, y), 1px anti-aliasing. */
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const d = Math.hypot(x - cx, y - cy) - r;
  return Math.min(Math.max(0.5 - d, 0), 1);
}

export function drawIcon(size = SIZE) {
  const px = new Uint8Array(size * size * 4);
  const s = size / 1024;
  const top = [79, 70, 229]; // indigo-600
  const bottom = [49, 46, 129]; // indigo-900
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const bg = top.map((c, i) => Math.round(c + (bottom[i] - c) * t));
    for (let x = 0; x < size; x++) {
      const X = x + 0.5;
      const Y = y + 0.5;
      const base = roundRect(X, Y, 64 * s, 64 * s, 960 * s, 960 * s, 200 * s);
      if (base <= 0) continue;
      // Seat glyph: back rest + seat + two legs.
      const glyph = Math.max(
        roundRect(X, Y, 330 * s, 240 * s, 450 * s, 640 * s, 48 * s),
        roundRect(X, Y, 330 * s, 560 * s, 720 * s, 670 * s, 48 * s),
        roundRect(X, Y, 340 * s, 600 * s, 420 * s, 800 * s, 36 * s),
        roundRect(X, Y, 630 * s, 600 * s, 710 * s, 800 * s, 36 * s),
      );
      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(bg[i] * (1 - glyph) + 255 * glyph);
      px[o + 3] = Math.round(255 * base);
    }
  }
  return encodePng(size, size, px);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = process.argv[2] ?? join(here, "..", "src-tauri", "icons", "source.png");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, drawIcon());
  console.log(`icon -> ${out}`);
}
