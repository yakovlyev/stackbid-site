const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(new URL('./my-estimates.html', `file://${__dirname}/`), 'utf8');

function loadEscapeHtml() {
  const match = html.match(/function escapeHtml\(value\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(match, 'my-estimates.html must define escapeHtml(value)');
  return vm.runInNewContext(`(${match[0]})`);
}

test('escapeHtml neutralizes executable markup from stored estimate fields', () => {
  const escapeHtml = loadEscapeHtml();
  const marker = '<img src=x onerror="globalThis.pwned=1"> & \'quoted\'';
  const escaped = escapeHtml(marker);
  assert.equal(escaped, '&lt;img src=x onerror=&quot;globalThis.pwned=1&quot;&gt; &amp; &#39;quoted&#39;');
  assert.equal(escaped.includes('<img'), false);
});

test('estimate title, project type, and ZIP are escaped before innerHTML rendering', () => {
  assert.match(html, /escapeHtml\(e\.title \|\| e\.project_type \|\| 'Estimate'\)/);
  assert.match(html, /escapeHtml\(e\.zip \|\| '—'\)/);
});
