import { test } from 'vitest';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const originalFetch = global.fetch;
const { handler } = await import('../netlify/functions/auth-refresh.js');

test('rejects non-POST methods', async () => {
  const res = await handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('returns 401 when there is no refresh cookie at all', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {} });
  assert.equal(res.statusCode, 401);
});

test('returns 401 when Supabase rejects the refresh token (expired/revoked)', async () => {
  global.fetch = async () => ({ ok: false, status: 401 });
  try {
    const res = await handler({ httpMethod: 'POST', headers: { cookie: 'sb_refresh=stale-token' } });
    assert.equal(res.statusCode, 401);
  } finally {
    global.fetch = originalFetch;
  }
});

test('issues a fresh session cookie (and rotated refresh cookie) on a valid refresh token', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }) });
  try {
    const res = await handler({ httpMethod: 'POST', headers: { cookie: 'sb_refresh=good-refresh-token' } });
    assert.equal(res.statusCode, 200);
    const cookies = res.headers['Set-Cookie'];
    assert.ok(cookies.some((c) => c.startsWith('sb_session=new-access')));
    assert.ok(cookies.some((c) => c.startsWith('sb_refresh=new-refresh')));
  } finally {
    global.fetch = originalFetch;
  }
});
