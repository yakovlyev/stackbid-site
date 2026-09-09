// TDD tests for the FUTURE netlify/functions/auth-callback.js endpoint.
// Supabase redirects the browser here after the OTP magic link (the redirect
// target is baked into auth-start.js as CALLBACK_URL
// https://stackbid.app/api/auth/callback). The handler does not exist yet, so
// every behavioural test below is red until it is implemented. This file only
// codifies the contract — no production file was touched.
//
// Contract under test:
//   - GET only; everything else 405 (OPTIONS 204), no upstream work.
//   - Requires exactly one sb_auth_state and one sb_pkce_verifier cookie and a
//     query `code` + `state`; duplicates, malformed values and out-of-bounds
//     lengths are rejected without talking to Supabase.
//   - Timing-safe exact equality between query `state` and cookie
//     `sb_auth_state` (near-misses must fail).
//   - On success: POST SUPABASE_URL/auth/v1/token?grant_type=pkce with apikey
//     and JSON body { auth_code, code_verifier } under AbortSignal timeout;
//     returns 303 Location /my-estimates.html, Cache-Control "private, no-store",
//     empty body, and via multiValueHeaders a 4-cookie Set-Cookie array
//     (sb_access_token + sb_refresh_token set, sb_auth_state + sb_pkce_verifier
//     cleared with Max-Age=0).
//   - non-2xx / network error / malformed token payload all fail closed to a
//     303 Location /my-estimates.html?auth=failed and only clear the two
//     transient cookies.
//   - No open redirect: Location is hardcoded in every path, never derived from
//     query or cookies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SB_URL = 'https://project.supabase.co';
const ANON_KEY = 'anon-key-123';
const ACCESS_TOKEN = 'jwt-access-token.abc.def';
const REFRESH_TOKEN = 'jwt-refresh-token.123.456';
const USER_ID = 'u_123';
const USER_EMAIL = 'user@example.com';

// Matches what auth-start.js generates: randomBytes(32) -> 43 char verifier,
// randomBytes(16) -> 22 char state; auth code is opaque and arbitrary.
const VERIFIER = crypto.randomBytes(32).toString('base64url');
const STATE = crypto.randomBytes(16).toString('base64url');
const CODE = 'sb-pkce-auth-code-0987654321';

const FAIL_LOCATION = '/my-estimates.html?auth=failed';
const OK_LOCATION = '/my-estimates.html';
const TOKEN_ATTRS = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'];

function setEnv(t) {
  const saved = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
  };
  process.env.SUPABASE_URL = SB_URL;
  process.env.SUPABASE_ANON_KEY = ANON_KEY;
  t.after(() => {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
  });
}

function setEnvMissing(t) {
  const saved = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
  };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  t.after(() => {
    if (saved.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = saved.url;
    if (saved.anon === undefined) delete process.env.SUPABASE_ANON_KEY;
    else process.env.SUPABASE_ANON_KEY = saved.anon;
  });
}

function installFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => { global.fetch = original; });
}

// The handler does not exist yet: require() inside the test body so each test
// fails cleanly (red phase) instead of aborting the whole file at load time.
function loadHandler() {
  return require('./netlify/functions/auth-callback').handler;
}

function upstreamResponse(status, payload) {
  const isOk = status >= 200 && status < 300;
  return {
    ok: isOk,
    status,
    json: typeof payload === 'function' ? payload : async () => payload,
  };
}

function okTokenResponse() {
  return upstreamResponse(200, {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    user: { id: USER_ID, email: USER_EMAIL },
    expires_in: 3600,
  });
}

function cookieHeader(...pairs) {
  return pairs.map(([name, value]) => `${name}=${value}`).join('; ');
}

function makeEvent({ cookie, query, method = 'GET', headers = {} } = {}) {
  const ev = {
    httpMethod: method,
    headers: { ...headers },
    queryStringParameters: query || {},
  };
  if (cookie !== undefined) ev.headers.cookie = cookie;
  return ev;
}

function validEvent(overrides = {}) {
  return makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, state: STATE },
    ...overrides,
  });
}

function cookiesFrom(res) {
  const mvh = res.multiValueHeaders && res.multiValueHeaders['Set-Cookie'];
  return Array.isArray(mvh) ? mvh : [];
}

function findCookie(res, name) {
  return cookiesFrom(res).find((c) => c.startsWith(`${name}=`));
}

function locationOf(res) {
  return res.headers['Location'] || res.headers.location;
}

function cookieAttrs(cookie) {
  return cookie
    .split(';')
    .slice(1)
    .map((s) => s.trim());
}

function assertClearedOnly(res) {
  const cookies = cookiesFrom(res);
  assert.equal(res.headers['Set-Cookie'], undefined, 'must not use headers["Set-Cookie"]');
  assert.equal(res.headers['set-cookie'], undefined, 'must not use headers["set-cookie"]');
  assert.equal(cookies.length, 2, 'failure must emit exactly two clear cookies');
  const stateClear = findCookie(res, 'sb_auth_state');
  const verifierClear = findCookie(res, 'sb_pkce_verifier');
  assert.ok(stateClear, 'must clear sb_auth_state on failure');
  assert.ok(verifierClear, 'must clear sb_pkce_verifier on failure');
  for (const c of [stateClear, verifierClear]) {
    assert.match(c, /Max-Age=0/, 'cleared cookie must have Max-Age=0');
  }
  assert.equal(cookies.some((c) => c.startsWith('sb_access_token=')), false, 'no access token cookie on failure');
  assert.equal(cookies.some((c) => c.startsWith('sb_refresh_token=')), false, 'no refresh token cookie on failure');
  for (const c of cookies) {
    assert.equal(typeof c, 'string', 'each Set-Cookie entry must be a string');
    assert.equal(c.includes('\n'), false, 'cookie must not embed a newline');
  }
}

function assertFailClosed(res) {
  assert.ok(res.statusCode >= 300 && res.statusCode < 400, `must redirect, got ${res.statusCode}`);
  assert.equal(locationOf(res), FAIL_LOCATION, 'failure must redirect exactly to ' + FAIL_LOCATION);
  assertClearedOnly(res);
}

// ── Wiring / routing (the "except routing" carve-out) ──

test('server.js wires the auth/callback route to netlify/functions/auth-callback', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  // auth-start.js hardcodes CALLBACK_URL = https://stackbid.app/api/auth/callback,
  // so the handler map key MUST be 'auth/callback' (pathname -> apiMatch[1]).
  assert.match(source, /'auth\/callback':\s*require\('\.\/netlify\/functions\/auth-callback'\)/);
});

test('server.js passes parsed query parameters to netlify handlers', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /queryStringParameters:\s*parsed\.query/);
});

test('server.js adapter merges result.multiValueHeaders into response headers', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /result\.multiValueHeaders/, 'server adapter must consume result.multiValueHeaders');
});

test('server.js gives auth/callback an explicit strict rate limit', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /'auth\/callback':\s*\{\s*max:\s*10,\s*window:\s*600000\s*\}/);
});

// ── Method guards ──

test('POST / PUT / DELETE / PATCH => 405, no upstream fetch', async (t) => {
  setEnv(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    let called = false;
    installFetch(t, async () => { called = true; return okTokenResponse(); });
    const res = await loadHandler()(validEvent({ method }));
    assert.equal(res.statusCode, 405, `${method} must be 405`);
    assert.match(res.headers.Allow || '', /GET/);
    assert.equal(called, false, `${method} must not hit upstream`);
  }
});

test('OPTIONS => 204, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({ method: 'OPTIONS' }));
  assert.equal(res.statusCode, 204);
  assert.equal(called, false);
});

// ── Cookie requirements: exactly one sb_auth_state and one sb_pkce_verifier ──

test('no Cookie header => fail closed, clears, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({ query: { code: CODE, state: STATE } }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('missing sb_pkce_verifier cookie => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE]),
    query: { code: CODE, state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('missing sb_auth_state cookie => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('duplicate sb_auth_state cookie => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('duplicate sb_pkce_verifier cookie => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_pkce_verifier', VERIFIER], ['sb_pkce_verifier', VERIFIER], ['sb_auth_state', STATE]),
    query: { code: CODE, state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('malformed cookie values (empty / whitespace / "=" / non-base64url) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  for (const [label, bad] of [
    ['empty', ''],
    ['whitespace', '   '],
    ['equals', '='],
    ['padding', 'abc='],
    ['plus', `${VERIFIER.slice(0, 42)}+`],
    ['slash', `${STATE.slice(0, 21)}/`],
  ]) {
    let called = false;
    installFetch(t, async () => { called = true; return okTokenResponse(); });
    const res = await loadHandler()(makeEvent({
      cookie: cookieHeader(['sb_auth_state', bad], ['sb_pkce_verifier', bad]),
      query: { code: CODE, state: STATE },
    }));
    assertFailClosed(res);
    assert.equal(called, false, `${label} cookie value must not reach upstream`);
  }
});

test('verifier out of PKCE bounds (not 43-128 chars) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  for (const [label, bad] of [
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(129)],
  ]) {
    let called = false;
    installFetch(t, async () => { called = true; return okTokenResponse(); });
    const res = await loadHandler()(makeEvent({
      cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', bad]),
      query: { code: CODE, state: STATE },
    }));
    assertFailClosed(res);
    assert.equal(called, false, `${label} verifier must not reach upstream`);
  }
});

test('state cookie out of bounds (<8 or >128 chars) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  for (const [label, bad] of [
    ['too short', 'a'.repeat(7)],
    ['too long', 'a'.repeat(129)],
  ]) {
    let called = false;
    installFetch(t, async () => { called = true; return okTokenResponse(); });
    const res = await loadHandler()(makeEvent({
      cookie: cookieHeader(['sb_auth_state', bad], ['sb_pkce_verifier', VERIFIER]),
      query: { code: CODE, state: STATE },
    }));
    assertFailClosed(res);
    assert.equal(called, false, `${label} state cookie must not reach upstream`);
  }
});

// ── Query requirements: code + state ──

test('missing query code => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('missing query state => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('empty code / empty state query params => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: '', state: '' },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('duplicate code query param (array) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: [CODE, CODE], state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('duplicate state query param (array) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, state: [STATE, STATE] },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('oversized query code (>4096 chars) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: 'x'.repeat(4097), state: STATE },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('oversized query state (>256 chars) => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, state: 'x'.repeat(257) },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

// ── Timing-safe exact state equality ──

test('exact query state == cookie state => proceeds to token exchange', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async (url, init) => {
    called = true;
    return okTokenResponse();
  });
  const res = await loadHandler()(validEvent());
  assert.ok(res.statusCode >= 300 && res.statusCode < 400);
  assert.equal(called, true, 'exact state match must proceed to upstream');
});

test('mismatched valid state => fail closed, no upstream fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, state: crypto.randomBytes(16).toString('base64url') },
  }));
  assertFailClosed(res);
  assert.equal(called, false);
});

test('near-miss states (prefix / suffix / truncation) fail closed — equality must be exact', async (t) => {
  setEnv(t);
  const nearMisses = [STATE + 'x', 'x' + STATE, STATE.slice(0, -1), 'another-distinct-state-value-12345'];
  for (const near of nearMisses) {
    let called = false;
    installFetch(t, async () => { called = true; return okTokenResponse(); });
    const res = await loadHandler()(makeEvent({
      cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
      query: { code: CODE, state: near },
    }));
    assertFailClosed(res);
    assert.equal(called, false, `near-miss state ${JSON.stringify(near)} must not reach upstream`);
  }
});

// ── Upstream token exchange shape (success path) ──

test('success posts exact /auth/v1/token?grant_type=pkce with apikey and {auth_code, code_verifier}', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return okTokenResponse(); });
  const res = await loadHandler()(validEvent());
  assert.equal(res.statusCode, 303);
  assert.equal(captured.url, `${SB_URL}/auth/v1/token?grant_type=pkce`);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.apikey, ANON_KEY);
  const ct = captured.init.headers['Content-Type'] || captured.init.headers['content-type'];
  assert.match(ct, /application\/json/);
  assert.deepEqual(JSON.parse(captured.init.body), { auth_code: CODE, code_verifier: VERIFIER });
});

test('success uses AbortSignal timeout on the token exchange fetch', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return okTokenResponse(); });
  await loadHandler()(validEvent());
  assert.ok(captured.init.signal instanceof AbortSignal, 'signal must be AbortSignal');
});

// ── Success response ──

test('success returns 303 Location exactly /my-estimates.html and Cache-Control private, no-store', async (t) => {
  setEnv(t);
  installFetch(t, async () => okTokenResponse());
  const res = await loadHandler()(validEvent());
  assert.equal(res.statusCode, 303);
  assert.equal(locationOf(res), OK_LOCATION, 'success must redirect exactly to ' + OK_LOCATION);
  assert.match(res.headers['Cache-Control'], /private/);
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
});

test('success emits exactly four Set-Cookie via multiValueHeaders with required attributes', async (t) => {
  setEnv(t);
  installFetch(t, async () => okTokenResponse());
  const res = await loadHandler()(validEvent());
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers['Set-Cookie'], undefined, 'must not use headers["Set-Cookie"]');
  assert.equal(res.headers['set-cookie'], undefined, 'must not use headers["set-cookie"]');
  const cookies = cookiesFrom(res);
  assert.equal(cookies.length, 4, 'success must set 2 + clear 2 cookies');

  const access = findCookie(res, 'sb_access_token');
  const refresh = findCookie(res, 'sb_refresh_token');
  assert.ok(access, 'must set sb_access_token');
  assert.ok(refresh, 'must set sb_refresh_token');
  assert.ok(access.startsWith(`sb_access_token=${ACCESS_TOKEN}`), 'sb_access_token value must match token payload');
  assert.ok(refresh.startsWith(`sb_refresh_token=${REFRESH_TOKEN}`), 'sb_refresh_token value must match token payload');
  for (const c of [access, refresh]) {
    const attrs = cookieAttrs(c);
    for (const attr of TOKEN_ATTRS) {
      assert.equal(attrs.includes(attr), true, `session cookie must include ${attr}`);
    }
    assert.ok(attrs.some((a) => a.startsWith('Max-Age=')), 'session cookie must have Max-Age');
  }

  const stateClear = findCookie(res, 'sb_auth_state');
  const verifierClear = findCookie(res, 'sb_pkce_verifier');
  assert.ok(stateClear, 'success must clear sb_auth_state');
  assert.ok(verifierClear, 'success must clear sb_pkce_verifier');
  assert.match(stateClear, /Max-Age=0/);
  assert.match(verifierClear, /Max-Age=0/);
  for (const c of cookies) {
    assert.equal(c.includes('\n'), false, 'cookie must not embed a newline');
  }
});

test('success body contains no tokens, auth code, verifier, or user PII', async (t) => {
  setEnv(t);
  installFetch(t, async () => okTokenResponse());
  const res = await loadHandler()(validEvent());
  const body = res.body || '';
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CODE, VERIFIER, USER_ID, USER_EMAIL, STATE]) {
    assert.equal(body.includes(secret), false, `body must not contain ${secret[0] === 'u' ? 'PII' : 'token/code/verifier'}`);
  }
  for (const key of ['access_token', 'refresh_token', 'auth_code', 'code_verifier']) {
    assert.equal(body.includes(key), false, `body must not contain the key ${key}`);
  }
});

// ── Fail closed: non-2xx / network / malformed token payload ──

test('upstream non-2xx => fail-closed redirect clearing only transient cookies', async (t) => {
  setEnv(t);
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    let called = false;
    installFetch(t, async () => { called = true; return upstreamResponse(status, { error: `err-${status}` }); });
    const res = await loadHandler()(validEvent());
    assertFailClosed(res);
    assert.equal(called, true, `${status} must still attempt upstream exchange`);
    assert.equal(locationOf(res), FAIL_LOCATION, `${status} must redirect to ${FAIL_LOCATION}`);
  }
});

test('upstream network failure => fail closed, clears, generic redirect', async (t) => {
  setEnv(t);
  installFetch(t, async () => { throw new Error('ECONNREFUSED'); });
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
  const body = res.body || '';
  assert.equal(body.includes('ECONNREFUSED'), false, 'network error details must not leak');
  assert.equal(body.includes(SB_URL), false);
  assert.equal(body.includes(ANON_KEY), false);
});

test('upstream 2xx but malformed (non-JSON) payload => fail closed', async (t) => {
  setEnv(t);
  installFetch(t, async () => upstreamResponse(200, () => { throw new Error('Unexpected token'); }));
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
});

test('upstream token payload missing access_token => fail closed', async (t) => {
  setEnv(t);
  installFetch(t, async () => upstreamResponse(200, { refresh_token: REFRESH_TOKEN }));
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
});

test('upstream token payload missing refresh_token => fail closed', async (t) => {
  setEnv(t);
  installFetch(t, async () => upstreamResponse(200, { access_token: ACCESS_TOKEN }));
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
});

test('upstream token payload with non-string access_token => fail closed', async (t) => {
  setEnv(t);
  installFetch(t, async () => upstreamResponse(200, { access_token: 12345, refresh_token: REFRESH_TOKEN }));
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
});

test('upstream token payload with non-string refresh_token => fail closed', async (t) => {
  setEnv(t);
  installFetch(t, async () => upstreamResponse(200, { access_token: ACCESS_TOKEN, refresh_token: { nested: true } }));
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
});

test('upstream token values with cookie delimiters/control characters => fail closed', async (t) => {
  setEnv(t);
  for (const badToken of ['abc; Path=/', 'abc,def', 'abc\r\nSet-Cookie: injected=1', 'abc def']) {
    installFetch(t, async () =>
      upstreamResponse(200, { access_token: badToken, refresh_token: REFRESH_TOKEN, expires_in: 3600 }),
    );
    assertFailClosed(await loadHandler()(validEvent()));

    installFetch(t, async () =>
      upstreamResponse(200, { access_token: ACCESS_TOKEN, refresh_token: badToken, expires_in: 3600 }),
    );
    assertFailClosed(await loadHandler()(validEvent()));
  }
});

test('missing config (no env) => fail closed without upstream fetch', async (t) => {
  setEnvMissing(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(validEvent());
  assertFailClosed(res);
  assert.equal(called, false);
});

// ── No open redirect ──

test('attack/redirect query params never change the success Location', async (t) => {
  setEnv(t);
  installFetch(t, async () => okTokenResponse());
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_auth_state', STATE], ['sb_pkce_verifier', VERIFIER]),
    query: {
      code: CODE,
      state: STATE,
      redirect: 'https://evil.example/steal',
      next: '//evil.example',
      continue: '/x',
      returnTo: 'https://evil.example',
      url: 'https://evil.example',
    },
  }));
  assert.equal(res.statusCode, 303);
  assert.equal(locationOf(res), OK_LOCATION, 'Location must be hardcoded, never attacker-controlled');
});

test('attack/redirect query params never change the failure Location', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return okTokenResponse(); });
  const res = await loadHandler()(makeEvent({
    cookie: cookieHeader(['sb_pkce_verifier', VERIFIER]),
    query: { code: CODE, redirect: 'https://evil.example/steal', next: '//evil.example' },
  }));
  assertFailClosed(res);
  assert.equal(locationOf(res), FAIL_LOCATION, 'failure Location must be hardcoded, never attacker-controlled');
  assert.equal(called, false);
});

test('no response in any path leaks tokens, cookies, or upstream URL', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => {
    calls += 1;
    return calls === 1 ? okTokenResponse() : upstreamResponse(500, {});
  });
  const success = await loadHandler()(validEvent());
  const failed = await loadHandler()(validEvent());
  const methodBlocked = await loadHandler()(makeEvent({ method: 'POST', query: { code: CODE, state: STATE } }));
  const full = [success, failed, methodBlocked]
    .map((res) => `${JSON.stringify(res.headers)}\n${res.headers.Location || res.headers.location || ''}\n${res.body || ''}`)
    .join('\n');
  for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CODE, VERIFIER, STATE, USER_ID, USER_EMAIL, SB_URL, ANON_KEY]) {
    assert.equal(full.includes(secret), false, `no response may contain secret material`);
  }
  for (const key of ['access_token', 'refresh_token']) {
    assert.equal(full.includes(key), false, 'no response body may reference token keys');
  }
});

// ── Cache control across response classes ──

test('every response class carries Cache-Control with no-store', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => {
    calls += 1;
    return calls === 1 ? okTokenResponse() : upstreamResponse(500, {});
  });
  const success = await loadHandler()(validEvent());
  const upstreamFail = await loadHandler()(validEvent());
  const invalid = await loadHandler()(makeEvent({ method: 'GET', query: { code: CODE } }));
  const badMethod = await loadHandler()(makeEvent({ method: 'POST' }));
  const options = await loadHandler()(makeEvent({ method: 'OPTIONS' }));
  for (const res of [success, upstreamFail, invalid, badMethod, options]) {
    assert.equal(res.headers['Cache-Control'] && res.headers['Cache-Control'].includes('no-store'), true,
      'Cache-Control must include no-store');
  }
});