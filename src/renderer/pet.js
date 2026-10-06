/* Pixel pet renderer + animation state machine.
   Draws on a small integer grid (scene cells), scaled up with nearest-neighbour — crisp at any DPI.

   Base moods come from the app (what Claude is doing): idle · work · stress · angry · hungry · sleep · bored · done.
   Transient "emotes" layer on top for interactivity: surprised · love · playful · angry (annoyed) · done · sleep… */
const M = window.TokkieMonster;
export const SCENE_W = 25, SCENE_H = 20, OX = 4, OY = 5; // sprite sits at (OX,OY) inside the scene grid

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const Z = ['#####', '...#.', '..#..', '.#...', '#####'];
const HEART = ['#.#', '###', '.#.'];
const SPARK = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const HOP = [0, 2, 3, 3, 2, 1, 0, 1, 0, 0];
const BANG = ['##', '##', '##', '##', '..', '##'];
const QMARK = ['.##.', '#..#', '..#.', '.#..', '....', '.#..'];
export const EMOTES = ['done', 'playful', 'love', 'surprised', 'angry', 'bored', 'sleep'];
// Emotes that only make sense when the pet isn't busy working.
const IDLE_ONLY = new Set(['love', 'playful', 'bored']);

export class Pet {
  /** @param {HTMLCanvasElement} canvas  @param {{scale?:number, spriteOnly?:boolean}} [opts] */
  constructor(canvas, opts = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.scale = opts.scale || 5;
    this.sprite = !!opts.spriteOnly;       // previews crop to the sprite itself
    this.spec = null; this.baseSpec = null; this.form = { stage: 2, fat: 0 }; this.evo = null; this.locked = false; this.base = 'idle'; this.override = null; this.tick = 0;
    this.particles = []; this.look = { x: 0, y: 0 }; this.hopT = -1; this.blinkAt = 2500; this.blinkUntil = 0;
    this.intensity = 1; this.timer = null; this.visible = true;
    this.clicks = []; this.nextPlay = performance.now() + 25000 + Math.random() * 25000;
    this.fit();
  }

  fit() {
    const w = this.sprite ? M.W + 2 : SCENE_W, h = this.sprite ? M.H + 2 : SCENE_H;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.cell = Math.max(1, Math.round(this.scale * dpr));   // integer device px per cell keeps edges crisp
    this.cv.width = w * this.cell; this.cv.height = h * this.cell;
    this.cv.style.width = (w * this.cell) / dpr + 'px'; this.cv.style.height = (h * this.cell) / dpr + 'px';
    this.ctx.imageSmoothingEnabled = false;
  }
  setScale(s) { this.scale = s; this.fit(); this.draw(); }
  setSeed(seed) { this.baseSpec = M.generate(seed); this._rebuild(); this.particles = []; this.draw(); return this.spec; }
  _rebuild() { if (!this.baseSpec) return; this.spec = M.evolveSpec(this.baseSpec, this.form.stage, this.form.fat); this.anch = M.anchors(this.spec); }
  /** Show a form immediately (no animation). */
  setForm(stage, fat = 0) { this.form = { stage, fat }; this._rebuild(); this.draw(); }
  /** Digimon-style: flicker white, flash, pop out as the new form with a burst of sparkles. */
  evolveTo(stage, fat = 0) {
    if (!this.spec) return;
    if (reduce.matches) { this.setForm(stage, fat); return; }
    this.evo = { t: 0, stage, fat, from: this.spec };
  }
  /** Unlocked-form teaser: draw as a dark silhouette. */
  setLocked(v) { this.locked = v; this.draw(); }

  /** The mood the app says we're in; emotes can temporarily take over. */
  setMood(m) {
    if (m === this.base) return;
    const prev = this.base; this.base = m;
    if (m === 'done' && prev !== 'done') this.celebrate();
  }
  get mood() {
    if (this.override && performance.now() < this.override.until) return this.override.mood;
    this.override = null;
    return this.base;
  }
  /** Trigger a temporary emotion. Returns false if the pet is too busy for it. */
  emote(mood, ms = 3000) {
    if (IDLE_ONLY.has(mood) && !['idle', 'bored', 'sleep', 'done'].includes(this.base)) return false;
    this.override = { mood, until: performance.now() + ms };
    if (mood === 'done') this.celebrate();
    if (mood === 'surprised' || mood === 'playful') this.hopT = 0;
    if (mood === 'love') { this.heart(); }
    return true;
  }
  /** A click/poke: surprised, or annoyed if you keep poking. */
  poke() {
    const now = performance.now();
    this.clicks = this.clicks.filter((t) => now - t < 3200); this.clicks.push(now);
    if (this.clicks.length >= 5) { this.clicks = []; this.emote('angry', 3200); }
    else this.emote('surprised', 1100);
  }
  celebrate() { this.hopT = 0; if (!reduce.matches) for (let i = 0; i < 7; i++) this.spark(); }
  lookAt(v) { this.look = v; }
  feed(n = 4) { if (reduce.matches || this.mood === 'sleep') return; for (let i = 0; i < n; i++) this.crumb(); }

  start() { if (this.timer) return; this.timer = setInterval(() => this.step(), 100); }
  stop() { clearInterval(this.timer); this.timer = null; }

  // ---- particles ---------------------------------------------------------------------------
  crumb() {
    if (!this.anch) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    const mx = this.anch.mouth.x + OX, my = this.anch.mouth.y + OY;
    this.particles.push({ k: 'crumb', x: mx + side * (6 + Math.floor(Math.random() * 3)), y: my - 3 - Math.floor(Math.random() * 3), tx: mx, ty: my, life: 14,
      c: Math.random() < 0.5 ? '#ffd166' : this.spec.palette.accent });
  }
  spark() {
    const x = OX + 2 + Math.floor(Math.random() * (M.W - 4)), y = Math.max(1, OY + (this.anch ? this.anch.top : 4) - 2 - Math.floor(Math.random() * 3));
    this.particles.push({ k: 'spark', x, y, life: 6 + Math.floor(Math.random() * 4), age: 0 });
  }
  heart() {
    // keep hearts apart so they read as hearts, not a smear
    const taken = this.particles.filter((q) => q.k === 'heart').map((q) => q.x);
    let x = OX + 2 + Math.floor(Math.random() * (M.W - 6));
    for (let tries = 0; tries < 6 && taken.some((tx) => Math.abs(tx - x) < 4); tries++) x = OX + 2 + Math.floor(Math.random() * (M.W - 6));
    const y = Math.max(1, OY + (this.anch ? this.anch.top : 4) - 3 + Math.floor(Math.random() * 3));
    this.particles.push({ k: 'heart', x, y, life: 11 });
  }
  steam() {
    const side = Math.random() < 0.5 ? -1 : 1;
    this.particles.push({ k: 'steam', x: OX + M.CX + side * (this.spec.hw + 1), y: OY + this.anch.top + 1, life: 6 });
  }

  step() {
    if (!this.spec || !this.visible) return;
    this.tick++;
    if (this.evo) {
      this.evo.t++;
      if (this.evo.t === 10) { this.form = { stage: this.evo.stage, fat: this.evo.fat }; this._rebuild(); for (let i = 0; i < 14; i++) this.spark(); }
      if (this.evo.t >= 26) this.evo = null;
    }
    const now = performance.now(), t = this.tick, m = this.mood;
    if (now > this.blinkAt && now > this.blinkUntil) { this.blinkUntil = now + 140; this.blinkAt = now + 2600 + Math.random() * 3200; }

    for (const p of this.particles) {
      p.life--;
      if (p.k === 'crumb') { p.x += Math.sign(p.tx - p.x) * (Math.abs(p.tx - p.x) > 1 ? 1 : 0); p.y += Math.sign(p.ty - p.y); if (Math.abs(p.tx - p.x) <= 1 && p.y === p.ty) p.life = 0; }
      else if (p.k === 'spark') p.age++;
      else if (p.k === 'z') { p.y -= t % 2 ? 1 : 0; p.x += t % 4 === 0 ? 1 : 0; }
      else if (p.k === 'sweat') p.y += 1;
      else if (p.k === 'heart') { p.y -= t % 2 ? 1 : 0; p.x += t % 6 < 3 ? 0 : 1; }
      else if (p.k === 'steam') { p.y -= 1; p.x += p.x < OX + M.CX ? -(t % 2) : (t % 2); }
    }
    this.particles = this.particles.filter((p) => p.life > 0 && p.y > -2);

    if (!reduce.matches) {
      if (m === 'work' && t % Math.max(1, Math.round(4 / this.intensity)) === 0) this.crumb();
      if (m === 'sleep' && t % 12 === 0) this.particles.push({ k: 'z', x: Math.min(OX + this.anch.side, SCENE_W - 6), y: Math.max(0, OY + this.anch.top - 4), life: 16 });
      if (m === 'stress' && t % 7 === 0) this.particles.push({ k: 'sweat', x: OX + M.CX + this.spec.hw - 1, y: OY + this.anch.eyeY - 2, life: 4 });
      if (m === 'angry' && t % 3 === 0) this.steam();
      if (m === 'love' && t % 4 === 0) this.heart();
      if (m === 'playful' && t % 3 === 0 && Math.random() < 0.6) this.spark();
      if (m === 'done' && t % 3 === 0 && this.hopT >= 0) this.spark();
      if (m === 'alert' && t % 10 === 0) this.hopT = 0;                  // keeps hopping until you notice
      // Idle personality: now and then it gets playful on its own.
      if (this.base === 'idle' && !this.override && now > this.nextPlay) { this.emote('playful', 3600); this.nextPlay = now + 30000 + Math.random() * 40000; }
    }
    if (m === 'playful' && t % 9 === 0) this.hopT = 0;
    if (this.hopT >= 0) { this.hopT++; if (this.hopT > 9) this.hopT = -1; }
    this.draw();
  }

  pose() {
    const t = this.tick, m = this.mood, still = reduce.matches;
    const blinking = performance.now() < this.blinkUntil;
    const p = { frame: 0, bob: 0, eye: blinking ? 'closed' : 'open', mouth: 'smile', look: this.look };
    switch (m) {
      case 'work': p.mouth = t % 4 < 2 ? 'open' : 'chew'; p.bob = still ? 0 : (t % 4 < 2 ? 0 : -1); p.frame = t % 4 < 2 ? 0 : 1; p.look = { x: 1, y: -1 }; break;
      case 'stress': p.mouth = t % 6 < 3 ? 'o' : 'flat'; p.bob = still ? 0 : (t % 2 ? -1 : 0); p.look = { x: -1, y: 0 }; break;
      case 'hungry': p.mouth = 'sad'; p.look = { x: 0, y: 1 }; p.shiver = !still && t % 2 === 0; break;
      case 'sleep': p.eye = 'closed'; p.mouth = 'flat'; p.bob = still ? 0 : (t % 18 < 9 ? 0 : -1); p.look = { x: 0, y: 0 }; break;
      case 'done': p.eye = 'happy'; p.mouth = 'open'; p.bob = -1; break;
      case 'alert': p.eye = blinking ? 'closed' : 'wide'; p.mouth = 'o'; p.bob = still ? 0 : (t % 4 < 2 ? 0 : -1); p.frame = t % 4 < 2 ? 0 : 1; p.look = { x: this.look.x, y: -0.6 }; break;   // "hey! over here!"
      case 'ask': p.eye = 'open'; p.mouth = 'flat'; p.bob = still ? 0 : (t % 14 < 7 ? 0 : -1); p.look = { x: this.look.x * 0.4, y: -1 }; break;               // patiently waiting, glancing up
      case 'angry': p.eye = 'angry'; p.mouth = 'grit'; p.shiver = !still && t % 2 === 0; p.look = { x: this.look.x, y: 0 }; break;
      case 'bored': {                                                // heavy lids, wandering gaze, the occasional yawn
        p.eye = 'bored'; p.mouth = t % 70 > 60 ? 'open' : 'flat'; p.bob = 0;
        p.look = t % 70 > 60 ? { x: 0, y: -1 } : { x: Math.sin(t / 22) > 0.2 ? 1 : Math.sin(t / 22) < -0.2 ? -1 : 0, y: 0 };
        if (t % 70 > 60) p.eye = 'closed';
        break;
      }
      case 'playful': p.eye = t % 8 < 5 ? 'wink' : 'open'; p.mouth = 'tongue'; p.bob = still ? 0 : (t % 4 < 2 ? 0 : -1); p.frame = t % 4 < 2 ? 0 : 1; break;
      case 'surprised': p.eye = 'wide'; p.mouth = 'o'; p.bob = -1; break;
      case 'love': p.eye = 'love'; p.mouth = 'smile'; p.bob = still ? 0 : (t % 8 < 4 ? 0 : -1); break;
      default: p.bob = still ? 0 : (t % 12 < 6 ? 0 : -1); break;
    }
    return p;
  }

  draw() {
    if (!this.spec) return;
    const { ctx, cell } = this;
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    const ox = this.sprite ? 1 : OX, oy = this.sprite ? 1 : OY;
    const hopY = this.hopT >= 0 && !reduce.matches ? -HOP[this.hopT] : 0;
    const pose = this.pose();
    const shx = pose.shiver ? 1 : 0;
    let drawSpec = this.spec, white = false;
    if (this.evo) { const e = this.evo.t; if (e < 10) { drawSpec = this.evo.from; white = e % 2 === 0; } else if (e < 14) white = true; }   // flicker, then a full white flash
    const frame = M.compose(drawSpec, pose);
    const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x * cell), Math.round(y * cell), cell, cell); };
    ctx.fillStyle = this.spec.palette.ground;                       // ground shadow stays put while the body hops
    ctx.fillRect(Math.round((ox + 2) * cell), (oy + M.GROUND + 1) * cell, (M.W - 4) * cell, Math.max(1, Math.round(cell * 0.6)));
    if (this.locked) { for (const c of [...frame.outline, ...frame.cells]) px(ox + c.x, oy + c.y, 'rgba(120,120,140,0.28)'); return; }
    for (const c of frame.outline) px(ox + c.x + shx, oy + c.y + hopY, white ? '#ffffff' : c.c);
    for (const c of frame.cells) px(ox + c.x + shx, oy + c.y + hopY, white ? '#ffffff' : c.c);

    if (this.sprite) return;
    const mood = this.mood;
    if ((mood === 'alert' || mood === 'ask') && this.anch && (this.tick % 8 < 6 || reduce.matches)) {        // big blinking "!" / "?" above the head
      const g = mood === 'alert' ? BANG : QMARK, col = mood === 'alert' ? '#ff4d4d' : '#ffb020', gw = g[0].length;
      const gx = Math.min(SCENE_W - gw - 1, OX + M.CX + Math.ceil(this.spec.hw / 2) + 1), gy = Math.max(0, OY + this.anch.top - 5 + (this.tick % 8 < 3 ? 0 : 1));   // upper-right of the head: clear of antennas/horns
      g.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === '#') { px(gx + c, gy + r, col); } }));
    }
    for (const p of this.particles) {
      if (p.k === 'crumb') px(p.x, p.y, p.c);
      else if (p.k === 'spark') { const c = p.age % 2 ? '#fff6c8' : '#ffd166'; px(p.x, p.y, c); if (p.age % 2 === 0) for (const [dx, dy] of SPARK) px(p.x + dx, p.y + dy, c); }
      else if (p.k === 'z') Z.forEach((row, r) => [...row].forEach((ch, cx) => ch === '#' && px(p.x + cx, p.y + r, 'rgba(200,210,255,0.95)')));
      else if (p.k === 'sweat') { px(p.x, p.y, '#8fd3ff'); px(p.x, p.y + 1, '#5ab4f0'); }
      else if (p.k === 'heart') HEART.forEach((row, r) => [...row].forEach((ch, cx) => ch === '#' && px(p.x + cx, p.y + r, p.life > 3 ? '#ff6b9d' : '#ffb3cc')));
      else if (p.k === 'steam') { px(p.x, p.y, p.life > 3 ? '#ff8a7a' : '#ffc4bb'); px(p.x, p.y - 1, '#ffc4bb'); }
    }
  }
}
