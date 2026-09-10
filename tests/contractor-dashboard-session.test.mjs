import { test } from 'vitest';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const originalFetch = global.fetch;
const mod = await import('../netlify/functions/contractor-dashboard.js');
const { handler, parseCookies, resolveContractorIdViaSession } = mod;

test('parseCookies parses a standard Cookie header', () => {
  assert.deepEqual(parseCookies('sb_session=abc123; other=xyz'), { sb_session: 'abc123', other: 'xyz' });
});

test('parseCookies handles a missing/empty header without throwing', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('resolveContractorIdViaSession returns null when there is no session cookie at all', async () => {
  const id = await resolveContractorIdViaSession({ headers: {} }, 'https://x.co', 'key');
  assert.equal(id, null);
});

test('resolveContractorIdViaSession returns null (not a throw) when Supabase says the token is invalid', async () => {
  global.fetch = async () => ({ ok: false, status: 401 });
  try {
    const id = await resolveContractorIdViaSession({ headers: { cookie: 'sb_session=bad-token' } }, 'https://x.co', 'key');
    assert.equal(id, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveContractorIdViaSession returns the contractor id bound to the verified auth uid', async () => {
  let call = 0;
  global.fetch = async () => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({ id: 'auth-uid-1' }) };
    return { ok: true, json: async () => ([{ id: 77 }]) };
  };
  try {
    const id = await resolveContractorIdViaSession({ headers: { cookie: 'sb_session=good-token' } }, 'https://x.co', 'key');
    assert.equal(id, 77);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET: a valid session for contractor A cannot be used to pull contractor B\u2019s data by passing a different email', async () => {
  // Сесія прив'язана до contractor id=1 (through auth_user_id), навіть якщо
  // хтось додасть ?email=b@company.com у запит, сесія завжди виграє.
  let call = 0;
  global.fetch = async (url) => {
    call += 1;
    if (call === 1) return { ok: true, json: async () => ({ id: 'auth-uid-1' }) }; // /auth/v1/user
    if (call === 2) return { ok: true, json: async () => ([{ id: 1 }]) }; // resolve auth_user_id -> contractor 1
    if (String(url).includes('contractors?id=eq.1')) return { ok: true, json: async () => ([{ id: 1, company_name: 'My Own Co' }]) };
    return { ok: true, json: async () => ([]) }; // leads
  };
  try {
    const res = await handler({
      httpMethod: 'GET',
      headers: { cookie: 'sb_session=good-token' },
      queryStringParameters: { email: 'attacker-supplied-b@company.com' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.found, true);
    assert.equal(body.contractor.company_name, 'My Own Co');
    assert.equal(body.viaSession, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET: legacy email path still works when there is no session cookie at all', async () => {
  let call = 0;
  global.fetch = async (url) => {
    call += 1;
    if (String(url).includes('contractors?email=eq.')) return { ok: true, json: async () => ([{ id: 5, company_name: 'Legacy Co' }]) };
    return { ok: true, json: async () => ([]) };
  };
  try {
    const res = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { email: 'legacy@example.com' } });
    const body = JSON.parse(res.body);
    assert.equal(body.found, true);
    assert.equal(body.viaSession, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST: session-authenticated contractor CANNOT change a lead belonging to a different contractor', async () => {
  let call = 0;
  global.fetch = async (url) => {
    call += 1;
    if (String(url).includes('contractor_leads?id=eq.')) return { ok: true, json: async () => ([{ contractor_id: 999 }]) }; // lead belongs to contractor 999
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'auth-uid-1' }) };
    if (String(url).includes('contractors?auth_user_id=eq.')) return { ok: true, json: async () => ([{ id: 1 }]) }; // caller is contractor 1, not 999
    return { ok: true, json: async () => ([]) };
  };
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { cookie: 'sb_session=good-token' },
      body: JSON.stringify({ lead_id: 42, status: 'won' }),
    });
    assert.equal(res.statusCode, 403);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST: session-authenticated contractor CAN change their own lead', async () => {
  let call = 0;
  global.fetch = async (url, opts) => {
    call += 1;
    if (String(url).includes('contractor_leads?id=eq.') && (!opts || opts.method !== 'PATCH')) return { ok: true, json: async () => ([{ contractor_id: 1 }]) };
    if (String(url).includes('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'auth-uid-1' }) };
    if (String(url).includes('contractors?auth_user_id=eq.')) return { ok: true, json: async () => ([{ id: 1 }]) };
    return { ok: true, json: async () => ([]) };
  };
  try {
    const res = await handler({
      httpMethod: 'POST',
      headers: { cookie: 'sb_session=good-token' },
      body: JSON.stringify({ lead_id: 42, status: 'contacted' }),
    });
    assert.equal(res.statusCode, 200);
  } finally {
    global.fetch = originalFetch;
  }
});
