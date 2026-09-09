import { test } from 'vitest';
import assert from 'node:assert/strict';

import reviewer from '../nika-reviewer.js';

test('escapeHtml escapes all dangerous characters', () => {
  const result = reviewer.escapeHtml(`<script>alert("x")</script>&'`);
  assert.equal(result, '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;');
});

test('escapeHtml handles null/undefined safely', () => {
  assert.equal(reviewer.escapeHtml(null), '');
  assert.equal(reviewer.escapeHtml(undefined), '');
});

test('buildReportHtml reports a clean run when nothing flagged', () => {
  const html = reviewer.buildReportHtml([], 12);
  assert.match(html, /12 новых диалогов/);
  assert.match(html, /нарушений не найдено/);
});

test('buildReportHtml renders a table row per flagged conversation', () => {
  const html = reviewer.buildReportHtml(
    [{ severity: 'high', violation: 'fabricated_price', quote: 'it will definitely cost $500' }],
    5
  );
  assert.match(html, /high/);
  assert.match(html, /fabricated_price/);
  assert.match(html, /it will definitely cost \$500/);
});

test('buildReportHtml escapes attacker-controlled quote text (the response text came from a real user chat)', () => {
  const html = reviewer.buildReportHtml(
    [{ severity: 'low', violation: 'off_topic', quote: '<img src=x onerror=alert(1)>' }],
    1
  );
  assert.ok(!html.includes('<img src=x onerror'));
  assert.match(html, /&lt;img/);
});
