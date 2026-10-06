'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, weighted, headline } = require('../src/core/parser');
const { A, U, TR } = require('./helpers');
const T = Date.parse('2026-10-06T10:00:00Z');

test('assistant message becomes a usage event', () => {
  const e = parseLine(A(T, 'm1', { o: 321, stop: 'end_turn' }));
  assert.equal(e.kind, 'usage'); assert.equal(e.output, 321); assert.equal(e.ending, true); assert.equal(e.id, 'm1');
});
test('tool_use stop is not an end of turn', () => assert.equal(parseLine(A(T, 'm1', { stop: 'tool_use' })).ending, false));
test('sub-agent messages count tokens but never end the turn', () => {
  const e = parseLine(A(T, 'm2', { side: true, stop: 'end_turn' }));
  assert.equal(e.sidechain, true); assert.equal(e.ending, false);
});
test('human prompt vs tool result vs meta', () => {
  assert.equal(parseLine(U(T, 'hello there')).kind, 'prompt');
  assert.equal(parseLine(U(T, 'hello there')).chars, 11);
  assert.equal(parseLine(TR(T)), null);
  assert.equal(parseLine(U(T, 'x', { meta: true })), null);
  assert.equal(parseLine(U(T, 'x', { side: true })), null);
  assert.equal(parseLine(U(T, 'x', { origin: { kind: 'task-notification' } })), null);
  assert.equal(parseLine(U(T, 'x', { origin: { kind: 'human' } })).kind, 'prompt');
});
test('interrupts and injected text are recognised', () => {
  assert.equal(parseLine(U(T, '[Request interrupted by user]')).kind, 'interrupt');
  assert.equal(parseLine(U(T, '<system-reminder>blah</system-reminder>')), null);
  assert.equal(parseLine(U(T, '<local-command-stdout>x</local-command-stdout>')), null);
});
test('image-only prompts still start a turn', () => {
  const l = JSON.stringify({ type: 'user', timestamp: new Date(T).toISOString(), sessionId: 's', message: { role: 'user', content: [{ type: 'image', source: {} }] } });
  assert.equal(parseLine(l).kind, 'prompt');
});
test('garbage never throws', () => {
  for (const bad of ['', '{', 'null', '[]', '{"type":"assistant"}', '{"type":"user","timestamp":"nope","message":{}}']) assert.equal(parseLine(bad), null);
});
test('token weighting discounts cache reads', () => {
  const e = { input: 10, output: 100, cacheWrite: 1000, cacheRead: 10000 };
  assert.equal(headline(e), 1110); assert.equal(weighted(e), 2110);
});
