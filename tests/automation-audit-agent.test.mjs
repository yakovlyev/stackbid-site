import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import agent from '../automation-audit-agent.js';

function makeTempRepo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'automation-audit-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(dir, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test('escapeHtml escapes dangerous characters', () => {
  assert.equal(agent.escapeHtml(`<b>&'"`), '&lt;b&gt;&amp;&#39;&quot;');
});

test('MARKER_PATTERN matches known manual-process phrasings', () => {
  assert.ok(agent.MARKER_PATTERN.test('// TODO: wire this up'));
  assert.ok(agent.MARKER_PATTERN.test('Igor reviews these manually'));
  assert.ok(agent.MARKER_PATTERN.test('делается вручную пока что')); // eslint-disable-line
  assert.ok(!agent.MARKER_PATTERN.test('this is a fully automated process'));
});

test('scanRepo finds a marker in a real file and skips node_modules/.git/tests', () => {
  const dir = makeTempRepo({
    'foo.js': '// TODO: fix this\nconst x = 1;',
    'node_modules/pkg/index.js': '// TODO: should never be found',
    '.git/config': '// TODO: should never be found',
    'tests/foo.test.mjs': '// TODO: should never be found',
    'clean.html': '<p>Nothing to see here</p>',
  });
  const hits = agent.scanRepo(dir);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, 'foo.js');
  assert.equal(hits[0].line, 1);
});

test('scanRepo ignores non-.js/.html files', () => {
  const dir = makeTempRepo({ 'notes.md': '// TODO: markdown files are not scanned' });
  assert.equal(agent.scanRepo(dir).length, 0);
});

test('buildReportHtml reports clean when nothing found', () => {
  const html = agent.buildReportHtml([]);
  assert.match(html, /маркеров ручных процессов не найдено/);
});

test('buildReportHtml renders one row per hit with file:line', () => {
  const html = agent.buildReportHtml([{ file: 'foo.js', line: 5, text: '// TODO: x' }]);
  assert.match(html, /foo\.js:5/);
  assert.match(html, /TODO: x/);
});

test('buildReportHtml escapes hit text (could contain arbitrary code-comment content)', () => {
  const html = agent.buildReportHtml([{ file: 'foo.js', line: 1, text: '<script>alert(1)</script>' }]);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});
