import { test } from 'vitest';
import assert from 'node:assert/strict';

import agent from '../license-check-agent.js';

test('lookupUrlFor returns the direct official registry for a known state', () => {
  assert.equal(agent.lookupUrlFor('ca'), agent.STATE_LICENSE_LOOKUP.CA);
  assert.equal(agent.lookupUrlFor('CA'), agent.STATE_LICENSE_LOOKUP.CA);
});

test('lookupUrlFor falls back to a generic official-site search for an unlisted state', () => {
  const url = agent.lookupUrlFor('WY');
  assert.match(url, /google\.com\/search/);
  assert.match(url, /WY/);
  assert.match(url, /official/);
});

test('lookupUrlFor handles missing/empty state without throwing', () => {
  assert.doesNotThrow(() => agent.lookupUrlFor(null));
  assert.doesNotThrow(() => agent.lookupUrlFor(undefined));
  assert.doesNotThrow(() => agent.lookupUrlFor(''));
});

test('buildDigestHtml reports nothing-to-do when the list is empty', () => {
  const html = agent.buildDigestHtml([]);
  assert.match(html, /непроверенных подрядчиков.*нет/);
});

test('buildDigestHtml renders one row per contractor with an escaped, clickable link', () => {
  const html = agent.buildDigestHtml([{ company_name: 'Acme Roofing', state: 'CA', license_number: '123456' }]);
  assert.match(html, /Acme Roofing/);
  assert.match(html, /123456/);
  assert.match(html, new RegExp(agent.STATE_LICENSE_LOOKUP.CA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('buildDigestHtml escapes attacker-controlled company_name (free-text field at signup)', () => {
  const html = agent.buildDigestHtml([{ company_name: '<img src=x onerror=alert(1)>', state: 'TX', license_number: '1' }]);
  assert.ok(!html.includes('<img src=x onerror'));
  assert.match(html, /&lt;img/);
});
