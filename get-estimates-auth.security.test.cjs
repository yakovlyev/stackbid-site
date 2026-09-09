const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SUPABASE_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon-key';
const SERVICE_KEY = 'service-key';
const TOKEN = 'jwt.token.value';
const AUTH_ID = '3f9c1a7e-2b5d-4e6f-8a2b-c1d2e3f4a5b6';
const USER_ID = '7b8c90aa-3344-4566-8788-9900aabbccdd';

function setEnv(t, enabled = true) {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'STACKBID_AUTH_IDENTITY_ROLLOUT'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  if (enabled) process.env.STACKBID_AUTH_IDENTITY_ROLLOUT = 'enabled';
  else delete process.env.STACKBID_AUTH_IDENTITY_ROLLOUT;
  t.after(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
}

function installFetch(t, impl) {
  const old = global.fetch;
  global.fetch = impl;
  t.after(() => { global.fetch = old; });
}

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function loadHandler() {
  return require('./netlify/functions/get-estimates-auth').handler;
}

test('v2 endpoint is not wired into the legacy local API map', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.doesNotMatch(source, /get-estimates-auth/);
});

test('rollout disabled => 404 and zero upstream work', async (t) => {
  setEnv(t, false);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return response(200, {}); });
  const res = await loadHandler()({ httpMethod: 'GET', headers: { cookie: `sb_access_token=${TOKEN}` } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Not found' });
  assert.equal(calls, 0);
});

test('rollout enabled but no session => 401 and zero upstream work', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return response(200, {}); });
  const res = await loadHandler()({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test('authenticated history uses auth_user_id only and ignores caller email/body', async (t) => {
  setEnv(t);
  const calls = [];
  installFetch(t, async (url, init) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value.includes('/auth/v1/user')) return response(200, { id: AUTH_ID, email: 'private@example.com' });
    if (value.includes('/rest/v1/users')) return response(200, [{ id: USER_ID, is_pro: false, first_name: 'Ann' }]);
    if (value.includes('/rest/v1/estimates')) return response(200, [{ id: 'e1', title: '<img onerror=x>', project_type: 'deck', zip: '90210', total_retail: 100, created_at: '2026-01-01' }]);
    return response(404, {});
  });
  const res = await loadHandler()({
    httpMethod: 'GET',
    headers: { cookie: `sb_access_token=${TOKEN}` },
    queryStringParameters: { email: 'attacker@example.com' },
    body: JSON.stringify({ email: 'attacker@example.com', token: 'stolen' }),
  });
  assert.equal(res.statusCode, 200);
  const users = calls.find((call) => call.url.includes('/rest/v1/users'));
  assert.match(users.url, new RegExp(`auth_user_id=eq\\.${AUTH_ID}`));
  assert.equal(users.url.includes('email=eq.'), false);
  const estimates = calls.find((call) => call.url.includes('/rest/v1/estimates'));
  assert.match(estimates.url, new RegExp(`user_id=eq\\.${USER_ID}`));
  assert.equal(users.init.headers.Authorization, `Bearer ${SERVICE_KEY}`);
  assert.ok(users.init.signal instanceof AbortSignal);
  const body = JSON.parse(res.body);
  assert.equal(body.estimates[0].title, '<img onerror=x>');
  assert.equal(res.body.includes(TOKEN), false);
  assert.equal(res.body.includes('private@example.com'), false);
});

test('invalid internal user id fails closed before estimates lookup', async (t) => {
  setEnv(t);
  const calls = [];
  installFetch(t, async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/auth/v1/user')) return response(200, { id: AUTH_ID });
    if (value.includes('/rest/v1/users')) return response(200, [{ id: 'not-a-uuid', is_pro: false }]);
    return response(200, []);
  });
  const res = await loadHandler()({ httpMethod: 'GET', headers: { cookie: `sb_access_token=${TOKEN}` } });
  assert.equal(res.statusCode, 503);
  assert.equal(calls.some((url) => url.includes('/rest/v1/estimates')), false);
});

test('unexpected identity resolver exception => generic 503 with CORS and no-store', async (t) => {
  setEnv(t);
  const helperPath = require.resolve('./netlify/functions/_auth-identity');
  const handlerPath = require.resolve('./netlify/functions/get-estimates-auth');
  const helper = require(helperPath);
  const original = helper.resolveIdentity;
  helper.resolveIdentity = async () => {
    throw new Error('must not leak');
  };
  delete require.cache[handlerPath];
  t.after(() => {
    helper.resolveIdentity = original;
    delete require.cache[handlerPath];
  });

  const res = await require(handlerPath).handler({ httpMethod: 'GET', headers: {} });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(res.body), { error: 'Service unavailable' });
  assert.equal(res.body.includes('must not leak'), false);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://stackbid.app');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('malformed identity resolver result => generic 503 before database work', async (t) => {
  setEnv(t);
  const helperPath = require.resolve('./netlify/functions/_auth-identity');
  const handlerPath = require.resolve('./netlify/functions/get-estimates-auth');
  const helper = require(helperPath);
  const original = helper.resolveIdentity;
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls += 1;
    return response(200, []);
  });

  for (const malformed of [
    null,
    { ok: true },
    { ok: true, authUserId: 'not-a-uuid' },
    { ok: 2, authUserId: AUTH_ID },
  ]) {
    helper.resolveIdentity = async () => malformed;
    delete require.cache[handlerPath];
    const res = await require(handlerPath).handler({ httpMethod: 'GET', headers: {} });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'Service unavailable' });
  }
  assert.equal(fetchCalls, 0);
  t.after(() => {
    helper.resolveIdentity = original;
    delete require.cache[handlerPath];
  });
});

test('non-GET methods fail closed and every response is no-store with exact CORS', async (t) => {
  setEnv(t);
  installFetch(t, async () => response(500, {}));
  for (const event of [
    { httpMethod: 'POST', headers: {} },
    { httpMethod: 'OPTIONS', headers: {} },
    { httpMethod: 'GET', headers: {} },
  ]) {
    const res = await loadHandler()(event);
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://stackbid.app');
    assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});
