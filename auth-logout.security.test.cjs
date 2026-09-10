const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const ORIGIN = 'https://stackbid.app';
const SB_URL = 'https://project.supabase.co/';
const ANON = 'anon-key';
const TOKEN = 'jwt.token.value';

function setEnv(t, configured = true) {
  const old = { url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON_KEY };
  if (configured) {
    process.env.SUPABASE_URL = SB_URL;
    process.env.SUPABASE_ANON_KEY = ANON;
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_ANON_KEY;
  }
  t.after(() => {
    if (old.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = old.url;
    if (old.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = old.anon;
  });
}

function installFetch(t, impl) {
  const old = global.fetch;
  global.fetch = impl;
  t.after(() => { global.fetch = old; });
}

function event(options = {}) {
  const { method = 'POST', cookie } = options;
  const origin = Object.hasOwn(options, 'origin') ? options.origin : ORIGIN;
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (cookie !== undefined) headers.cookie = cookie;
  return { httpMethod: method, headers };
}

function handler() {
  return require('./netlify/functions/auth-logout').handler;
}

function cookies(res) {
  return res.multiValueHeaders && res.multiValueHeaders['Set-Cookie'];
}

test('server wires /api/auth/logout and gives it an explicit strict rate limit', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /'auth\/logout':\s*require\('\.\/netlify\/functions\/auth-logout'\)/);
  assert.match(source, /'auth\/logout':\s*\{\s*max:\s*10,\s*window:\s*600000\s*\}/);
});

test('wrong or missing Origin => 403, no upstream, no cookie mutation', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return { ok: true, status: 204 }; });
  for (const origin of [undefined, 'https://evil.example', 'https://stackbid.app.evil.example']) {
    const res = await handler()(event({ origin, cookie: `sb_access_token=${TOKEN}` }));
    assert.equal(res.statusCode, 403);
    assert.equal(cookies(res), undefined);
  }
  assert.equal(calls, 0);
});

test('OPTIONS from exact Origin => 204 without upstream or cookies', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return { ok: true, status: 204 }; });
  const res = await handler()(event({ method: 'OPTIONS' }));
  assert.equal(res.statusCode, 204);
  assert.equal(calls, 0);
  assert.equal(cookies(res), undefined);
  assert.match(res.headers['Access-Control-Allow-Methods'], /POST/);
});

test('unsupported method => 405 without upstream or cookies', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return { ok: true, status: 204 }; });
  const res = await handler()(event({ method: 'GET', cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(res.statusCode, 405);
  assert.equal(calls, 0);
  assert.equal(cookies(res), undefined);
  assert.match(res.headers.Allow, /POST/);
});

test('no or malformed session => idempotent 204 and clears both cookies without upstream', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return { ok: true, status: 204 }; });
  for (const cookie of [undefined, 'sb_access_token=', `sb_access_token=${TOKEN}; sb_access_token=other.token`]) {
    const res = await handler()(event({ cookie }));
    assert.equal(res.statusCode, 204);
    assert.equal(cookies(res).length, 2);
  }
  assert.equal(calls, 0);
});

test('valid session calls local-scope Supabase logout and clears both cookies', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => {
    captured = { url: String(url), init };
    return { ok: true, status: 204 };
  });
  const res = await handler()(event({ cookie: `theme=dark; sb_access_token=${TOKEN}` }));
  assert.equal(res.statusCode, 204);
  assert.equal(captured.url, 'https://project.supabase.co/auth/v1/logout?scope=local');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.apikey, ANON);
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(cookies(res).length, 2);
});

test('upstream 401 is already logged out locally; clears cookies with 204', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 401 }));
  const res = await handler()(event({ cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(res.statusCode, 204);
  assert.equal(cookies(res).length, 2);
});

test('upstream 403 is not confirmed revocation; returns generic 503 and clears cookies', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 403 }));
  const res = await handler()(event({ cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'Service unavailable' });
  assert.equal(cookies(res).length, 2);
});

test('identity parser exception fails closed and still clears cookies', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return { ok: true, status: 204 }; });

  const identityPath = require.resolve('./netlify/functions/_auth-identity');
  const logoutPath = require.resolve('./netlify/functions/auth-logout');
  const originalIdentity = require(identityPath);
  require.cache[identityPath].exports = {
    ...originalIdentity,
    parseAccessToken() { throw new Error('private parser failure'); },
  };
  delete require.cache[logoutPath];
  t.after(() => {
    require.cache[identityPath].exports = originalIdentity;
    delete require.cache[logoutPath];
  });

  const res = await require(logoutPath).handler(event({ cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'Service unavailable' });
  assert.equal(res.body.includes('private parser failure'), false);
  assert.equal(cookies(res).length, 2);
  assert.equal(calls, 0);
});

test('upstream 5xx/network/missing config => generic 503 but still clears local cookies', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 500 }));
  const upstream = await handler()(event({ cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(upstream.statusCode, 503);
  assert.deepEqual(JSON.parse(upstream.body), { error: 'Service unavailable' });
  assert.equal(cookies(upstream).length, 2);

  installFetch(t, async () => { throw new Error('private failure'); });
  const network = await handler()(event({ cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(network.statusCode, 503);
  assert.equal(network.body.includes('private failure'), false);
  assert.equal(cookies(network).length, 2);

  setEnv(t, false);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return { ok: true, status: 204 }; });
  const config = await handler()(event({ cookie: `sb_access_token=${TOKEN}` }));
  assert.equal(config.statusCode, 503);
  assert.equal(calls, 0);
  assert.equal(cookies(config).length, 2);
});

test('cookie clears are separate, secure, HttpOnly, SameSite and never leak token', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: true, status: 204 }));
  const res = await handler()(event({ cookie: `sb_access_token=${TOKEN}` }));
  const values = cookies(res);
  assert.equal(values.length, 2);
  assert.match(values[0], /^sb_access_token=;/);
  assert.match(values[1], /^sb_refresh_token=;/);
  for (const value of values) {
    assert.match(value, /Max-Age=0/);
    assert.match(value, /Path=\//);
    assert.match(value, /HttpOnly/);
    assert.match(value, /Secure/);
    assert.match(value, /SameSite=Lax/);
    assert.equal(value.includes(TOKEN), false);
  }
  assert.equal(res.body.includes(TOKEN), false);
  assert.equal(res.headers['Access-Control-Allow-Origin'], ORIGIN);
  assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
