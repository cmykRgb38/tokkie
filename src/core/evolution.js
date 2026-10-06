'use strict';
/**
 * Pet growth. The pet "eats" the tokens you use (headline tokens: input + output + cache writes) from the day Tokkie is
 * first launched. Forms unlock at thresholds; inside a form the pet gets visibly chubbier as the stomach fills.
 */
const THRESHOLDS = [0, 2e6, 10e6, 40e6];                 // lifetime tokens eaten at which forms 1..4 begin
const NAMES = ['Hatchling', 'Junior', 'Champion', 'Mega'];
const MEGA_FAT_STEP = 40e6;                              // past Mega, one more chub level per +40M

function evolutionFor(eaten) {
  eaten = Math.max(0, Number(eaten) || 0);
  let stage = 1;
  for (let i = 0; i < THRESHOLDS.length; i++) if (eaten >= THRESHOLDS[i]) stage = i + 1;
  const from = THRESHOLDS[stage - 1], to = THRESHOLDS[stage] ?? null;
  const progress = to == null ? Math.min(1, (eaten - from) / (MEGA_FAT_STEP * 3)) : (eaten - from) / (to - from);
  const fat = to == null ? Math.min(2, Math.floor((eaten - from) / MEGA_FAT_STEP)) : progress < 1 / 3 ? 0 : progress < 2 / 3 ? 1 : 2;
  return { eaten, stage, name: NAMES[stage - 1], fat, progress: Math.min(1, progress), from, next: to, nextName: to == null ? null : NAMES[stage] };
}

module.exports = { THRESHOLDS, NAMES, evolutionFor };
