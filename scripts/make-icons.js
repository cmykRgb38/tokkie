// Renders the brand mascot into assets/icon.png (1024²) with a tiny dependency-free PNG encoder.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { generate, compose } = require('../src/core/monster');

const SEED = 'larrie-11', SIZE = 1024, BG = [27, 26, 33], BG2 = [38, 36, 46];

function crc32(buf) { let c, crc = ~0; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

const buf = Buffer.alloc(SIZE * SIZE * 4);
const R = SIZE * 0.225, inset = SIZE * 0.06;      // macOS-style squircle-ish rounded square
const inside = (x, y) => { const lo = inset, hi = SIZE - inset; if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = x < lo + R ? lo + R : x > hi - R ? hi - R : x, cy = y < lo + R ? lo + R : y > hi - R ? hi - R : y; return (x - cx) ** 2 + (y - cy) ** 2 <= R * R; };
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  if (!inside(x, y)) continue;
  const t = y / SIZE, i = (y * SIZE + x) * 4;
  for (let c = 0; c < 3; c++) buf[i + c] = Math.round(BG2[c] * (1 - t) + BG[c] * t);
  buf[i + 3] = 255;
}
const spec = generate(SEED), f = compose(spec, { mouth: 'smile' });
const all = [...f.outline, ...f.cells];
const x0 = Math.min(...all.map((c) => c.x)), x1 = Math.max(...all.map((c) => c.x)), y0 = Math.min(...all.map((c) => c.y)), y1 = Math.max(...all.map((c) => c.y));
const S = Math.floor((SIZE * 0.68) / Math.max(x1 - x0 + 1, y1 - y0 + 1));
const ox = Math.round((SIZE - (x1 - x0 + 1) * S) / 2), oy = Math.round((SIZE - (y1 - y0 + 1) * S) / 2);
for (const c of all) {
  const [r, g, b] = hex(c.c);
  for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) { const i = (((oy + (c.y - y0) * S + dy) * SIZE) + ox + (c.x - x0) * S + dx) * 4; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255; }
}
fs.mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), png(SIZE, SIZE, buf));
console.log('wrote assets/icon.png', spec.name, spec.traits.join(' · '));
