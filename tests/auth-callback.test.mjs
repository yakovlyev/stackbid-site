import { test } from 'vitest';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const originalFetch = global.fetch;
const { handler } = await import('../netlify/functions/auth-callback.js');

function mockFetchSequence(responses) {
  let i = 0;
  global.fetch = async () => responses[Math.min(i++, responses.length - 1)];
}

test('rejects non-POST methods', async () => {
  const res = await handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('rejects a missing access_token', async () => {
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify({}) });
  assert.equal(res.statusCode, 400);
});

test('rejects a token Supabase itself says is invalid', async () => {
  try {
    mockFetchSequence([{ ok: false, status: 401 }]);
    const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ access_token: 'bad-token' }) });
    assert.equal(res.statusCode, 401);
  } finally {
    global.fetch = originalFetch;
  }
});

test('sets an HttpOnly Secure cookie and claims a matching unclaimed contractor row', async () => {
  try {
    mockFetchSequence([
      { ok: true, json: async () => ({ id: 'auth-uid-123', email: 'real@example.com' }) },
      { ok: true, json: async () => ([{ id: 42, auth_user_id: 'auth-uid-123' }]) },
    ]);
    const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ access_token: 'good-token' }) });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Set-Cookie'], /HttpOnly/);
    assert.match(res.headers['Set-Cookie'], /Secure/);
    assert.match(res.headers['Set-Cookie'], /SameSite=Lax/);
    const body = JSON.parse(res.body);
    assert.equal(body.claimed, true);
    assert.equal(body.redirect, '/contractor-dashboard.html');
  } finally {
    global.fetch = originalFetch;
  }
});

test('still issues a session even when no contractor row matches (claimed: false, not an error)', async () => {
  try {
    mockFetchSequence([
      { ok: true, json: async () => ({ id: 'auth-uid-999', email: 'nobody@example.com' }) },
      { ok: true, json: async () => ([]) },
    ]);
    const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ access_token: 'good-token' }) });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.claimed, false);
  } finally {
    global.fetch = originalFetch;
  }
});
