'use strict';
/**
 * Secret codes that unlock special pets. The repo is public, so only hashes live here: reading the source doesn't
 * give the words away. Codes are case- and space-insensitive. To add one: node -e "console.log(require('./src/core/secrets').hash('word'))"
 */
const crypto = require('crypto');

const hash = (word) => crypto.createHash('sha256').update('tokkie:' + String(word).toLowerCase().replace(/\s+/g, '')).digest('hex').slice(0, 24);

const CODES = {
  '0f1dd2031f2b8d6301998cfa': 'rainbow',
  '99b8b3b54d7fb159733fc47b': 'unicorn',
  '3b507263526a5d25930d09f7': 'golden',
  '9b34591271484f9042be4a18': 'shadow',
  'ca1e56a81107a5da73d398be': 'diamond',
  '721258c91431597dca1f7d6e': 'glass',
  'fc9d74ab42dd567cd87e20d1': 'golden',
};

/** The special kind a code unlocks, or null. */
function redeem(code) { const w = String(code || '').trim(); return w && w.length <= 64 ? CODES[hash(w)] || null : null; }

module.exports = { redeem, hash };
