/* Pixel pet renderer + animation state machine.
   Draws on a small integer grid (scene cells), scaled up with nearest-neighbour — crisp at any DPI.

   Base moods come from the app (what Claude is doing): idle · work · stress · angry · hungry · sleep · bored · done.
   Transient "emotes" layer on top for interactivity: surprised · love · playful · angry (annoyed) · done · sleep… */
const M = window.TokkieMonster;
export const SCENE_W = 33, SCENE_H = 20, OX = 8, OY = 5; // sprite sits at (OX,OY) inside the scene grid; the side room is for play
const MAX_DX = 6;                                          // how far the pet can wander from the middle (cells)

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const Z = ['#####', '...#.', '..#..', '.#...', '#####'];
const HEART = ['#.#', '###', '.#.'];
const SPARK = [[0, -1], [-1, 0], [1, 0], [0, 1]];
const HOP = [0, 2, 3, 3, 2, 1, 0, 1, 0, 0];
const BANG = ['##', '##', '##', '##', '..', '##'];
const QMARK = ['.##.', '#..#', '..#.', '.#..', '....', '.#..'];
export const EMOTES = ['done', 'playful', 'love', 'surprised', 'angry', 'bored', 'sleep'];
/* Personality: how the pet behaves when nothing is happening — its resting face, how often it plays on its own,
   how it takes being petted (hover) and poked, and how quickly it gets bored / falls asleep while you're away. */
export const PERSONALITY = {
  cheerful: { play: [30e3, 70e3], idleEmote: 'playful', hover: 'love', hoverMs: 2200, pokes: 5, poke: 'surprised', boredMin: 6, sleepMin: 20 },
  playful: { play: [10e3, 25e3], idleEmote: 'playful', hover: 'playful', hoverMs: 1200, pokes: 9, poke: 'playful', boredMin: 12, sleepMin: 40 },
  sleepy: { play: [40e3, 80e3], idleEmote: 'bored', hover: 'love', hoverMs: 3200, pokes: 6, poke: 'surprised', boredMin: 2, sleepMin: 7 },
  grumpy: { play: [70e3, 140e3], idleEmote: 'angry', hover: 'love', hoverMs: 4500, pokes: 3, poke: 'angry', boredMin: 5, sleepMin: 25 },
  shy: { play: [50e3, 100e3], idleEmote: 'love', hover: 'love', hoverMs: 3800, pokes: 5, poke: 'surprised', boredMin: 8, sleepMin: 20 },
};
// How each personality reacts to a pointer rushing at it (chance to dodge) and what it likes to do when idle.
export const TEMPER = {
  cheerful: { dodge: 0.5, acts: ['ball', 'butterfly', 'console', 'paint', 'read'] },
  playful: { dodge: 0.9, acts: ['ball', 'ball', 'butterfly', 'butterfly', 'console'] },
  sleepy: { dodge: 0.15, acts: ['read', 'read', 'console', 'paint'] },
  grumpy: { dodge: 0, acts: ['console', 'console', 'read'] },
  shy: { dodge: 0.8, acts: ['paint', 'paint', 'read', 'butterfly'] },
};
const ACTS = ['console', 'ball', 'butterfly', 'paint', 'read'];
const PAINTS = ['#ff6b6b', '#ffd166', '#4fd67a', '#4db8ff', '#b07cff', '#ff9de2'];
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
    this.persona = 'cheerful'; this.P = PERSONALITY.cheerful; this.hovered = false;
    // play: where the body stands (dx, cells from the middle), what it's doing (act), hiding in its box, cursor history
    this.dx = 0; this.tx = 0; this.act = null; this.hide = null; this.bite = null; this.angryAt = 0; this.dodgeAt = 0; this.backAt = 0;
    this.nextAct = performance.now() + 20000 + Math.random() * 15000; this.cur = null;
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
  setPersonality(id) {
    if (id === this.persona || !PERSONALITY[id]) return;
    this.persona = id; this.P = PERSONALITY[id];
    this.nextPlay = performance.now() + this.P.play[0] * 0.5;
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
  /**
   * A click/poke. Keep poking and it escalates: surprised → annoyed → it snaps at your pointer → it hides in its box.
   * Playful pets often just hop out of the way; shy ones hide straight away; grumpy ones bite sooner.
   * @param {number} [side] which side the pointer is on (-1 left, 1 right)
   */
  poke(side = 0) {
    const now = performance.now();
    this.endAct();
    if (this.hide) { this.hide.until = Math.max(this.hide.until, now + 5000); this.hide.shake = 4; return; }   // knocking on the box
    this.clicks = this.clicks.filter((t) => now - t < 3200); this.clicks.push(now);
    const n = this.clicks.length;
    if (n >= this.P.pokes) {
      this.clicks = [];
      if (this.persona === 'shy' || now - this.angryAt < 8000) { this.hideAway(); return; }
      this.angryAt = now; this.emote('angry', 2600); this.snap(side || (Math.random() < 0.5 ? -1 : 1)); return;
    }
    if (this.persona === 'playful' && Math.random() < 0.5) { this.dodge(-(side || 1)); this.override = null; this.emote('playful', 1400); return; }
    if (this.P.poke === 'playful') { this.override = null; this.emote('playful', 1600) || this.emote('surprised', 1100); }   // giggles
    else this.emote(this.P.poke, this.P.poke === 'angry' ? 1300 : 1100);
  }
  /** Snap at the pointer: lunge to that side with a chomp, then back. */
  snap(side) { if (reduce.matches) return; this.bite = { side, t: 0 }; this.tx = Math.max(-MAX_DX, Math.min(MAX_DX, side * 3)); this.backAt = performance.now() + 900; }
  /** Hop out of the way, then wander back after a moment. */
  dodge(side) {
    if (reduce.matches || this.hide) return;
    this.endAct(); this.tx = side * (MAX_DX - 1) || MAX_DX - 1; this.hopT = 0; this.dodgeAt = performance.now(); this.backAt = this.dodgeAt + 2600;
  }
  /** Duck into a cardboard box and peek out until you leave it alone. */
  hideAway() { this.endAct(); this.override = null; this.bite = null; this.tx = 0; this.hide = { until: performance.now() + 7000, shake: 0 }; }
  /**
   * The pointer, as the app sees it: where it is relative to the pet's middle (px) and how fast it moves (px/s).
   * Rushing at the pet makes it dodge (by personality); a grumpy one just huffs.
   */
  pointer({ dx, dy, speed }) {
    const now = performance.now(), dist = Math.hypot(dx, dy), prev = this.cur;
    this.cur = { dx, dy, dist, at: now };
    if (!prev || reduce.matches || this.sprite || this.hide || this.bite) return;
    const closing = prev.dist - dist > 20;
    if (!(dist < 120 && closing && speed > 900 && now - this.dodgeAt > 3000)) return;
    if (!['idle', 'bored', 'hungry'].includes(this.base) || (this.override && this.override.mood !== 'playful')) return;
    const T = TEMPER[this.persona] || TEMPER.cheerful;
    if (this.persona === 'grumpy') { this.dodgeAt = now; this.override = { mood: 'angry', until: now + 1200 }; return; }
    if (Math.random() < T.dodge) { this.dodge(dx > 0 ? -1 : 1); this.emote(this.persona === 'playful' ? 'playful' : 'surprised', 1200); }
    else this.dodgeAt = now;
  }
  /** Is there pet (not empty scene) at this point of the canvas (CSS px)? Lets clicks through the empty room around it. */
  hitTest(x, y) {
    const k = this.cell / Math.max(1, window.devicePixelRatio || 1), cx = Math.floor(x / k), cy = Math.floor(y / k);
    const bx = this.bx, top = OY + (this.anch ? this.anch.top : 0) - 1;
    return cx >= bx + 1 && cx <= bx + M.W - 2 && cy >= top - (this.hide ? 0 : 1) && cy <= OY + M.GROUND + 2;
  }
  get bx() { return (this.sprite ? 1 : OX) + Math.round(this.dx); }

  // ---- idle play ---------------------------------------------------------------------------
  /** Start something to do: a game console, a ball, a butterfly, painting, a book. */
  play(kind, { forced = false } = {}) {
    if (this.sprite || reduce.matches || !this.spec) return false;
    const T = TEMPER[this.persona] || TEMPER.cheerful;
    const k = ACTS.includes(kind) ? kind : T.acts[Math.floor(Math.random() * T.acts.length)];
    const now = performance.now(), a = { k, t: 0, forced, until: now + (forced ? 12000 : 22000 + Math.random() * 18000) };
    if (forced) { this.hide = null; this.bite = null; }
    if (k === 'ball') Object.assign(a, { x: OX + M.CX + 6, y: OY + M.GROUND - 6, vx: -0.6, vy: 0 });
    if (k === 'butterfly') Object.assign(a, { x: 2, y: 4, phase: Math.random() * 6 });
    if (k === 'paint') { Object.assign(a, { cells: [], todo: [] }); for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) a.todo.push([x, y]); a.todo.sort(() => Math.random() - 0.5); a.color = PAINTS[Math.floor(Math.random() * PAINTS.length)]; this.tx = -5; }
    if (k === 'read') a.page = 0;
    this.act = a; this.override = null;
    return true;
  }
  endAct() {
    if (!this.act) return;
    this.act = null; this.tx = 0;
    const [lo, hi] = this.P.play; this.nextAct = performance.now() + 2 * lo + Math.random() * (hi - lo) * 2;
  }

  celebrate() { this.hopT = 0; if (!reduce.matches) for (let i = 0; i < 7; i++) this.spark(); }
  lookAt(v) { this.look = v; }
  feed(n = 4) { if (reduce.matches || this.mood === 'sleep') return; for (let i = 0; i < n; i++) this.crumb(); }

  start() { if (this.timer) return; this.timer = setInterval(() => this.step(), 100); }
  stop() { clearInterval(this.timer); this.timer = null; }

  // ---- particles ---------------------------------------------------------------------------
  crumb() {
    if (!this.anch || this.hide) return;          // no snacking while hiding in the box
    const side = Math.random() < 0.5 ? -1 : 1;
    const mx = this.anch.mouth.x + this.bx, my = this.anch.mouth.y + OY;
    this.particles.push({ k: 'crumb', x: mx + side * (6 + Math.floor(Math.random() * 3)), y: my - 3 - Math.floor(Math.random() * 3), tx: mx, ty: my, life: 14,
      c: Math.random() < 0.5 ? '#ffd166' : this.spec.palette.accent });
  }
  spark(colors) {
    const x = this.bx + 2 + Math.floor(Math.random() * (M.W - 4)), y = Math.max(1, OY + (this.anch ? this.anch.top : 4) - 2 - Math.floor(Math.random() * 3));
    this.particles.push({ k: 'spark', x, y, life: 6 + Math.floor(Math.random() * 4), age: 0, colors });
  }
  /** Special pets' own glitter: sparkles all around golden and diamond pets, rainbow confetti for rainbow ones. */
  shimmer() {
    const sp = this.spec && this.spec.special;
    if (sp === 'golden' || sp === 'diamond') {
      const colors = sp === 'golden' ? ['#fff6c8', '#ffd166'] : ['#ffffff', '#bff4ff'];
      const x = 1 + Math.floor(Math.random() * (SCENE_W - 2)), y = 1 + Math.floor(Math.random() * (SCENE_H - 4));
      this.particles.push({ k: 'spark', x, y, life: 5 + Math.floor(Math.random() * 4), age: 0, colors });
    } else if (sp === 'rainbow' || sp === 'unicorn') {
      const c = ['#ff5c5c', '#ffa23a', '#ffe14d', '#4fd67a', '#4db8ff', '#8a6bff', '#ff6bd6'][Math.floor(Math.random() * 7)];
      this.particles.push({ k: 'confetti', x: 1 + Math.floor(Math.random() * (SCENE_W - 2)), y: 0, life: 14 + Math.floor(Math.random() * 6), c, drift: Math.random() < 0.5 ? -1 : 1 });
    }
  }
  heart() {
    // keep hearts apart so they read as hearts, not a smear
    const taken = this.particles.filter((q) => q.k === 'heart').map((q) => q.x);
    let x = this.bx + 2 + Math.floor(Math.random() * (M.W - 6));
    for (let tries = 0; tries < 6 && taken.some((tx) => Math.abs(tx - x) < 4); tries++) x = this.bx + 2 + Math.floor(Math.random() * (M.W - 6));
    const y = Math.max(1, OY + (this.anch ? this.anch.top : 4) - 3 + Math.floor(Math.random() * 3));
    this.particles.push({ k: 'heart', x, y, life: 11 });
  }
  steam() {
    const side = Math.random() < 0.5 ? -1 : 1;
    this.particles.push({ k: 'steam', x: this.bx + M.CX + side * (this.spec.hw + 1), y: OY + this.anch.top + 1, life: 6 });
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
      else if (p.k === 'confetti') { p.y += 1; if (t % 3 === 0) p.x += p.drift; }
      else if (p.k === 'z') { p.y -= t % 2 ? 1 : 0; p.x += t % 4 === 0 ? 1 : 0; }
      else if (p.k === 'sweat') p.y += 1;
      else if (p.k === 'heart') { p.y -= t % 2 ? 1 : 0; p.x += t % 6 < 3 ? 0 : 1; }
      else if (p.k === 'steam') { p.y -= 1; p.x += p.x < this.bx + M.CX ? -(t % 2) : (t % 2); }
    }
    this.particles = this.particles.filter((p) => p.life > 0 && p.y > -2);

    if (!reduce.matches) {
      if (m === 'work' && t % Math.max(1, Math.round(4 / this.intensity)) === 0) this.crumb();
      if (this.spec.special && m !== 'sleep' && t % (this.spec.special === 'rainbow' || this.spec.special === 'unicorn' ? 3 : 5) === 0) this.shimmer();
      if (m === 'sleep' && t % 12 === 0) this.particles.push({ k: 'z', x: Math.min(this.bx + this.anch.side, SCENE_W - 6), y: Math.max(0, OY + this.anch.top - 4), life: 16 });
      if (m === 'stress' && t % 7 === 0) this.particles.push({ k: 'sweat', x: this.bx + M.CX + this.spec.hw - 1, y: OY + this.anch.eyeY - 2, life: 4 });
      if (m === 'angry' && t % 3 === 0) this.steam();
      if (m === 'love' && t % 4 === 0) this.heart();
      if (m === 'playful' && t % 3 === 0 && Math.random() < 0.6) this.spark();
      if (m === 'done' && t % 3 === 0 && this.hopT >= 0) this.spark();
      if (m === 'alert' && t % 10 === 0) this.hopT = 0;                  // keeps hopping until you notice
      // Idle personality: now and then it gets playful on its own.
      if (this.base === 'idle' && !this.override && !this.hovered && !this.act && !this.hide && now > this.nextPlay) {
        const [a, b] = this.P.play, e = this.P.idleEmote;
        if (e === 'angry') this.override = { mood: 'angry', until: now + 1600 };     // a short huff, not a tantrum
        else this.emote(e, e === 'bored' ? 4200 : 3600);
        this.nextPlay = now + a + Math.random() * (b - a);
      }
    }
    if (!this.sprite) this.stepPlay(now, t);
    if (m === 'playful' && t % 9 === 0) this.hopT = 0;
    if (this.hopT >= 0) { this.hopT++; if (this.hopT > 9) this.hopT = -1; }
    this.draw();
  }

  /** One tick of play: walking to where it wants to be, its activity, the box, the snap. */
  stepPlay(now, t) {
    const idleish = ['idle', 'bored'].includes(this.base);
    // Claude finished / needs you / is working: drop everything and pay attention
    if (!idleish && this.act && !this.act.forced) this.endAct();
    // the box: it stays hidden whatever the mood (busy, hungry…), and only pops out early when Claude finishes or needs you
    if (this.hide && ['done', 'alert', 'ask'].includes(this.base)) this.hide = null;
    if (this.act && ((this.override && !this.act.forced) || this.hovered || now > this.act.until)) this.endAct();
    if (!this.act && !this.hide && idleish && !this.override && !this.hovered && now > this.nextAct && !reduce.matches) this.play();
    if (this.hide) { if (this.hide.shake > 0) this.hide.shake--; if (now > this.hide.until) { this.hide = null; this.emote('surprised', 900); } }
    if (this.bite) { this.bite.t++; if (this.bite.t > 9) this.bite = null; }
    if (this.backAt && now > this.backAt && !this.act) { this.tx = 0; this.backAt = 0; }
    const a = this.act;
    if (a) {
      a.t++;
      if (a.k === 'ball') {
        a.vy += 0.35; a.x += a.vx; a.y += a.vy;
        const floor = OY + M.GROUND - 1;
        if (a.y >= floor) { a.y = floor; a.vy = -Math.abs(a.vy) * 0.62; if (Math.abs(a.vy) < 0.6) a.vy = 0; }
        if (a.x < 1) { a.x = 1; a.vx = Math.abs(a.vx); } if (a.x > SCENE_W - 3) { a.x = SCENE_W - 3; a.vx = -Math.abs(a.vx); }
        this.tx = Math.max(-MAX_DX, Math.min(MAX_DX, Math.round(a.x - (OX + M.CX))));
        const body = this.bx + M.CX, reach = this.spec.hw + 2;
        if (Math.abs(a.x - body) <= reach && a.y > floor - 3 && t % 2 === 0) {          // kick it away and hop
          a.vx = (a.x >= body ? 1 : -1) * (0.7 + Math.random() * 0.6); a.vy = -2.6 - Math.random(); this.hopT = 0;
        }
        a.vx *= 0.995;
      } else if (a.k === 'butterfly') {
        a.phase += 0.12; a.x = 16 + Math.sin(a.phase * 0.7) * 14; a.y = 3 + Math.sin(a.phase * 1.6) * 2.2;
        this.tx = Math.max(-MAX_DX, Math.min(MAX_DX, Math.round((a.x - (OX + M.CX)) * 0.6)));
        if (t % 26 === 0 && Math.abs(a.x - (this.bx + M.CX)) < 4) this.hopT = 0;             // a jump for it
      } else if (a.k === 'paint') {
        if (a.t % 7 === 0 && a.todo.length) { const [x, y] = a.todo.pop(); a.cells.push({ x, y, c: Math.random() < 0.7 ? a.color : PAINTS[Math.floor(Math.random() * PAINTS.length)] }); }
        if (!a.todo.length && !a.doneAt) { a.doneAt = now; this.hopT = 0; for (let i = 0; i < 6; i++) this.spark(); a.until = Math.min(a.until, now + 3500); }
      } else if (a.k === 'read') { if (a.t % 45 === 0) a.page = 6; if (a.page > 0) a.page--; }
      else if (a.k === 'console') { if (a.t % 60 === 0 && Math.random() < 0.5) { this.hopT = 0; this.spark(['#7cf29a', '#ffd166']); } }
    }
    // walk (a cell at a time) towards where it wants to stand
    const speed = a && a.k === 'ball' ? 1 : t % 2 === 0 ? 1 : 0;
    if (this.dx < this.tx) this.dx = Math.min(this.tx, this.dx + speed); else if (this.dx > this.tx) this.dx = Math.max(this.tx, this.dx - speed);
  }

  pose() {
    const t = this.tick, m = this.mood, still = reduce.matches;
    const blinking = performance.now() < this.blinkUntil;
    const p = { frame: 0, bob: 0, eye: blinking ? 'closed' : 'open', mouth: 'smile', look: this.look };
    const a = this.act, calm = (a && a.forced) || (!this.override && ['idle', 'bored'].includes(this.base));
    if (this.bite) { p.eye = 'angry'; p.mouth = this.bite.t % 4 < 2 ? 'open' : 'grit'; p.look = { x: this.bite.side, y: 0 }; return p; }
    if (this.hide) { p.eye = blinking || t % 40 > 30 ? 'closed' : 'wide'; p.mouth = 'flat'; p.look = { x: this.look.x, y: 0 }; return p; }
    if (a && calm) {
      if (a.k === 'console') { p.look = { x: 0, y: 1 }; p.mouth = t % 30 < 4 ? 'o' : 'smile'; p.bob = still ? 0 : (t % 10 < 5 ? 0 : -1); }
      else if (a.k === 'read') { p.eye = blinking ? 'closed' : 'bored'; p.look = { x: 0, y: 1 }; p.mouth = 'flat'; }
      else if (a.k === 'paint') { p.look = { x: 1, y: 0 }; p.mouth = a.doneAt ? 'open' : t % 20 < 10 ? 'tongue' : 'smile'; if (a.doneAt) p.eye = 'happy'; }
      else {                                                       // ball / butterfly: eyes on the toy
        const ex = (a.x - (this.bx + M.CX)) / 6, ey = (a.y - (OY + (this.anch ? this.anch.eyeY : 6))) / 6;
        p.look = { x: Math.max(-1, Math.min(1, ex)), y: Math.max(-1, Math.min(1, ey)) }; p.mouth = 'open';
        if (a.k === 'ball') p.frame = t % 4 < 2 ? 0 : 1;
      }
      return p;
    }
    switch (m) {
      case 'work': p.mouth = t % 4 < 2 ? 'open' : 'chew'; p.bob = still ? 0 : (t % 4 < 2 ? 0 : -1); p.frame = t % 4 < 2 ? 0 : 1; p.look = { x: 1, y: -1 }; break;
      case 'stress': p.mouth = t % 6 < 3 ? 'o' : 'flat'; p.bob = still ? 0 : (t % 2 ? -1 : 0); p.look = { x: -1, y: 0 }; break;
      case 'hungry': p.mouth = 'sad'; p.look = { x: 0, y: 1 }; p.shiver = !still && t % 50 < 5 && t % 2 === 0; p.bob = still ? 0 : (t % 30 < 15 ? 0 : 1); break;   // a weak shiver now and then (not non-stop: that read as broken)
      case 'sleep': p.eye = 'closed'; p.mouth = 'flat'; p.bob = still ? 0 : (t % 18 < 9 ? 0 : -1); p.look = { x: 0, y: 0 }; break;
      case 'done': p.eye = 'happy'; p.mouth = 'open'; p.bob = -1; break;
      case 'alert': p.eye = blinking ? 'closed' : 'wide'; p.mouth = 'o'; p.bob = still ? 0 : (t % 4 < 2 ? 0 : -1); p.frame = t % 4 < 2 ? 0 : 1; p.look = { x: this.look.x, y: -0.6 }; break;   // "hey! over here!"
      case 'ask': p.eye = 'open'; p.mouth = 'flat'; p.bob = still ? 0 : (t % 14 < 7 ? 0 : -1); p.look = { x: this.look.x * 0.4, y: -1 }; break;               // patiently waiting, glancing up
      case 'angry': p.eye = 'angry'; p.mouth = 'grit'; p.shiver = !still && (this.override ? t % 2 === 0 : t % 40 < 6 && t % 2 === 0); p.look = { x: this.look.x, y: 0 }; break;   // a poke: a tantrum; working overtime: a grumble now and then
      case 'bored': {                                                // heavy lids, wandering gaze, the occasional yawn
        p.eye = 'bored'; p.mouth = t % 70 > 60 ? 'open' : 'flat'; p.bob = 0;
        p.look = t % 70 > 60 ? { x: 0, y: -1 } : { x: Math.sin(t / 22) > 0.2 ? 1 : Math.sin(t / 22) < -0.2 ? -1 : 0, y: 0 };
        if (t % 70 > 60) p.eye = 'closed';
        break;
      }
      case 'playful': p.eye = t % 8 < 5 ? 'wink' : 'open'; p.mouth = 'tongue'; p.bob = still ? 0 : (t % 4 < 2 ? 0 : -1); p.frame = t % 4 < 2 ? 0 : 1; break;
      case 'surprised': p.eye = 'wide'; p.mouth = 'o'; p.bob = -1; break;
      case 'love': p.eye = 'love'; p.mouth = 'smile'; p.bob = still ? 0 : (t % 8 < 4 ? 0 : -1); break;
      default: {                                                     // resting face depends on personality
        const pk = this.persona;
        if (pk === 'playful') { p.bob = still ? 0 : (t % 6 < 3 ? 0 : -1); if (t % 50 > 45) p.eye = 'wink'; }
        else if (pk === 'sleepy') { p.eye = t % 60 > 50 || blinking ? 'closed' : 'bored'; p.bob = still ? 0 : (t % 24 < 12 ? 0 : -1); }
        else if (pk === 'grumpy') { p.eye = blinking ? 'closed' : 'angry'; p.mouth = 'flat'; p.bob = 0; }
        else if (pk === 'shy') {                                   // won't meet your eye: glances away and down, more so while you hover
          const lx = this.look.x; p.look = { x: lx > 0.3 ? -1 : lx < -0.3 ? 1 : 0, y: 1 }; p.bob = still ? 0 : (t % 16 < 8 ? 0 : -1);
          if (this.hovered && t % 30 > 24) p.eye = 'closed';
        } else p.bob = still ? 0 : (t % 12 < 6 ? 0 : -1);
        break;
      }
    }
    return p;
  }

  // ---- props (drawn in scene cells) -----------------------------------------------------------
  /** Things behind the pet: the easel. */
  drawBehind(px) {
    const a = this.act; if (!a || a.k !== 'paint') return;
    const x0 = this.bx + M.CX + this.spec.hw + 2, y0 = OY + M.GROUND - 9;
    for (let y = y0 + 5; y <= OY + M.GROUND; y++) { px(x0 + 1, y, '#8b5a2b'); px(x0 + 5, y, '#8b5a2b'); }     // legs
    for (let x = x0; x <= x0 + 6; x++) { px(x, y0 - 1, '#6b4420'); px(x, y0 + 4, '#6b4420'); }                  // frame
    for (let y = y0; y < y0 + 4; y++) { px(x0, y, '#6b4420'); px(x0 + 6, y, '#6b4420'); for (let x = 1; x <= 5; x++) px(x0 + x, y, '#f4f1e8'); }
    for (const c of a.cells) px(x0 + 1 + c.x, y0 + c.y, c.c);
    if (!a.doneAt && a.todo.length) { const [bx, by] = a.todo[a.todo.length - 1]; px(x0 + 1 + bx, y0 + by - 1, '#3b2a1a'); px(x0 + 1 + bx, y0 + by, a.color); }   // the brush
  }
  /** Things in front of / held by the pet: console, book, ball, butterfly, the box, a chomp. */
  drawFront(px, hopY) {
    const a = this.act, cx = this.bx + M.CX, mouthY = OY + (this.anch ? this.anch.mouth.y : 9) + hopY;
    const held = Math.min(mouthY + 2, OY + M.GROUND - 2 + Math.min(0, hopY));   // held at the chest, never below the floor
    if (a && a.k === 'console') {
      const y = held;
      for (let x = -3; x <= 3; x++) { px(cx + x, y, '#2d2d3a'); px(cx + x, y + 2, '#2d2d3a'); } px(cx - 3, y + 1, '#2d2d3a'); px(cx + 3, y + 1, '#2d2d3a');
      px(cx - 2, y + 1, '#e04f5f'); px(cx + 2, y + 1, '#4f7fe0');
      const sc = ['#7cf29a', '#5ad1ff', '#ffd166'][Math.floor(this.tick / 3) % 3]; for (let x = -1; x <= 1; x++) px(cx + x, y + 1, sc);
    } else if (a && a.k === 'read') {
      const y = held, cover = this.spec.palette.accent;
      for (let x = -3; x <= 3; x++) { px(cx + x, y, x === 0 ? '#b8b0a0' : '#f4f1e8'); px(cx + x, y + 1, x === 0 ? '#b8b0a0' : '#e6dfcf'); px(cx + x, y + 2, cover); }
      if (a.page > 0) px(cx + (a.page > 3 ? 1 : -1) * (a.page % 3 + 1), y - 1, '#ffffff');           // a page turning
    } else if (a && a.k === 'ball') {
      const bx = Math.round(a.x), by = Math.round(a.y);
      px(bx, by, '#ff5c5c'); px(bx + 1, by, '#e23c3c'); px(bx, by + 1, '#e23c3c'); px(bx + 1, by + 1, '#b82a2a'); px(bx, by, '#ffb3b3');
    } else if (a && a.k === 'butterfly') {
      const bx = Math.round(a.x), by = Math.round(a.y), up = this.tick % 4 < 2;
      px(bx, by, '#3b2a1a'); px(bx, by + 1, '#3b2a1a');
      if (up) { px(bx - 1, by - 1, '#ff9de2'); px(bx + 1, by - 1, '#ff9de2'); px(bx - 1, by, '#ffd166'); px(bx + 1, by, '#ffd166'); }
      else { px(bx - 1, by, '#ff9de2'); px(bx + 1, by, '#ff9de2'); px(bx - 2, by, '#ffd166'); px(bx + 2, by, '#ffd166'); }
    }
    if (this.hide) {                                               // the cardboard box (shakes when you knock)
      const sh = this.hide.shake > 0 ? (this.hide.shake % 2 ? 1 : -1) : 0, w = this.spec.hw + 3, top = OY + M.GROUND - 5;
      for (let y = top; y <= OY + M.GROUND; y++) for (let x = -w; x <= w; x++) px(cx + x + sh, y, y === top ? '#a8733f' : x === 0 && y < top + 3 ? '#e8d3a0' : '#c8955a');
      for (let x = -w - 1; x <= -w + 1; x++) px(cx + x + sh, top - 1, '#b88550');               // flaps
      for (let x = w - 1; x <= w + 1; x++) px(cx + x + sh, top - 1, '#b88550');
    }
    if (this.bite && this.bite.t % 4 < 2) {                       // chomp! teeth snapping at the pointer
      const x = cx + this.bite.side * (this.spec.hw + 2), y = mouthY;
      for (const [dx, dy] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]) px(x + dx * this.bite.side, y + dy - 1, '#ffffff');
    }
  }

  draw() {
    if (!this.spec) return;
    const { ctx, cell } = this;
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    const ox = this.bx, oy = this.sprite ? 1 : OY;
    const sink = this.hide ? (this.tick % 60 < 40 ? 4 : 2) : 0;            // in the box: mostly hidden, now and then peeking
    const hopY = (this.hopT >= 0 && !reduce.matches ? -HOP[this.hopT] : 0) + sink;
    const pose = this.pose();
    const shx = pose.shiver ? 1 : 0;
    let drawSpec = this.spec, white = false;
    if (this.evo) { const e = this.evo.t; if (e < 10) { drawSpec = this.evo.from; white = e % 2 === 0; } else if (e < 14) white = true; }   // flicker, then a full white flash
    const frame = M.compose(drawSpec, pose);
    const px = (x, y, c) => { ctx.fillStyle = c; ctx.fillRect(Math.round(x * cell), Math.round(y * cell), cell, cell); };
    ctx.fillStyle = this.spec.palette.ground;                       // ground shadow stays put while the body hops
    ctx.fillRect(Math.round((ox + 2) * cell), (oy + M.GROUND + 1) * cell, (M.W - 4) * cell, Math.max(1, Math.round(cell * 0.6)));
    if (this.locked) { for (const c of [...frame.outline, ...frame.cells]) px(ox + c.x, oy + c.y, 'rgba(120,120,140,0.28)'); return; }
    if (!this.sprite) this.drawBehind(px);
    for (const c of frame.outline) if (oy + c.y + hopY <= oy + M.GROUND) px(ox + c.x + shx, oy + c.y + hopY, white ? '#ffffff' : c.c);
    for (const c of frame.cells) if (oy + c.y + hopY <= oy + M.GROUND) px(ox + c.x + shx, oy + c.y + hopY, white ? '#ffffff' : c.c);

    if (this.sprite) return;
    this.drawFront(px, hopY);
    const mood = this.mood;
    if ((mood === 'alert' || mood === 'ask') && this.anch && (this.tick % 8 < 6 || reduce.matches)) {        // big blinking "!" / "?" above the head
      const g = mood === 'alert' ? BANG : QMARK, col = mood === 'alert' ? '#ff4d4d' : '#ffb020', gw = g[0].length;
      const gx = Math.min(SCENE_W - gw - 1, this.bx + M.CX + Math.ceil(this.spec.hw / 2) + 1), gy = Math.max(0, OY + this.anch.top - 5 + (this.tick % 8 < 3 ? 0 : 1));   // upper-right of the head: clear of antennas/horns
      g.forEach((row, r) => [...row].forEach((ch, c) => { if (ch === '#') { px(gx + c, gy + r, col); } }));
    }
    for (const p of this.particles) {
      if (p.k === 'crumb') px(p.x, p.y, p.c);
      else if (p.k === 'spark') { const cs = p.colors || ['#fff6c8', '#ffd166'], c = p.age % 2 ? cs[0] : cs[1]; px(p.x, p.y, c); if (p.age % 2 === 0) for (const [dx, dy] of SPARK) px(p.x + dx, p.y + dy, c); }
      else if (p.k === 'confetti') { px(p.x, p.y, p.c); if (p.life % 4 < 2) px(p.x + p.drift, p.y, p.c); }
      else if (p.k === 'z') Z.forEach((row, r) => [...row].forEach((ch, cx) => ch === '#' && px(p.x + cx, p.y + r, 'rgba(200,210,255,0.95)')));
      else if (p.k === 'sweat') { px(p.x, p.y, '#8fd3ff'); px(p.x, p.y + 1, '#5ab4f0'); }
      else if (p.k === 'heart') HEART.forEach((row, r) => [...row].forEach((ch, cx) => ch === '#' && px(p.x + cx, p.y + r, p.life > 3 ? '#ff6b9d' : '#ffb3cc')));
      else if (p.k === 'steam') { px(p.x, p.y, p.life > 3 ? '#ff8a7a' : '#ffc4bb'); px(p.x, p.y - 1, '#ffc4bb'); }
    }
  }
}
