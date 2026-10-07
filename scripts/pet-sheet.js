// `node scripts/pet-sheet.js [out.svg] [--animals]` — every species Tokkie can make, each as Hatchling → Junior →
// Champion → Mega, on one sheet. Writes an SVG (open it in a browser, or convert with any image tool).
const fs = require('fs');
const path = require('path');
const M = require('../src/core/monster');

const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..', 'docs', 'pet-sheet.svg');
const onlyAnimals = process.argv.includes('--animals');
const S = 4, SW = (M.W + 2) * S, SH = (M.H + 2) * S, PAD = 14, COLS = 3, LABEL = 18;
const CELL_W = SW * 4 + PAD, CELL_H = SH + LABEL + PAD;

const sections = [
  ['Monsters', M.allSpecies().filter((k) => !k.startsWith('beast:') && !k.startsWith('special:'))],
  ['Animals', M.allSpecies().filter((k) => k.startsWith('beast:'))],
  ['Secret pets (1 in 100, or a code)', M.allSpecies().filter((k) => k.startsWith('special:'))],
].filter(([t]) => !onlyAnimals || t === 'Animals');
// animals: show a few individuals of each kind so the variety is visible
if (onlyAnimals) sections[0][1] = M.BEAST_KINDS.flatMap((k) => [0, 1, 2].map((i) => `beast:${k}#${i}`));

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let y = 60, body = '';
for (const [title, keys] of sections) {
  body += `<text x="${PAD}" y="${y}" class="h">${esc(title)} · ${keys.length}</text>`; y += 16;
  keys.forEach((key, i) => {
    const [k, n] = key.split('#');
    const seed = n != null ? `${k}:${n}` : M.sampleSeed(k);
    const base = M.generate(seed);
    const ox = PAD + (i % COLS) * CELL_W, oy = y + Math.floor(i / COLS) * CELL_H;
    body += `<text x="${ox}" y="${oy + 13}" class="l">${esc(M.speciesName(k))} <tspan class="n">${esc(base.name)}</tspan></text>`;
    [1, 2, 3, 4].forEach((stage, j) => {
      const f = M.compose(M.evolveSpec(base, stage, 0), {});
      const fx = ox + j * SW, fy = oy + LABEL;
      for (const c of [...f.outline, ...f.cells]) body += `<rect x="${fx + (c.x + 1) * S}" y="${fy + (c.y + 1) * S}" width="${S}" height="${S}" fill="${c.c}"/>`;
    });
  });
  y += Math.ceil(keys.length / COLS) * CELL_H + 20;
}
const width = PAD * 2 + COLS * CELL_W, height = y;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">
<style>text{font-family:-apple-system,"Segoe UI",sans-serif;fill:#2a2a33}.t{font-size:22px;font-weight:700}.s{font-size:12px;fill:#777}.h{font-size:15px;font-weight:700}.l{font-size:11.5px;font-weight:600}.n{font-weight:400;fill:#888}</style>
<rect width="100%" height="100%" fill="#f6f6f8"/>
<text x="${PAD}" y="30" class="t">Tokkie — every species</text><text x="${PAD}" y="47" class="s">Each shown as Hatchling → Junior → Champion → Mega. Colours, sizes, eyes, arms and markings vary on top of these.</text>
${body}</svg>`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, svg);
console.log(`${out} (${width}×${height})`);
