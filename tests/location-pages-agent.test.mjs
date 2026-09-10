import { test } from 'vitest';
import assert from 'node:assert/strict';

import agent from '../location-pages-agent.js';

test('extractJson parses a direct JSON response', () => {
  const result = agent.extractJson('{"title":"x","price_low":5000}');
  assert.deepEqual(result, { title: 'x', price_low: 5000 });
});

test('extractJson parses JSON wrapped in a markdown code fence', () => {
  const result = agent.extractJson('Here you go:\n```json\n{"title":"x"}\n```\nDone.');
  assert.deepEqual(result, { title: 'x' });
});

test('extractJson falls back to first-brace-to-last-brace extraction', () => {
  const result = agent.extractJson('Some preamble text { "title": "x" } trailing text');
  assert.deepEqual(result, { title: 'x' });
});

test('extractJson returns null for genuinely unparseable text', () => {
  assert.equal(agent.extractJson('no json here at all'), null);
});

test('CITIES and PROJECT_TYPES cover the 8 established launch regions', () => {
  assert.equal(agent.CITIES.length, 8);
  assert.ok(agent.CITIES.every((c) => c.slug && c.name));
  assert.ok(agent.PROJECT_TYPES.length >= 1);
});
