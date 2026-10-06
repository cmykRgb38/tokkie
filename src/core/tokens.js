'use strict';
/**
 * Offline token estimator. Claude's tokenizer isn't public, so this is a calibrated heuristic:
 * typically within ~15% for English prose and code. Always display it as "≈".
 */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const TOKEN_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]|\p{Extended_Pictographic}|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+|\n+/gu;

function estimateTokens(text) {
  if (!text) return 0;
  let n = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const s = m[0];
    if (CJK.test(s)) n += 1.1;
    else if (/^\p{Extended_Pictographic}$/u.test(s)) n += 2.5;
    else if (s[0] === '\n') n += 1;
    else if (/^[\p{L}\p{N}_]+$/u.test(s)) n += s.length <= 4 ? 1 : Math.ceil(s.length / 4.2);
    else n += Math.ceil(s.length / 2); // punctuation / symbol runs
  }
  return Math.max(1, Math.round(n));
}

const HEAVY = /\b(build|create|implement|refactor|rewrite|migrate|redesign|research|investigate|audit|comprehensive|thorough(?:ly)?|entire|end[- ]to[- ]end|from scratch|full(?:y)?|deep[- ]research|ultracode|fable mode|test(?:s|ing)?|self[- ]improve|every(?:thing)?|all of)\b/gi;
const LIGHT = /\b(typo|rename|what is|what's|explain|quick(?:ly)?|summari[sz]e|tl;?dr|one[- ]liner|just|simple|small|tweak)\b/gi;

/** Multiplier (0.4–3) from wording alone — used as a weak prior, damped once we have personal history. */
function complexityHint(text) {
  if (!text) return 1;
  const heavy = (text.match(HEAVY) || []).length;
  const light = (text.match(LIGHT) || []).length;
  const list = (text.match(/^\s*(?:\d+[.)]|[-*•])\s+/gm) || []).length;
  let m = 1 + Math.min(heavy, 8) * 0.12 + Math.min(list, 12) * 0.07 - Math.min(light, 4) * 0.15;
  return Math.max(0.4, Math.min(3, m));
}

module.exports = { estimateTokens, complexityHint };
