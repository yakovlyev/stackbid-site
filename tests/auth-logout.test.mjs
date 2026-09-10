import { test } from 'vitest';
import assert from 'node:assert/strict';

const { handler } = await import('../netlify/functions/auth-logout.js');

test('rejects non-POST methods', async () => {
  const res = await handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('clears both the session AND refresh cookies with Max-Age=0 and the same security attributes they were set with', async () => {
  const res = await handler({ httpMethod: 'POST' });
  assert.equal(res.statusCode, 200);
  const cookies = res.headers['Set-Cookie'];
  assert.ok(Array.isArray(cookies) && cookies.length === 2);
  for (const c of cookies) {
    assert.match(c, /Max-Age=0/);
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    assert.match(c, /SameSite=Lax/);
  }
  assert.ok(cookies.some((c) => c.startsWith('sb_session=;')));
  assert.ok(cookies.some((c) => c.startsWith('sb_refresh=;')));
});
