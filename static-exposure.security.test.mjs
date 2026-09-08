import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

function loadPredicate() {
  const match = source.match(/function isServerOnlyPath\(pathname\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'isServerOnlyPath helper must exist');
  return vm.runInNewContext(`(${match[0]})`, { path });
}

test('static server blocks repository and server-only artifacts', () => {
  const isServerOnlyPath = loadPredicate();
  for (const pathname of [
    '/package.json',
    '/package-lock.json',
    '/biome.json',
    '/render.yaml',
    '/supabase-schema.sql',
    '/CLAUDE.md',
    '/tools/package.json',
    '/netlify/functions/estimate.js',
    '/server.js',
    '/estimate-security.test.cjs',
    '/client-auth-contract.test.mjs',
    '/x/../package.json',
    '/x/../package-lock.json',
    '/x/../biome.json',
    '/x/../tools/package.json',
  ]) {
    assert.equal(isServerOnlyPath(pathname), true, `${pathname} must be blocked`);
  }
});

test('static server preserves intentional public assets', () => {
  const isServerOnlyPath = loadPredicate();
  for (const pathname of ['/manifest.json', '/x/../manifest.json', '/sw.js', '/index.html', '/sitemap.xml', '/robots.txt']) {
    assert.equal(isServerOnlyPath(pathname), false, `${pathname} must remain public`);
  }
});

test('request path guard uses the server-only predicate', () => {
  assert.match(source, /if \(isServerOnlyPath\(pathname\)\)/);
});
