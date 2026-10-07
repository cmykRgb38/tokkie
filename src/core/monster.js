'use strict';
/**
 * Procedural pixel-monster generator. A seed string always yields the same monster.
 * Everything is built on a half-width grid and mirrored, so every creature is symmetric and cute by construction.
 * The sprite is returned as layered parts; `compose()` assembles one animation frame from a pose.
 */
const W = 17, H = 15, CX = 8, GROUND = H - 1;

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function rng(seed) { return mulberry32(xmur3(String(seed))()); }

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ---- colour ---------------------------------------------------------------------------------
function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function makePalette(r) {
  // Avoid the muddy olive band; keep everything saturated and friendly.
  const hue = pick(r, [8, 14, 22, 32, 48, 140, 160, 174, 190, 205, 225, 255, 275, 295, 315, 335, 350]) + int(r, -6, 6);
  const sat = int(r, 58, 78);
  const l = int(r, 56, 64);
  const accentHue = pick(r, [hue + 150, hue + 180, hue + 210, hue + 40]);
  return {
    body: hsl(hue, sat, l), light: hsl(hue, sat - 10, l + 13), shade: hsl(hue + 8, sat, l - 14),
    outline: hsl(hue + 12, sat - 8, 17), accent: hsl(accentHue, 72, 62), accentDark: hsl(accentHue, 60, 40),
    eye: '#fdfbf7', pupil: '#1d1722', mouth: hsl(hue + 10, 55, 16), tongue: '#ff8fa3', fang: '#fdfbf7', ground: 'rgba(0,0,0,0.18)',
  };
}

// ---- anatomy --------------------------------------------------------------------------------
const SHAPES = {
  box:   { name: 'Boxy',   delta: (h) => Array.from({ length: h }, (_, r) => (r === 0 || r === h - 1 ? -1 : 0)) },
  dome:  { name: 'Domed',  delta: (h) => Array.from({ length: h }, (_, r) => (r === 0 ? -3 : r === 1 ? -1 : 0)) },
  pear:  { name: 'Pear',   delta: (h) => Array.from({ length: h }, (_, r) => -Math.max(0, Math.round((h - 1 - r) * 0.45))) },
  blob:  { name: 'Blobby', delta: (h) => Array.from({ length: h }, (_, r) => (r === 0 ? -2 : r === h - 1 ? -1 : r < h / 2 ? 0 : 0)) },
  tank:  { name: 'Chunky', delta: (h) => Array.from({ length: h }, () => 0) },
};
const TOPS = ['none', 'ears', 'horns', 'antenna', 'twin', 'tuft'];     // 'crown' exists too, but only on Mega forms
const ARMS = ['none', 'nubs', 'claws'];
const EYES = ['pill', 'square', 'big', 'cyclops', 'trio', 'visor'];
const MARKS = ['none', 'belly', 'spots', 'stripes', 'cheeks'];
const MOUTHS = ['smile', 'fangs', 'wide'];

const SYL_A = ['Blo', 'Zib', 'Mun', 'Gor', 'Pix', 'Fuz', 'Nib', 'Quo', 'Dra', 'Bop', 'Wum', 'Tok', 'Yip', 'Glo', 'Snu', 'Krim', 'Plo', 'Zap', 'Mog', 'Fli', 'Bru', 'Chi', 'Nok'];
const SYL_B = ['rp', 'bit', 'mo', 'zle', 'nk', 'bo', 'ggle', 'ps', 'rb', 'lo', 'ffin', 'ddy', 'mble', 'nt', 'wl', 'ck', 'zo'];

const SYL_M = ['a', 'i', 'o', 'u', 'ee', 'oo', 'ar', 'el', 'im', 'on', 'ub', 'ix'];
/** Seeds from Tokkie ≤1.0.18 (the username signature, and rerolls 'r' + 8 chars) keep the name they always had. */
const isLegacySeed = (seed) => /^you:[^:]*$/.test(seed) || /^r[a-z0-9]{8}$/.test(seed);
/** ~391 names for legacy seeds; newer seeds may also get a middle syllable: ~5,000 names. */
function makeName(r, seed) {
  const a = pick(r, SYL_A), b = pick(r, SYL_B);
  if (isLegacySeed(String(seed))) return a + b;
  return r() < 0.6 ? a + pick(r, SYL_M) + b : a + b;
}

/** Build the creature description for a seed. Deterministic. */
function generate(seed) {
  const r = rng(seed);
  const palette = makePalette(r);
  const shapeKey = pick(r, Object.keys(SHAPES));
  const hw = int(r, 4, 6);                    // body half-width (full = 2*hw+1)
  const bodyH = int(r, Math.min(7, Math.max(5, hw + 1)), 7);   // never flatter than it is wide: keeps every creature cute, not squashed
  const top = pick(r, TOPS), arms = pick(r, ARMS), eyes = pick(r, EYES), marks = pick(r, MARKS), mouth = pick(r, MOUTHS);
  const legsN = pick(r, [2, 4, 4]);
  const legLen = int(r, 1, 2);
  const eyeGap = Math.min(hw - 2, int(r, 1, 3));
  const seedMarks = { spots: Array.from({ length: 3 }, () => [int(r, 1, hw - 1), int(r, 1, bodyH - 3)]) };

  const topH = { none: 0, ears: 2, horns: 3, antenna: 3, twin: 3, tuft: 2, crown: 2 }[top];
  const y0 = GROUND - legLen - bodyH + 1;      // top row of the body
  const deltas = SHAPES[shapeKey].delta(bodyH);
  const rows = deltas.map((d) => Math.max(2, hw + d));

  return { seed: String(seed), name: makeName(r, seed), palette, shape: shapeKey, hw, bodyH, y0, rows, top, topH, arms, eyes, marks, mouth, legsN, legLen, eyeGap, seedMarks,
    traits: [SHAPES[shapeKey].name, top !== 'none' ? ({ ears: 'Eared', horns: 'Horned', antenna: 'Antennaed', twin: 'Twin-antenna', tuft: 'Tufted' }[top]) : null,
      ({ cyclops: 'Cyclops', trio: 'Three-eyed', visor: 'Visored' }[eyes] || null), legsN === 4 ? 'Four-legged' : 'Two-legged'].filter(Boolean) };
}

// ---- sprite assembly ------------------------------------------------------------------------
const key = (x, y) => y * 64 + x;

/** Pixel map helper: set/get cells with colour strings, mirrored about the centre column. */
class Grid {
  constructor() { this.m = new Map(); }
  set(x, y, c) { if (x >= 0 && x < W && y >= 0 && y < H) this.m.set(key(x, y), c); }
  mirror(hx, y, c) { this.set(CX + hx, y, c); this.set(CX - hx, y, c); }
  get(x, y) { return this.m.get(key(x, y)); }
  has(x, y) { return this.m.has(key(x, y)); }
  cells() { return [...this.m].map(([k, c]) => ({ x: k % 64, y: Math.floor(k / 64), c })); }
}

function bodyCells(spec) {
  const cells = new Set();
  spec.rows.forEach((w, i) => { for (let hx = 0; hx <= w; hx++) { cells.add(`${hx},${spec.y0 + i}`); } });
  return cells;
}

function buildStatic(spec, bodyShift) {
  const p = spec.palette;
  const g = new Grid();
  const y0 = spec.y0 + bodyShift;
  const bodyBottom = y0 + spec.bodyH - 1;
  const rowW = (i) => spec.rows[i];

  // body fill with simple top-left light / bottom shade
  spec.rows.forEach((w, i) => {
    for (let hx = 0; hx <= w; hx++) {
      let c = p.body;
      if (i === spec.bodyH - 1) c = p.shade;
      else if (hx === w && i > 0) c = p.shade;
      g.mirror(hx, y0 + i, c);
    }
  });
  // highlight (screen-space left, so lighting is consistent rather than mirrored)
  const hl = (hx, i) => { if (rowW(i) >= hx) g.set(CX - hx, y0 + i, p.light); };
  hl(Math.max(1, rowW(1) - 1), 1); hl(Math.max(1, rowW(1)), 1); if (spec.bodyH > 5) hl(rowW(2), 2);

  // markings
  const mid = Math.floor(spec.bodyH / 2);
  if (spec.marks === 'belly') {
    for (let i = mid; i < spec.bodyH - 1; i++) for (let hx = 0; hx <= Math.min(2, rowW(i) - 2); hx++) g.mirror(hx, y0 + i, p.light);
  } else if (spec.marks === 'spots') {
    for (const [hx, i] of spec.seedMarks.spots) if (hx <= rowW(i) - 1 && i < spec.bodyH - 1) g.mirror(hx, y0 + i, p.accent);
  } else if (spec.marks === 'stripes') {
    for (let i = 2; i < spec.bodyH - 1; i += 2) for (let hx = 0; hx <= rowW(i) - 1; hx++) g.mirror(hx, y0 + i, p.shade);
  }

  // top features
  const w0 = rowW(0), top = y0;
  if (spec.top === 'ears') { for (const hx of [w0, w0 - 1]) for (const dy of [1, 2]) g.mirror(hx, top - dy, p.body); g.mirror(w0 - 1, top - 1, p.accent); }
  else if (spec.top === 'horns') { g.mirror(w0 - 1, top - 1, p.accent); g.mirror(w0 - 1, top - 2, p.accent); g.mirror(w0, top - 2, p.accent); }
  else if (spec.top === 'antenna') { g.mirror(0, top - 1, p.shade); g.mirror(0, top - 2, p.shade); for (const hx of [0, 1]) g.mirror(hx, top - 3, p.accent); }
  else if (spec.top === 'twin') { const hx = Math.min(2, w0 - 1); g.mirror(hx, top - 1, p.shade); g.mirror(hx, top - 2, p.shade); g.mirror(hx, top - 3, p.accent); }
  else if (spec.top === 'tuft') { for (const hx of [0, 1]) g.mirror(hx, top - 1, p.shade); g.mirror(0, top - 2, p.shade); }
  else if (spec.top === 'crown') { for (const hx of [0, 1, 2]) g.mirror(hx, top - 1, '#ffd166'); g.mirror(2, top - 1, '#e0a800'); g.mirror(0, top - 1, p.accent); for (const hx of [0, 2]) g.mirror(hx, top - 2, '#ffd166'); g.mirror(1, top - 2, '#e0a800'); g.set(CX, top - 2, '#ffd166'); }

  // arms
  if (spec.arms !== 'none') {
    const ay = y0 + Math.max(2, spec.bodyH - 4);
    const aw = rowW(ay - y0);
    g.mirror(aw + 1, ay, p.body);
    if (spec.arms === 'claws') { g.mirror(aw + 1, ay + 1, p.body); g.mirror(aw + 2, ay + 1, p.shade); }
  }
  return { g, y0, bodyBottom };
}

/** Rows the eyes occupy (open). Mouth placement is derived from this so features never collide. */
function eyeH(spec) {
  if (spec.eyes === 'cyclops') return 3;
  if (spec.eyes === 'big' || spec.eyes === 'trio') return spec.bodyH - 3 < 3 ? 2 : 3;
  return 2;
}
function eyeY(spec, y0) { return y0 + Math.max(1, Math.floor(spec.bodyH * 0.28)); }
/** One clear row under the eyes when it fits; otherwise as low as the body allows (smile corners are then dropped). */
function mouthY(spec, y0) { return Math.min(y0 + spec.bodyH - 2, eyeY(spec, y0) + eyeH(spec) + 1); }
const mouthHasRoomForCorners = (spec, y0) => mouthY(spec, y0) - 1 > eyeY(spec, y0) + eyeH(spec) - 1;

/**
 * Eyes. States: open | closed | happy | angry | bored | wide | love | wink.
 * Every style tracks `pose.look` (dark eyes slide sideways, white eyes move their pupils, the visor's glow scans).
 * All writes are clipped to existing body cells, so no expression can ever float outside the silhouette.
 */
function drawEyes(spec, g, y0, pose) {
  const p = spec.palette, ey = eyeY(spec, y0), gap = spec.eyeGap, st = spec.eyes, state = pose.eye || 'open';
  const look = pose.look || { x: 0, y: 0 };
  const lx = Math.max(-1, Math.min(1, Math.round(look.x))), ly = Math.max(-1, Math.min(1, Math.round(look.y)));
  const put = (x, y, c) => { if (g.has(x, y)) g.set(x, y, c); };
  const closedState = state === 'closed' || state === 'happy';

  if (st === 'visor') {
    const w = Math.min(spec.rows[Math.max(0, ey - y0)] - 1, gap + 2);
    const glow = state === 'angry' ? '#ff6b5e' : p.accent;
    for (let hx = 0; hx <= w; hx++) g.mirror(hx, ey, p.pupil);
    if (state === 'love') { put(CX - w, ey + 1, '#ff8fb3'); put(CX + w, ey + 1, '#ff8fb3'); return; }
    if (closedState || state === 'bored') return;                // lights off / half-lidded
    if (state === 'wide') for (let hx = 0; hx <= w; hx++) { const x1 = CX - hx, x2 = CX + hx; put(x1, ey - 1, p.pupil); put(x2, ey - 1, p.pupil); }  // surprised: taller visor
    for (let hx = 0; hx <= w; hx++) g.mirror(hx, ey + 1, hx === 0 || (hx + lx + 3 + pose.frame) % 3 === 0 ? glow : p.pupil);
    if (state === 'angry') for (let hx = 1; hx <= w; hx++) g.mirror(hx, ey - 1, p.pupil);
    return;
  }

  const dark = st === 'pill' || st === 'square';
  const h = eyeH(spec);
  let eyes;
  if (st === 'cyclops') eyes = [{ x: CX - 1, y: ey, w: 3, h: 3 }];
  else if (st === 'big' || st === 'trio') eyes = [{ x: CX - gap - 1, y: ey, w: 2, h }, { x: CX + gap, y: ey, w: 2, h }];
  else if (st === 'pill') eyes = [{ x: CX - gap, y: ey, w: 1, h: 2 }, { x: CX + gap, y: ey, w: 1, h: 2 }];
  else eyes = [{ x: CX - gap - 1, y: ey, w: 2, h: 2 }, { x: CX + gap, y: ey, w: 2, h: 2 }];

  eyes.forEach((e, idx) => {
    const side = e.x + e.w - 1 < CX ? -1 : e.x > CX ? 1 : 0;   // which side of the face; inner = toward the centre
    const inner = -side;
    const shut = closedState || (state === 'wink' && idx === 0);
    if (shut) { for (let i = 0; i < e.w; i++) put(e.x + i, e.y + Math.floor(e.h / 2), p.pupil); return; }
    if (state === 'love') {                                       // blissful closed eyes + blush
      for (let i = 0; i < e.w; i++) put(e.x + i, e.y + Math.floor(e.h / 2), p.pupil);
      if (side !== 0) put(side < 0 ? e.x - 1 : e.x + e.w, e.y + Math.floor(e.h / 2) + 1, '#ff8fb3');
      return;
    }
    const lid = state === 'bored' ? 1 : 0;                        // heavy lids hide the top row
    const extra = state === 'wide' ? 1 : 0;                       // surprised: eyes grow a row
    const x0 = e.x + (dark ? lx : 0);
    for (let dy = lid; dy < e.h + extra; dy++) for (let dx = 0; dx < e.w; dx++) put(x0 + dx, e.y + dy, dark ? p.pupil : p.eye);
    if (dark && st === 'square' && !lid && state !== 'angry') put(x0, e.y, p.eye);          // glint
    if (!dark) {
      const cxp = Math.max(0, Math.min(e.w - 1, Math.floor((e.w - 1) / 2) + lx));
      const cyp = Math.max(lid, Math.min(e.h - 1, Math.floor((e.h - 1) / 2) + ly));
      const px = e.x + cxp, py = e.y + cyp;
      put(px, py, p.pupil);
      if (state !== 'wide' && e.w >= 3 && e.h >= 3) put(px, py + (py + 1 < e.y + e.h ? 1 : 0), p.pupil);
      else if (state !== 'wide' && e.h >= 3 && e.w === 2) put(px, Math.min(e.y + e.h - 1, py + 1), p.pupil);
    }
    if (state === 'angry') {                                      // brow slants down toward the nose
      if (inner === 0) { for (const x of [CX - 2, CX - 1, CX + 1, CX + 2]) put(x, e.y - 1, p.pupil); put(CX, e.y, p.pupil); }
      else {
        const outerX = inner > 0 ? e.x : e.x + e.w - 1;             // outer end high, inner end low:  ‾‾\  (mirrored on the other eye)
        for (let i = 0; i < e.w; i++) put(outerX + inner * i, e.y - 1, p.pupil);
        put(outerX + inner * e.w, e.y, p.pupil);
      }
    } else if (state === 'wide') {
      for (let i = 0; i < e.w; i++) put(e.x + i, e.y - 1, p.shade);        // raised brows
    }
  });
  if (st === 'trio' && (state === 'open' || state === 'wide' || state === 'angry')) put(CX, ey - 1, p.pupil);
}

function drawMouth(spec, g, y0, pose) {
  const p = spec.palette, my = mouthY(spec, y0), mh = Math.min(spec.rows[Math.max(0, my - y0)] - 2, spec.mouth === 'wide' || spec.mouth === 'fangs' ? 2 : 1);
  const m = pose.mouth || 'smile';
  const wide = Math.max(0, mh);
  if (m === 'smile' || m === 'flat' || m === 'sad') {
    for (let hx = 0; hx <= wide; hx++) g.mirror(hx, my, p.mouth);
    if (m === 'smile' && wide >= 1 && mouthHasRoomForCorners(spec, y0)) g.mirror(wide, my - 1, p.mouth);
    if (m === 'sad' && wide >= 1) g.mirror(wide, my + 1, p.mouth);
    if (spec.mouth === 'fangs' && m !== 'sad') g.mirror(Math.max(1, wide - 1), my + 1, p.fang);
  } else if (m === 'grit') {
    for (let hx = 0; hx <= Math.max(1, wide); hx++) g.mirror(hx, my, hx % 2 === 0 ? p.fang : p.mouth);
  } else if (m === 'tongue') {
    for (let hx = 0; hx <= wide; hx++) g.mirror(hx, my, p.mouth);
    if (wide >= 1 && mouthHasRoomForCorners(spec, y0)) g.mirror(wide, my - 1, p.mouth);
    g.mirror(0, my + 1, p.tongue); if (wide >= 1) g.set(CX + 1, my + 1, p.tongue);
  } else if (m === 'o') {
    g.mirror(0, my, p.mouth); g.mirror(0, my + 1, p.mouth);
  } else { // open / chew
    const ow = m === 'open' ? Math.max(1, wide + 1) : Math.max(0, wide);
    const oh = m === 'open' ? 2 : 1;
    for (let dy = 0; dy < oh; dy++) for (let hx = 0; hx <= ow; hx++) g.mirror(hx, my + dy, p.mouth);
    if (m === 'open') g.mirror(0, my + 1, p.tongue);
    if (spec.mouth === 'fangs') g.mirror(ow, my, p.fang);
  }
}

/**
 * Assemble one frame.
 * pose: {frame:0|1, bob:-1|0|1, eye:'open'|'closed'|'happy', mouth, look:{x,y}, squash:0|1}
 * Returns {w,h,cells:[{x,y,c}], outline:[{x,y,c}], shadow:{...}}.
 */
function compose(spec, pose = {}) {
  pose = { frame: 0, bob: 0, eye: 'open', mouth: 'smile', look: { x: 0, y: 0 }, ...pose };
  const p = spec.palette;
  const bob = Math.max(-1, Math.min(1, pose.bob | 0));
  const { g, y0, bodyBottom } = buildStatic(spec, bob);

  // legs reach from body to ground; walking frames shorten alternate legs
  const legXs = spec.legsN === 4 ? [1, Math.max(2, spec.hw - 1)] : [Math.max(1, spec.hw - 2)];
  legXs.forEach((hx, idx) => {
    const lift = pose.frame === 1 && (idx % 2 === 0) ? 1 : 0;
    for (let y = bodyBottom + 1; y <= GROUND - lift; y++) g.mirror(hx, y, y === GROUND - lift ? p.shade : p.body);
  });

  drawEyes(spec, g, y0, pose);
  drawMouth(spec, g, y0, pose);

  // 1px outline around the whole silhouette: the pixel-art look that makes it feel finished
  const outline = [];
  const seen = new Set();
  for (const { x, y } of g.cells()) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = key(nx, ny);
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || g.has(nx, ny) || seen.has(k)) continue;
      seen.add(k); outline.push({ x: nx, y: ny, c: p.outline });
    }
  }
  return { w: W, h: H, cells: g.cells(), outline, ground: GROUND };
}

const TOP_UPGRADE = { none: 'horns', ears: 'horns', horns: 'twin', antenna: 'twin', twin: 'horns', tuft: 'ears' };

/**
 * The creature at a given evolution stage (1 Hatchling · 2 Junior = the generated creature · 3 Champion · 4 Mega)
 * and chub level (0–2). Pure function of the base spec, so a seed always evolves the same way.
 */
function evolveSpec(base, stage = 2, fat = 0) {
  stage = Math.max(1, Math.min(4, stage | 0)); fat = Math.max(0, Math.min(2, fat | 0));
  if (stage === 2 && fat === 0) return base;
  let hw = base.hw, bodyH = base.bodyH, top = base.top, arms = base.arms, marks = base.marks, eyes = base.eyes, mouth = base.mouth, legsN = base.legsN, legLen = base.legLen;
  if (stage === 1) { hw = 3; bodyH = 5; top = base.top === 'none' ? 'none' : 'tuft'; arms = 'none'; legsN = 2; legLen = 1; eyes = 'big'; mouth = 'smile'; marks = marks === 'stripes' ? 'cheeks' : marks; }
  if (stage === 3) { hw = Math.min(6, base.hw + 1); bodyH = Math.min(8, base.bodyH + 1); arms = base.arms === 'none' ? 'nubs' : 'claws'; top = TOP_UPGRADE[base.top]; marks = marks === 'none' ? 'spots' : marks; }
  if (stage === 4) { hw = 6; bodyH = 8; arms = 'claws'; top = 'crown'; legsN = 4; legLen = 2; marks = marks === 'none' ? 'belly' : marks; }
  if (fat > 0 && marks === 'none') marks = 'belly';
  // The belly bulges up to the canvas edge (7), except on the row where arms attach, which must leave room for them.
  const armRow = Math.max(2, bodyH - 4), armCap = arms === 'claws' ? 6 : 7;
  const rows = SHAPES[base.shape].delta(bodyH).map((d, i, a) => {
    const w = Math.max(2, hw + d), belly = i > 0 && i < a.length - 1 ? fat : 0;
    return Math.min(arms !== 'none' && i === armRow ? armCap : 7, w + belly);
  });
  const topH = { none: 0, ears: 2, horns: 3, antenna: 3, twin: 3, tuft: 2, crown: 2 }[top];
  const spots = { spots: Array.from({ length: 3 }, (_, i) => [Math.min(hw - 1, 1 + ((i * 2 + base.seed.length) % Math.max(1, hw - 1))), 1 + ((i + 1) % Math.max(1, bodyH - 3))]) };
  return { ...base, stage, fat, hw, bodyH, y0: GROUND - legLen - bodyH + 1, rows, top, topH, arms, marks, eyes, mouth, legsN, legLen, eyeGap: Math.max(1, Math.min(hw - 2, base.eyeGap)), seedMarks: marks === 'spots' ? spots : base.seedMarks };
}

/** Quick structural checks used by tests and the generator UI to guarantee every monster is presentable. */
function silhouetteOf(frame) {
  const s = new Set();
  for (const c of frame.cells) s.add(key(c.x, c.y));
  return s;
}

/** Key anchor points (sprite grid coordinates) so overlays — crumbs, sweat, zzz — can line up with the face. */
function anchors(spec, bob = 0) {
  const y0 = spec.y0 + bob;
  return { mouth: { x: CX, y: mouthY(spec, y0) }, eyeY: eyeY(spec, y0), top: y0 - spec.topH, side: CX + spec.hw + 1, hueDeg: hueOf(spec.palette.body) };
}
function hueOf(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}

const api = { W, H, CX, GROUND, rng, generate, compose, silhouetteOf, hsl, key, anchors, evolveSpec };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else self.TokkieMonster = api;
