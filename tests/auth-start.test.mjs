import { test } from 'vitest';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

const originalFetch = global.fetch;

const { handler } = await import('../netlify/functions/auth-start.js');

test('rejects non-POST methods', async () => {
  const res = await handler({ httpMethod: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('rejects invalid email format with a plain 400', async () => {
  const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'not-an-email' }) });
  assert.equal(res.statusCode, 400);
});

test('rejects malformed JSON body', async () => {
  const res = await handler({ httpMethod: 'POST', body: '{not json' });
  assert.equal(res.statusCode, 400);
});

test('returns the same generic 200 response for a real-looking email, regardless of whether it exists (anti-enumeration)', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  try {
    const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'real@example.com' }) });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.message, /If that email is registered/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('still returns the SAME generic 200 even if the Supabase call itself fails (never leaks internal errors)', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await handler({ httpMethod: 'POST', body: JSON.stringify({ email: 'real@example.com' }) });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.message, /If that email is registered/);
  } finally {
    global.fetch = originalFetch;
  }
});
