import { el, icon, fmtTokens } from '../util.js';
import { Pet } from '../pet.js';

const EMOTION_LABELS = [['done', 'Happy'], ['playful', 'Playful'], ['love', 'In love'], ['surprised', 'Surprised'], ['angry', 'Angry'], ['bored', 'Bored'], ['sleep', 'Sleepy']];

const M = window.TokkieMonster;
const MAX = 5;
const FORM_NAMES = ['Hatchling', 'Junior', 'Champion', 'Mega'];

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
  const emotes = el('div', { class: 'chips', role: 'group', 'aria-label': 'Try an emotion' }, EMOTION_LABELS.map(([m, l]) => el('button', { class: 'btn sm', type: 'button', text: l, onclick: () => api.emote(m) })));
  root.append(el('div', { class: 'stack' },
    evoCard,
    el('div', { class: 'row', style: 'gap:8px' }, reroll, save), note, slotsBox, count,
    el('div', { class: 'divider' }), el('div', { class: 'label', text: 'Try an emotion' }), emotes,
    el('p', { class: 'muted', text: 'Hover over your pet to pet it. Poke it five times and see what happens.' })));

  let S = null;
  const setM = (patch) => api.setSettings({ monsters: { ...S.settings.monsters, ...patch } });
  reroll.addEventListener('click', () => setM({ active: 'r' + Math.random().toString(36).slice(2, 10) }));
  save.addEventListener('click', () => { const { active, saved } = S.settings.monsters; if (saved.length < MAX && !saved.includes(active) && active !== S.signature) setM({ saved: [...saved, active] }); });

  function slot(seed, tag, deletable) {
    const spec = M.generate(seed);
    const cv = el('canvas'); const mp = new Pet(cv, { scale: 4, spriteOnly: true }); mp.setSeed(seed); mp.setForm(S.evolution ? S.evolution.stage : 2, S.evolution ? S.evolution.fat : 0);
    const b = el('button', { class: 'slot', type: 'button', 'aria-pressed': String(S.settings.monsters.active === seed), 'aria-label': `${spec.name}${tag ? `, ${tag}` : ''}`, title: spec.traits.join(' · ') },
      cv, el('span', { class: 'sname', text: spec.name }), el('span', { class: 'stag', text: tag || '\u00a0' }));
    b.addEventListener('click', () => setM({ active: seed }));
    if (!deletable) return b;
    // The remove control is a sibling of the slot button (buttons must not nest interactive content).
    const d = el('button', { class: 'del', type: 'button', 'aria-label': `Remove ${spec.name}`, title: 'Remove' }, icon('x'));
    d.addEventListener('click', () => { const { saved, active } = S.settings.monsters; setM({ saved: saved.filter((x) => x !== seed), active: active === seed ? S.signature : active }); });
    return el('div', { class: 'slotwrap' }, b, d);
  }

  let key = '';
  return {
    update(s) {
      S = s; const { active, saved } = s.settings.monsters;
      const evo = s.evolution || { stage: 2, fat: 0, name: 'Junior', eaten: 0, progress: 0, next: null, nextName: null };
      const k = JSON.stringify([active, saved, s.signature, evo.stage, evo.fat, Math.round(evo.progress * 100), Math.round(evo.eaten / 1e5)]);
      if (k === key) return; key = k;
      // ---- evolution card
      evoTitle.replaceChildren(el('span', { class: 'label', text: `${evo.name}${evo.fat ? [' ', ' · chubby', ' · well fed'][evo.fat] : ''}` }),
        el('span', { class: 'muted', text: `${fmtTokens(evo.eaten)} tokens eaten` }));
      formPets = [];
      formsRow.replaceChildren(...FORM_NAMES.map((n, i) => {
        const cv = el('canvas'); const fp = new Pet(cv, { scale: 3, spriteOnly: true }); fp.setSeed(active);
        const unlocked = i + 1 <= evo.stage; fp.setForm(i + 1, i + 1 === evo.stage ? evo.fat : 0); if (!unlocked) fp.setLocked(true);
        return el('div', { class: 'form', 'aria-current': String(i + 1 === evo.stage), title: unlocked ? n : 'Keep eating to find out…' }, cv, el('span', { text: unlocked ? n : '???' }));
      }));
      evoFill.style.width = Math.round(evo.progress * 100) + '%'; evoBar.setAttribute('aria-valuenow', Math.round(evo.progress * 100));
      evoNote.textContent = evo.next ? `${fmtTokens(evo.next - evo.eaten)} more tokens to evolve into ${evo.nextName}. Your pet grows rounder as it eats.` : 'Fully evolved! It keeps getting rounder the more you feed it.';
      const spec = M.generate(active);
      const isSaved = saved.includes(active) || active === s.signature;
      save.disabled = isSaved || saved.length >= MAX;
      save.lastChild.textContent = isSaved ? 'Saved' : 'Save';
      note.hidden = isSaved;
      if (!isSaved) note.replaceChildren(el('b', { text: spec.name }), saved.length >= MAX ? ' is new — your collection is full, remove one to keep it.' : ' is new and not saved yet. Save to keep it, or generate another.');
      count.textContent = `${saved.length} of ${MAX} saved · generate as many as you like`;
      const nodes = [slot(s.signature, 'You', false)];
      for (let i = 0; i < MAX; i++) nodes.push(saved[i] ? slot(saved[i], '', true) : el('div', { class: 'slot empty-slot', 'aria-hidden': 'true' }, el('span', { class: 'sname', text: 'Empty' })));
      slotsBox.replaceChildren(...nodes);
    },
    setActive() {},
  };
}
