import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import agent from '../offer-barrier-agent.js';

test('escapeHtml escapes dangerous characters', () => {
  assert.equal(agent.escapeHtml(`<b>&'"`), '&lt;b&gt;&amp;&#39;&quot;');
});

test('buildReportHtml reports clean when nothing found', () => {
  const html = agent.buildReportHtml({ 'terms.html': [], 'index.html': [] });
  assert.match(html, /рискованных формулировок не найдено/);
});

test('buildReportHtml renders one section per file with findings, skips clean files', () => {
  const html = agent.buildReportHtml({
    'terms.html': [],
    'index.html': [{ quote: 'guaranteed exact price', risk: 'implies a binding guarantee', suggested_fix: 'estimated price range' }],
  });
  assert.match(html, /index\.html/);
  assert.ok(!html.includes('<h4>terms.html</h4>'));
  assert.match(html, /guaranteed exact price/);
});

test('buildReportHtml escapes finding text (model output could echo attacker-influenced page content)', () => {
  const html = agent.buildReportHtml({
    'index.html': [{ quote: '<script>alert(1)</script>', risk: 'x', suggested_fix: 'y' }],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('readTextSafely returns null for a missing file instead of throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'offer-barrier-test-'));
  assert.equal(agent.readTextSafely(dir, 'does-not-exist.html'), null);
});

test('readTextSafely returns real file content when the file exists', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'offer-barrier-test-'));
  writeFileSync(path.join(dir, 'sample.html'), '<p>hello</p>');
  assert.equal(agent.readTextSafely(dir, 'sample.html'), '<p>hello</p>');
});
