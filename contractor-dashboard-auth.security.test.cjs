const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SUPABASE_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon-key';
const TOKEN = 'jwt.token.value';
const AUTH_ID = '3f9c1a7e-2b5d-4e6f-8a2b-c1d2e3f4a5b6';

function setEnv(t, enabled = true) {
  const names = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'STACKBID_CONTRACTOR_AUTH_ROLLOUT'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'must-not-be-used';
  if (enabled) process.env.STACKBID_CONTRACTOR_AUTH_ROLLOUT = 'enabled';
  else delete process.env.STACKBID_CONTRACTOR_AUTH_ROLLOUT;
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
  return require('./netlify/functions/contractor-dashboard-auth').handler;
}

function request(extra = {}) {
  return {
    httpMethod: 'GET',
    headers: { cookie: `sb_access_token=${TOKEN}` },
    queryStringParameters: { email: 'attacker@example.com', contractor_id: '999' },
    body: JSON.stringify({ email: 'attacker@example.com', contractor_id: '999' }),
    ...extra,
  };
}

test('staged contractor endpoint is not wired over the legacy API route', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.doesNotMatch(source, /contractor-dashboard-auth/);
});

test('rollout disabled => 404 and zero upstream work', async (t) => {
  setEnv(t, false);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return response(200, {}); });
  const res = await loadHandler()(request());
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'Not found' });
  assert.equal(calls, 0);
});

test('no session => 401 and zero upstream work', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => { calls += 1; return response(200, {}); });
  const res = await loadHandler()(request({ headers: {} }));
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test('authenticated GET uses auth UID plus user JWT and ignores caller identity', async (t) => {
  setEnv(t);
  const calls = [];
  installFetch(t, async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value.includes('/auth/v1/user')) return response(200, { id: AUTH_ID, email: 'private@example.com' });
    if (value.includes('/rest/v1/contractors')) {
      return response(200, [{ id: 42, company_name: '<b>Safe by client escaping</b>', subscription_tier: 'pro', subscription_active: true, leads_received: 3, leads_converted: 1, rating: 4.8, review_count: 5, license_verified: true, email: 'must-not-leak@example.com' }]);
    }
    if (value.includes('/rest/v1/contractor_leads')) {
      return response(200, [{ id: 9001, project_type: 'Deck', zip_code: '90210', budget_range: '$10k', status: 'new', created_at: '2026-01-01', contacted_at: null, user_email: 'must-not-leak@example.com' }]);
    }
    return response(404, {});
  });

  const res = await loadHandler()(request());
  assert.equal(res.statusCode, 200);
  const contractorCall = calls.find((call) => call.url.includes('/rest/v1/contractors'));
  assert.match(contractorCall.url, new RegExp(`auth_user_id=eq\\.${AUTH_ID}`));
  assert.equal(contractorCall.url.includes('email=eq.'), false);
  assert.equal(contractorCall.url.includes('999'), false);
  assert.equal(contractorCall.init.headers.apikey, ANON_KEY);
  assert.equal(contractorCall.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(contractorCall.init.headers.Authorization.includes('must-not-be-used'), false);
  assert.ok(contractorCall.init.signal instanceof AbortSignal);

  const leadCall = calls.find((call) => call.url.includes('/rest/v1/contractor_leads'));
  assert.match(leadCall.url, /contractor_id=eq\.42/);
  assert.equal(leadCall.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(leadCall.url, /limit=100/);

  const body = JSON.parse(res.body);
  assert.equal(body.found, true);
  assert.equal(body.contractor.id, 42);
  assert.equal(body.leads.length, 1);
  assert.equal(res.body.includes('private@example.com'), false);
  assert.equal(res.body.includes('must-not-leak@example.com'), false);
  assert.equal(res.body.includes(TOKEN), false);
});

test('authenticated but unclaimed identity => 403 without leads lookup', async (t) => {
  setEnv(t);
  const calls = [];
  installFetch(t, async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/auth/v1/user')) return response(200, { id: AUTH_ID });
    return response(200, []);
  });
  const res = await loadHandler()(request());
  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: 'Forbidden' });
  assert.equal(calls.some((url) => url.includes('/contractor_leads')), false);
});

test('malformed contractor identity or dependency failure => generic 503', async (t) => {
  setEnv(t);
  for (const contractorPayload of [[{ id: '../bad' }], { not: 'array' }]) {
    installFetch(t, async (url) => {
      const value = String(url);
      if (value.includes('/auth/v1/user')) return response(200, { id: AUTH_ID });
      if (value.includes('/rest/v1/contractors')) return response(200, contractorPayload);
      return response(200, []);
    });
    const res = await loadHandler()(request());
    assert.equal(res.statusCode, 503);
    assert.deepEqual(JSON.parse(res.body), { error: 'Service unavailable' });
  }
});

test('non-GET methods fail closed and responses are exact-CORS/no-store', async (t) => {
  setEnv(t);
  installFetch(t, async () => response(500, {}));
  for (const httpMethod of ['POST', 'PUT', 'DELETE']) {
    const res = await loadHandler()(request({ httpMethod }));
    assert.equal(res.statusCode, 405);
    assert.match(res.headers.Allow, /GET/);
  }
  const options = await loadHandler()(request({ httpMethod: 'OPTIONS' }));
  assert.equal(options.statusCode, 204);
  for (const res of [options, await loadHandler()(request({ headers: {} }))]) {
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://stackbid.app');
    assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});
