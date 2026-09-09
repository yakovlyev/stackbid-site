const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { handler } = require('./netlify/functions/auth-session');

const SUPABASE_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon-key-123';
const TOKEN = 'jwt-user-token-456';
const USER_ID = '3f9c1a7e-2b5d-4e6f-8a2b-c1d2e3f4a5b6';

function setEnv(t) {
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
  t.after(() => { global.fetch = original; });
}

function cookieHeader(value) {
  return `session=abc; sb_access_token=${value}; theme=dark`;
}

test('server.js wires the auth-session handler map entry', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /'auth-session':\s*require\('\.\/netlify\/functions\/auth-session'\)/);
});

test('GET with no Cookie header => 401, no upstream fetch, generic body', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const res = await handler({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
});

test('GET with cookies but without sb_access_token => 401, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const res = await handler({ httpMethod: 'GET', headers: { cookie: 'session=abc; theme=dark' } });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
});

test('GET with malformed sb_access_token values => 401, no upstream fetch', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => {
    calls += 1;
    return { ok: true, status: 200 };
  });
  for (const value of ['', '   ', '=', ';']) {
    await t.test(`malformed value ${JSON.stringify(value)}`, async () => {
      const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(value) } });
      assert.equal(res.statusCode, 401);
      assert.equal(calls, 0);
      assert.deepEqual(JSON.parse(res.body), { authenticated: false });
    });
  }
});

test('duplicate sb_access_token cookies => 401 without upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => {
    called = true;
    return { ok: true, status: 200 };
  });
  const res = await handler({
    httpMethod: 'GET',
    headers: { cookie: `sb_access_token=${TOKEN}; sb_access_token=other.jwt.token` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
});

test('valid cookie => validates against Supabase Auth and returns only basic flag', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ id: USER_ID, email: 'user@example.com' }) };
  });
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 200);
  assert.equal(captured.url, `${SUPABASE_URL}/auth/v1/user`);
  assert.equal(captured.init.headers.apikey, ANON_KEY);
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(res.body), { authenticated: true });
  assert.equal(res.body.includes(TOKEN), false);
  assert.equal(res.body.includes(USER_ID), false);
  assert.equal(res.body.includes('user@example.com'), false);
});

test('upstream 2xx with a non-UUID user id => 503 under canonical identity validation', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ id: 'u_123', email: 'user@example.com' }) }));
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
  assert.equal(res.body.includes('u_123'), false);
  assert.equal(res.body.includes('user@example.com'), false);
});

test('upstream 401 => 401 generic, upstream error/token never surfaced', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 401, json: async () => ({ error: 'validJWT', message: 'invalid token', user: { email: 'user@example.com' } }) }));
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
  assert.equal(res.body.includes('validJWT'), false);
  assert.equal(res.body.includes('user@example.com'), false);
  assert.equal(res.body.includes(TOKEN), false);
});

test('upstream 403 => 401 generic', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) }));
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
  assert.equal(res.body.includes('forbidden'), false);
});

test('upstream 5xx => 503 generic', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
  assert.equal(res.body.includes('boom'), false);
});

test('upstream network failure => 503 generic', async (t) => {
  setEnv(t);
  installFetch(t, async () => {
    throw new Error('network down');
  });
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
  assert.equal(res.body.includes(TOKEN), false);
});

test('missing config (no SUPABASE_URL / SUPABASE_ANON_KEY) => 503 without upstream fetch', async (t) => {
  const saved = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  t.after(() => {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
  });
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const res = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
  assert.deepEqual(JSON.parse(res.body), { authenticated: false });
});

test('POST / PUT / DELETE => 405 without upstream fetch', async (t) => {
  setEnv(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    let called = false;
    installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
    const res = await handler({ httpMethod: method, headers: { cookie: cookieHeader(TOKEN) } });
    assert.equal(res.statusCode, 405, `${method} must be 405`);
    assert.equal(called, false);
    assert.match(res.headers.Allow || '', /GET/);
  }
});

test('OPTIONS => 204 with CORS credentials headers, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const res = await handler({ httpMethod: 'OPTIONS', headers: {} });
  assert.equal(res.statusCode, 204);
  assert.equal(called, false);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://stackbid.app');
  assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
});

test('all response classes carry exact CORS origin, credentials, and no-store cache', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => {
    calls += 1;
    return calls === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 };
  });
  const ok = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  const unauthorized = await handler({ httpMethod: 'GET', headers: {} });
  const unavailable = await handler({ httpMethod: 'GET', headers: { cookie: cookieHeader(TOKEN) } });
  const methodNotAllowed = await handler({ httpMethod: 'POST', headers: {} });
  const options = await handler({ httpMethod: 'OPTIONS', headers: {} });
  for (const res of [ok, unauthorized, unavailable, methodNotAllowed, options]) {
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://stackbid.app');
    assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});