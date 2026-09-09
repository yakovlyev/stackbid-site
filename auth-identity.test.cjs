// TDD tests for netlify/functions/_auth-identity.js — the shared identity
// boundary used by auth-session.js and get-estimates.js. Proves: exactly-one
// sb_access_token cookie parsing, malformed/duplicate rejection, 5s bounded
// Supabase Auth call, strict non-empty bounded UUID-like user.id validation,
// and that the returned internal identity never carries the token or upstream
// PII (email etc.).
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveIdentity, parseAccessToken, REASONS, AUTH_TIMEOUT_MS } = require('./netlify/functions/_auth-identity');

const SUPABASE_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon-key-123';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.sig_abc-def-123';
const USER_ID = '3f9c1a7e-2b5d-4e6f-8a2b-c1d2e3f4a5b6';

function setAuthEnv(t) {
  const savedUrl = process.env.SUPABASE_URL;
  const savedAnon = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (savedAnon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = savedAnon;
  });
}

function installFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
}

function cookieHeader(value) {
  return `session=abc; sb_access_token=${value}; theme=dark`;
}

test('AUTH_TIMEOUT_MS is exactly 5000ms (bounded upstream call)', () => {
  assert.equal(AUTH_TIMEOUT_MS, 5000);
});

test('parseAccessToken: absent header => none', () => {
  assert.deepEqual(parseAccessToken(undefined), { status: 'none' });
  assert.deepEqual(parseAccessToken(''), { status: 'none' });
  assert.deepEqual(parseAccessToken('session=abc; theme=dark'), { status: 'none' });
});

test('parseAccessToken: exactly one well-formed token => ok', () => {
  assert.deepEqual(parseAccessToken(cookieHeader(TOKEN)), { status: 'ok', token: TOKEN });
});

test('parseAccessToken: malformed or duplicate tokens => malformed', () => {
  for (const bad of ['', '   ', '=', ';', 'some token with spaces', 'abc"def']) {
    assert.equal(parseAccessToken(cookieHeader(bad)).status, 'malformed', `value ${JSON.stringify(bad)}`);
  }
  const dup = `sb_access_token=${TOKEN}; sb_access_token=other.jwt.token`;
  assert.equal(parseAccessToken(dup).status, 'malformed');
});

test('parseAccessToken: oversized token (>2048) rejected, 2048 accepted', () => {
  assert.equal(parseAccessToken(cookieHeader('a'.repeat(2049))).status, 'malformed');
  const ok2048 = 'a'.repeat(2048);
  assert.deepEqual(parseAccessToken(cookieHeader(ok2048)), { status: 'ok', token: ok2048 });
});

test('resolveIdentity: no cookie => NO_TOKEN without upstream fetch', async (t) => {
  setAuthEnv(t);
  let called = false;
  installFetch(t, async () => {
    called = true;
    return { ok: true, status: 200 };
  });
  const r = await resolveIdentity({ headers: {} });
  assert.deepEqual(r, { ok: false, reason: REASONS.NO_TOKEN });
  assert.equal(called, false);
});

test('resolveIdentity: malformed or duplicate token => MALFORMED without upstream fetch', async (t) => {
  setAuthEnv(t);
  let called = false;
  installFetch(t, async () => {
    called = true;
    return { ok: true, status: 200 };
  });
  for (const header of [cookieHeader(''), `sb_access_token=${TOKEN}; sb_access_token=other.jwt.token`]) {
    const r = await resolveIdentity({ headers: { cookie: header } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, REASONS.MALFORMED);
  }
  assert.equal(called, false);
});

test('resolveIdentity: missing SUPABASE_URL/ANON_KEY => MISCONFIGURED without upstream fetch', async (t) => {
  const savedUrl = process.env.SUPABASE_URL;
  const savedAnon = process.env.SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = savedUrl;
    if (savedAnon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = savedAnon;
  });
  let called = false;
  installFetch(t, async () => {
    called = true;
    return { ok: true, status: 200 };
  });
  const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(r, { ok: false, reason: REASONS.MISCONFIGURED });
  assert.equal(called, false);
});

test('resolveIdentity: valid token => /auth/v1/user with anon key, Bearer token, 5s AbortSignal', async (t) => {
  setAuthEnv(t);
  let captured;
  installFetch(t, async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ id: USER_ID }) };
  });
  const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(r, { ok: true, authUserId: USER_ID });
  assert.equal(captured.url, `${SUPABASE_URL}/auth/v1/user`);
  assert.equal(captured.init.headers.apikey, ANON_KEY);
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(captured.init.headers.Accept, 'application/json');
  assert.ok(captured.init.signal instanceof AbortSignal);
});

test('resolveIdentity: 2xx but missing/non-UUID/oversized id => INVALID', async (t) => {
  setAuthEnv(t);
  for (const id of [undefined, '', 'abc-123', 'u_123', 'not uuid', 123, 'x'.repeat(129)]) {
    installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ id }) }));
    const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
    assert.deepEqual(r, { ok: false, reason: REASONS.INVALID }, `id ${JSON.stringify(id)}`);
  }
});

test('resolveIdentity: 2xx with uppercase UUID accepted', async (t) => {
  setAuthEnv(t);
  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ id: USER_ID.toUpperCase() }) }));
  const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(r.ok, true);
  assert.equal(r.authUserId, USER_ID.toUpperCase());
});

test('resolveIdentity: upstream 401/403 => UNAUTHORIZED, upstream error body never parsed', async (t) => {
  setAuthEnv(t);
  for (const status of [401, 403]) {
    let parsed = false;
    installFetch(t, async () => ({
      ok: false,
      status,
      json: async () => {
        parsed = true;
        return { error: 'validJWT', user: { email: 'leak@example.com' } };
      },
    }));
    const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
    assert.deepEqual(r, { ok: false, reason: REASONS.UNAUTHORIZED });
    assert.equal(parsed, false, '401/403 body must not be parsed');
  }
});

test('resolveIdentity: upstream 5xx => UNAVAILABLE', async (t) => {
  setAuthEnv(t);
  installFetch(t, async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
  const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(r, { ok: false, reason: REASONS.UNAVAILABLE });
});

test('resolveIdentity: 2xx with unparseable JSON => INVALID', async (t) => {
  setAuthEnv(t);
  installFetch(t, async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error('bad json');
    },
  }));
  const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(r, { ok: false, reason: REASONS.INVALID });
});

test('resolveIdentity: network failure => UNAVAILABLE', async (t) => {
  setAuthEnv(t);
  installFetch(t, async () => {
    throw new Error('network down');
  });
  const r = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(r, { ok: false, reason: REASONS.UNAVAILABLE });
});

test('resolveIdentity: result never contains token or upstream email/PII', async (t) => {
  setAuthEnv(t);
  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ id: USER_ID, email: 'leak@example.com', phone: '555-0100' }) }));
  const ok = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(Object.keys(ok).sort(), ['authUserId', 'ok']);
  assert.equal(JSON.stringify(ok).includes('leak@example.com'), false);
  assert.equal(JSON.stringify(ok).includes(TOKEN), false);

  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ id: 'not-uuid', email: 'leak@example.com' }) }));
  const invalid = await resolveIdentity({ headers: { cookie: cookieHeader(TOKEN) } });
  assert.deepEqual(invalid, { ok: false, reason: REASONS.INVALID });
  assert.equal(JSON.stringify(invalid).includes('leak@example.com'), false);
  assert.equal(JSON.stringify(invalid).includes(TOKEN), false);
});