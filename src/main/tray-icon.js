'use strict';
const { compose, W, H } = require('../core/monster');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** Render a monster to a raw BGRA bitmap (2×) for the tray icon — no image assets needed. */
function trayBitmap(spec, scale = 2) {
  const f = compose(spec, { eye: 'open', mouth: 'smile' });
  const xs = [...f.cells, ...f.outline].map((c) => c.x), ys = [...f.cells, ...f.outline].map((c) => c.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const size = 16 * scale; // square canvas keeps the menu-bar slot consistent
  const buf = Buffer.alloc(size * size * 4);
  const sw = (x1 - x0 + 1) * scale, sh = (y1 - y0 + 1) * scale;
  const ox = Math.floor((size - sw) / 2), oy = Math.floor((size - sh) / 2);
  for (const c of [...f.outline, ...f.cells]) {
    const [r, g, b] = c.c.startsWith('#') ? hex(c.c) : [0, 0, 0];
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const px = ox + (c.x - x0) * scale + dx, py = oy + (c.y - y0) * scale + dy;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const i = (py * size + px) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;
    }
  }
  return { buffer: buf, width: size, height: size };
}

module.exports = { trayBitmap };
