import { el, icon, fmtTokens } from '../util.js';
import { Pet } from '../pet.js';

const EMOTION_LABELS = [['done', 'Happy'], ['playful', 'Playful'], ['love', 'In love'], ['surprised', 'Surprised'], ['angry', 'Angry'], ['bored', 'Bored'], ['sleep', 'Sleepy']];

const M = window.TokkieMonster;
const MAX = 12;                 // saved pets (your first one doesn't count)
const FORM_NAMES = ['Hatchling', 'Junior', 'Champion', 'Mega'];
const PERSONALITIES = [['cheerful', 'Cheerful', 'Sunny and affectionate — loves being petted.'], ['playful', 'Playful', 'Can’t sit still: hops, winks and giggles when poked.'],
  ['sleepy', 'Sleepy', 'Yawns a lot and dozes off quickly when you’re idle.'], ['grumpy', 'Grumpy', 'Scowls by default and hates being poked. Secretly soft.'], ['shy', 'Shy', 'Looks away when you hover; takes a while to warm up.']];

export function petsView(root, api) {
  const reroll = el('button', { class: 'btn primary', type: 'button', style: 'flex:1' }, icon('dice'), 'Generate another');
  const save = el('button', { class: 'btn', type: 'button', style: 'flex:1' }, icon('save'), el('span', { text: 'Save' }));
  const note = el('div', { class: 'note', hidden: true });
  const slotsBox = el('div', { class: 'slots' });
  const count = el('p', { class: 'muted' });
  // Evolution card: four forms (locked ones are silhouettes), and how far it is from the next
  const formsRow = el('div', { class: 'forms' });
  const evoTitle = el('div', { class: 'row' }), evoFill = el('i'), evoBar = el('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Progress to next form', 'aria-valuemin': 0, 'aria-valuemax': 100 }, evoFill);
  const evoNote = el('p', { class: 'muted' });
  const evoCard = el('div', { class: 'evo' }, evoTitle, formsRow, evoBar, evoNote);
  let formPets = [];
  const emotes = el('div', { class: 'chips', role: 'group', 'aria-label': 'Preview an emotion' }, EMOTION_LABELS.map(([m, l]) => el('button', { class: 'btn sm quiet', type: 'button', text: l, onclick: () => api.emote(m) })));
  const persona = el('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Personality' }, PERSONALITIES.map(([v, l, d]) => el('button', { class: 'btn sm', type: 'button', role: 'radio', 'data-v': v, 'aria-checked': 'false', text: l, title: d, onclick: () => api.setSettings({ personality: v }) })));
  const personaNote = el('p', { class: 'muted' });
  // Secret code → special pet
  const codeIn = el('input', { class: 'input', type: 'text', placeholder: 'Secret code', 'aria-label': 'Secret code', autocomplete: 'off', spellcheck: 'false', style: 'flex:1' });
  const codeBtn = el('button', { class: 'btn', type: 'button', text: 'Unlock' });
  const codeMsg = el('p', { class: 'muted', hidden: true });
  const tryCode = async () => {
    if (!codeIn.value.trim()) return;
    codeBtn.disabled = true;
    try {
      const r = await api.redeem(codeIn.value);
      codeMsg.hidden = false;
      if (r.ok) { codeIn.value = ''; codeMsg.style.color = 'var(--good)'; codeMsg.textContent = `✨ You unlocked ${r.name}, a ${M.speciesName('special:' + r.kind)} pet!${r.saved ? ' It’s in your collection.' : ' Your collection is full — remove one to keep it.'}`; api.emote('done'); }
      else { codeMsg.style.color = 'var(--bad)'; codeMsg.textContent = r.error; }
    } finally { codeBtn.disabled = false; }
  };
  codeBtn.addEventListener('click', tryCode);
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryCode(); } });
  // Album: every species (body shape × head) and the secret ones — silhouettes until you've met one
  const albumHead = el('div', { class: 'row' }, el('span', { class: 'label', text: 'Album' }), el('span', { class: 'muted' }));
  const albumGrid = el('div', { class: 'album' });
  const albumNote = el('p', { class: 'muted', text: 'Generate pets to discover species. Secret ones are 1 in 100 — or need a code.' });
  const bringBack = el('button', { class: 'btn sm quiet', type: 'button', hidden: true });
  root.append(el('div', { class: 'stack' },
    evoCard,
    el('div', { class: 'row', style: 'gap:8px' }, reroll, save), note, slotsBox, count, bringBack,
    el('div', { class: 'row', style: 'gap:8px' }, codeIn, codeBtn), codeMsg,
    el('div', { class: 'divider' }), albumHead, albumGrid, albumNote,
    el('div', { class: 'divider' }), el('div', { class: 'label', text: 'Personality' }), persona, personaNote,
    el('div', { class: 'divider' }), el('div', { class: 'label', text: 'Preview an emotion' }),
    el('p', { class: 'muted', style: 'margin-top:-8px', text: 'Plays it once so you can see it — this doesn’t change the personality.' }), emotes,
    el('p', { class: 'muted', text: 'Hover over your pet to pet it. Poke it a few times and see what happens.' })));

  let S = null;
  const setM = (patch) => api.setSettings({ monsters: { ...S.settings.monsters, ...patch } });
  // Blind box: 1 in 100 rolls is one of the secret pets (codes still unlock a specific one).
  const RARE_ODDS = 0.01;
  reroll.addEventListener('click', () => {
    const id = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
    if (Math.random() < RARE_ODDS) {
      const kind = M.SPECIAL_KINDS[Math.floor(Math.random() * M.SPECIAL_KINDS.length)];
      const seed = `sp:${kind}:${id.slice(0, 8)}`;
      setM({ active: seed });
      codeMsg.hidden = false; codeMsg.style.color = 'var(--good)';
      codeMsg.textContent = `✨ Lucky! You found ${M.generate(seed).name}, a rare ${M.speciesName('special:' + kind)} pet (1 in 100). Save it before you roll again!`;
      api.emote('done');
    } else { setM({ active: 'm' + id }); codeMsg.hidden = true; }
  });
  save.addEventListener('click', () => { const { active, saved } = S.settings.monsters; if (saved.length < MAX && !saved.includes(active) && active !== S.signature) setM({ saved: [...saved, active] }); });

  function slot(seed, tag, deletable) {
    const spec = M.generate(seed);
    const cv = el('canvas'); const mp = new Pet(cv, { scale: 3, spriteOnly: true }); mp.setSeed(seed); { const st = S.evolution ? S.evolution.stage : 2, pin = Math.min(st, (S.settings.evolution && S.settings.evolution.display) || 0); mp.setForm(pin || st, pin && pin < st ? 0 : S.evolution ? S.evolution.fat : 0); }
    const b = el('button', { class: 'slot', type: 'button', 'aria-pressed': String(S.settings.monsters.active === seed), 'aria-label': `${spec.name}${tag ? `, ${tag}` : ''}`, title: spec.traits.join(' · ') },
      cv, el('span', { class: 'sname', text: spec.name }), el('span', { class: 'stag', text: tag || '\u00a0' }));
    b.addEventListener('click', () => setM({ active: seed }));
    if (!deletable) return b;
    // The remove control is a sibling of the slot button (buttons must not nest interactive content).
    const d = el('button', { class: 'del', type: 'button', 'aria-label': `Remove ${spec.name}`, title: 'Remove' }, icon('x'));
    d.addEventListener('click', () => {
      const { saved, active, hideOwn } = S.settings.monsters;
      const own = seed === S.signature;
      const left = own ? saved : saved.filter((x) => x !== seed);
      const ownShown = own ? false : !hideOwn;
      // if the one you remove is the active pet, switch to another you have — or a brand-new one if none are left
      let next = active;
      if (active === seed) next = ownShown ? S.signature : left[0] || 'm' + Math.random().toString(36).slice(2, 12).padEnd(10, '0');
      const keep = !ownShown && !left.length ? [next] : left;
      setM({ saved: keep, active: next, hideOwn: own ? true : hideOwn });
    });
    return el('div', { class: 'slotwrap' }, b, d);
  }

  let albumKey = '';
  function drawAlbum(s) {
    const album = s.settings.album || {}, all = M.allSpecies();
    const k = JSON.stringify([album, s.settings.monsters.active]);
    if (k === albumKey) return; albumKey = k;
    const found = all.filter((x) => album[x]).length;
    albumHead.lastChild.textContent = `${found} of ${all.length} found`;
    albumGrid.replaceChildren(...all.map((sp) => {
      const seed = album[sp], secret = sp.startsWith('special:');
      const cv = el('canvas'); const ap = new Pet(cv, { scale: 2, spriteOnly: true }); ap.setSeed(seed || M.sampleSeed(sp)); ap.setForm(2, 0);
      if (!seed) ap.setLocked(true);
      const name = seed ? M.speciesName(sp) : secret ? '???' : M.speciesName(sp);
      const b = el('button', { class: 'acard' + (secret ? ' secret' : ''), type: 'button', 'aria-pressed': String(!!seed && s.settings.monsters.active === seed), disabled: !seed,
        title: seed ? `${M.speciesName(sp)} — ${M.generate(seed).name}. Click to show it.` : secret ? 'A secret pet — 1 in 100 from Generate another, or unlock it with a code' : `${M.speciesName(sp)} — not found yet. Keep generating!` }, cv, el('span', { text: name }));
      if (seed) b.addEventListener('click', () => setM({ active: seed }));
      return b;
    }));
  }

  let key = '';
  return {
    update(s) {
      S = s; const { active, saved } = s.settings.monsters;
      const evo = s.evolution || { stage: 2, fat: 0, name: 'Junior', eaten: 0, progress: 0, next: null, nextName: null };
      const pv = s.settings.personality || 'cheerful';
      persona.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === pv)));
      personaNote.textContent = (PERSONALITIES.find((x) => x[0] === pv) || PERSONALITIES[0])[2];
      const shown = (s.settings.evolution && s.settings.evolution.display) || 0;
      const k = JSON.stringify([active, saved, s.signature, evo.stage, evo.fat, shown, Math.round(evo.progress * 100), Math.round(evo.eaten / 1e5)]);
      if (k === key) return; key = k;
      // ---- evolution card
      evoTitle.replaceChildren(el('span', { class: 'label', text: `${evo.name}${evo.fat ? [' ', ' · chubby', ' · well fed'][evo.fat] : ''}` }),
        el('span', { class: 'muted', text: `${fmtTokens(evo.eaten)} tokens eaten` }));
      formPets = [];
      formsRow.replaceChildren(...FORM_NAMES.map((n, i) => {
        const cv = el('canvas'); const fp = new Pet(cv, { scale: 3, spriteOnly: true }); fp.setSeed(active);
        const unlocked = i + 1 <= evo.stage; fp.setForm(i + 1, i + 1 === evo.stage ? evo.fat : 0); if (!unlocked) fp.setLocked(true);
        const current = (shown || evo.stage) === i + 1;
        // Unlocked forms are buttons: pick one to show it (picking the newest goes back to "always show the newest").
        const pick = () => api.setSettings({ evolution: { display: i + 1 === evo.stage ? 0 : i + 1 } });
        return unlocked
          ? el('button', { class: 'form', type: 'button', 'aria-pressed': String(current), title: current ? `Showing ${n}` : `Show ${n}`, onclick: pick }, cv, el('span', { text: n }))
          : el('div', { class: 'form locked', title: 'Keep eating to find out…' }, cv, el('span', { text: '???' }));
      }));
      evoFill.style.width = Math.round(evo.progress * 100) + '%'; evoBar.setAttribute('aria-valuenow', Math.round(evo.progress * 100));
      evoNote.textContent = (shown && shown < evo.stage ? `Showing ${FORM_NAMES[shown - 1]} — tap ${FORM_NAMES[evo.stage - 1]} to go back to the newest form. ` : evo.stage > 1 ? 'Tap a form to show it. ' : '') + (evo.next ? `${fmtTokens(evo.next - evo.eaten)} more tokens to evolve into ${evo.nextName}. Your pet grows rounder as it eats.` : 'Fully evolved! It keeps getting rounder the more you feed it.');
      const spec = M.generate(active);
      const isSaved = saved.includes(active) || active === s.signature;
      save.disabled = isSaved || saved.length >= MAX;
      save.lastChild.textContent = isSaved ? 'Saved' : 'Save';
      note.hidden = isSaved;
      if (!isSaved) note.replaceChildren(el('b', { text: spec.name }), saved.length >= MAX ? ' is new — your collection is full, remove one to keep it.' : ' is new and not saved yet. Save to keep it, or generate another.');
      count.textContent = `${saved.length} of ${MAX} saved · generate as many as you like`;
      const hideOwn = !!s.settings.monsters.hideOwn;
      const nodes = hideOwn ? [] : [slot(s.signature, 'You', true)];
      bringBack.hidden = !hideOwn;
      if (hideOwn) { bringBack.textContent = `Bring back ${M.generate(s.signature).name} (your first pet)`; bringBack.onclick = () => setM({ hideOwn: false }); }
      for (let i = 0; i < saved.length; i++) nodes.push(slot(saved[i], '', true));
      // a couple of empty spots to show there's room, not a wall of twelve empty boxes
      const free = MAX - saved.length;
      for (let i = 0; i < Math.min(free, (4 - (nodes.length % 4)) % 4 || (free ? 1 : 0)); i++) nodes.push(el('div', { class: 'slot empty-slot', 'aria-hidden': 'true' }, el('span', { class: 'sname', text: 'Empty' })));
      slotsBox.replaceChildren(...nodes);
      drawAlbum(s);
    },
    setActive() {},
  };
}
