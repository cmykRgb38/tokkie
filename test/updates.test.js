'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate, compareVersions, safeReleaseUrl } = require('../src/core/updates');

test('version comparison', () => {
  assert.equal(compareVersions('1.0.44', '1.0.45'), -1);
  assert.equal(compareVersions('v1.0.45', '1.0.45'), 0);
  assert.equal(compareVersions('1.0.100', '1.0.99'), 1);
  assert.equal(compareVersions('1.1', '1.0.9'), 1);
});

test('a newer release is reported with its page; only Tokkie’s own release pages are ever opened', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push([url, opts]); return { ok: true, json: async () => ({ tag_name: 'v1.0.50', html_url: 'https://github.com/cmykRgb38/tokkie/releases/tag/v1.0.50' }) }; };
  const r = await checkForUpdate({ current: '1.0.44', fetchImpl });
  assert.deepEqual([r.ok, r.latest, r.newer, r.url], [true, '1.0.50', true, 'https://github.com/cmykRgb38/tokkie/releases/tag/v1.0.50']);
  assert.equal(seen.length, 1); assert.equal(seen[0][0], 'https://api.github.com/repos/cmykRgb38/tokkie/releases/latest');
  assert.equal(safeReleaseUrl('https://evil.example/x'), 'https://github.com/cmykRgb38/tokkie/releases');
  const same = await checkForUpdate({ current: '1.0.50', fetchImpl });
  assert.equal(same.newer, false);
});

test('offline, no releases or a strange answer: a calm "couldn’t check", never a crash', async () => {
  assert.equal((await checkForUpdate({ current: '1.0.0', fetchImpl: async () => { throw new Error('offline'); } })).ok, false);
  assert.match((await checkForUpdate({ current: '1.0.0', fetchImpl: async () => ({ ok: false, status: 404 }) })).error, /no releases/);
  assert.equal((await checkForUpdate({ current: '1.0.0', fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'nightly' }) }) })).ok, false);
});
