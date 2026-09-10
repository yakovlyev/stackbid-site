import { test } from 'vitest';
import assert from 'node:assert/strict';

const { handler } = await import('../netlify/functions/auth-logout.js');

test('rejects non-POST methods', async () => {
  const res = await handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('clears the session cookie with Max-Age=0 and the same security attributes it was set with', async () => {
  const res = await handler({ httpMethod: 'POST' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Set-Cookie'], /sb_session=;/);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
  assert.match(res.headers['Set-Cookie'], /HttpOnly/);
  assert.match(res.headers['Set-Cookie'], /Secure/);
  assert.match(res.headers['Set-Cookie'], /SameSite=Lax/);
});
