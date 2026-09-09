const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SB_URL = 'https://xyzproject.supabase.co';
const ANON_KEY = 'test-anon-key-abc';
const VALID_EMAIL = 'user@example.com';
const ENCODED_STATE = 'test-state-123';
const REDIRECT_BASE = `${SB_URL}/auth/v1/otp`;

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

function installFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => { global.fetch = original; });
}

function makeEvent(body, method = 'POST') {
  return { httpMethod: method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: {} };
}

function redirectToFrom(upstreamUrl) {
  return new URL(upstreamUrl).searchParams.get('redirect_to');
}

function cookiesFrom(res) {
  const mvh = res.multiValueHeaders && res.multiValueHeaders['Set-Cookie'];
  return Array.isArray(mvh) ? mvh : [];
}

function parseCookie(cookie) {
  const [nameVal, ...attrs] = cookie.split(';').map((s) => s.trim());
  return { nameVal, attrs };
}

// ── Wiring ──

test('server.js wires the auth-start handler map entry', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /'auth-start':\s*require\('\.\/netlify\/functions\/auth-start'\)/);
});

test('server.js gives auth-start an explicit strict rate limit', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /'auth-start':\s*\{\s*max:\s*5,\s*window:\s*600000\s*\}/);
});

test('server.js adapter merges result.multiValueHeaders into response headers', () => {
  const source = fs.readFileSync(new URL('./server.js', `file://${__dirname}/`), 'utf8');
  assert.match(source, /result\.multiValueHeaders/, 'server adapter must consume result.multiValueHeaders');
});

// ── Method guards ──

test('GET => 405 with Allow header, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }, 'GET'));
  assert.equal(res.statusCode, 405);
  assert.match(res.headers.Allow || '', /POST/);
  assert.equal(called, false);
});

test('PUT => 405, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }, 'PUT'));
  assert.equal(res.statusCode, 405);
  assert.equal(called, false);
});

test('DELETE => 405, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }, 'DELETE'));
  assert.equal(res.statusCode, 405);
  assert.equal(called, false);
});

test('PATCH => 405, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }, 'PATCH'));
  assert.equal(res.statusCode, 405);
  assert.equal(called, false);
});

test('OPTIONS => 204, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent(null, 'OPTIONS'));
  assert.equal(res.statusCode, 204);
  assert.equal(called, false);
});

// ── Body parsing / validation ──

test('malformed JSON => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler({ httpMethod: 'POST', body: '{bad json', headers: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('oversize body (>2048 bytes) => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const bigEmail = 'a'.repeat(2050) + '@example.com';
  const res = await handler(makeEvent({ email: bigEmail }));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('missing email => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({}));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('email not a string => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: 12345 }));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('empty email after trim => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: '   ' }));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('invalid email syntax => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  for (const bad of ['notanemail', '@no-local.com', 'user@', 'user@.com', 'user@com']) {
    const res = await handler(makeEvent({ email: bad }));
    assert.equal(res.statusCode, 400, `Expected 400 for ${bad}`);
  }
  assert.equal(called, false);
});

test('email > 254 chars => 400, no fetch', async (t) => {
  setEnv(t);
  let called = false;
  installFetch(t, async () => { called = true; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const long = 'x'.repeat(250) + '@example.com';
  const res = await handler(makeEvent({ email: long }));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

// ── Normalization ──

test('email is trimmed and lowercased in upstream request', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: '  User@Example.COM  ' }));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.email, 'user@example.com');
});

// ── PKCE / state ──

test('PKCE verifier is base64url 43-128 chars', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  const body = JSON.parse(captured.init.body);
  const verifier = body.code_challenge;
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier length ${verifier.length}`);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(verifier), 'verifier must be base64url');
});

test('S256 challenge is SHA-256 of verifier, base64url-encoded', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  const body = JSON.parse(captured.init.body);
  const cookies = cookiesFrom(res);
  assert.equal(cookies.length, 2, 'must return exactly two cookies');
  const verifierCookie = cookies.find((c) => c.startsWith('sb_pkce_verifier='));
  assert.ok(verifierCookie, 'must set sb_pkce_verifier cookie');
  const verifier = verifierCookie.match(/^sb_pkce_verifier=([^;]+)/)[1];
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(body.code_challenge, expected, 'challenge must be SHA-256(verifier)');
});

test('code_challenge_method is s256', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.code_challenge_method, 's256');
});

test('state is distinct from verifier on each call', async (t) => {
  setEnv(t);
  const urls = [];
  installFetch(t, async (url, init) => { urls.push(url); return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  await handler(makeEvent({ email: VALID_EMAIL }));
  // verifier is in the JSON body; state lives inside redirect_to in the query string
  const state1 = new URL(redirectToFrom(urls[0])).searchParams.get('state');
  const state2 = new URL(redirectToFrom(urls[1])).searchParams.get('state');
  assert.ok(state1 && state1.length > 8, 'state must be non-trivial');
  assert.notEqual(state1, state2, 'two calls must produce different states');
});

// ── Upstream request ──

test('upstream request goes to exact SUPABASE_URL/auth/v1/otp with apikey', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  assert.ok(captured.url.startsWith(`${SB_URL}/auth/v1/otp`), `url starts with ${SB_URL}/auth/v1/otp`);
  assert.equal(captured.init.headers.apikey, ANON_KEY);
  assert.equal(captured.init.method, 'POST');
});

test('redirect_to contains exact https://stackbid.app/api/auth/callback?state=STATE', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  const redirectTo = redirectToFrom(captured.url);
  assert.ok(redirectTo.startsWith('https://stackbid.app/api/auth/callback?state='),
    'redirect_to must carry the exact callback URL with state param');
  const redirectUrl = new URL(redirectTo);
  assert.equal(redirectUrl.origin, 'https://stackbid.app');
  assert.equal(redirectUrl.pathname, '/api/auth/callback');
  assert.ok(redirectUrl.searchParams.has('state'), 'redirect_to must contain state param');
});

test('upstream body has create_user:false', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.create_user, false);
});

test('upstream request uses AbortSignal.timeout(5000)', async (t) => {
  setEnv(t);
  let captured;
  installFetch(t, async (url, init) => { captured = { url, init }; return { ok: true, status: 200 }; });
  const { handler } = require('./netlify/functions/auth-start');
  await handler(makeEvent({ email: VALID_EMAIL }));
  assert.ok(captured.init.signal instanceof AbortSignal, 'signal must be AbortSignal');
});

// ── Enumeration resistance ──

test('upstream 2xx and 4xx both return identical generic 202 body', async (t) => {
  setEnv(t);
  const bodies = [];
  for (const status of [200, 400, 401, 403, 404]) {
    installFetch(t, async () => ({ ok: status >= 200 && status < 300, status, json: async () => ({ msg: `error-${status}` }) }));
    const { handler } = require('./netlify/functions/auth-start');
    const res = await handler(makeEvent({ email: VALID_EMAIL }));
    assert.equal(res.statusCode, 202, `status ${status} upstream must yield 202`);
    const body = JSON.parse(res.body);
    assert.ok(!body.email, 'response body must not contain email');
    bodies.push(res.body);
  }
  // All response bodies must be identical
  const unique = new Set(bodies);
  assert.equal(unique.size, 1, 'all 2xx/4xx responses must be byte-identical');
});

test('upstream 4xx response never sets cookies', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 404, json: async () => ({ msg: 'not found' }) }));
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers['Set-Cookie'], undefined, 'no Set-Cookie header on 4xx');
  assert.equal(res.headers['set-cookie'], undefined, 'no set-cookie header on 4xx');
  assert.equal(cookiesFrom(res).length, 0, 'no multiValueHeaders cookies on 4xx');
});

test('upstream 5xx => generic 503, no cookies, no upstream data', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: false, status: 500, json: async () => ({ error: 'server error' }) }));
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.ok(!body.email);
  assert.ok(!body.error);
  assert.equal(res.headers['Set-Cookie'], undefined, 'no Set-Cookie header on 5xx');
  assert.equal(cookiesFrom(res).length, 0, 'no cookies on 5xx');
});

test('upstream 429 with Retry-After => generic 429 with Retry-After', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({
    ok: false, status: 429,
    headers: new Map([['retry-after', '30']]),
    json: async () => ({ msg: 'rate limited' }),
  }));
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 429);
  assert.ok(res.headers['Retry-After'] || res.headers['retry-after'], 'must pass through Retry-After');
});

test('network failure => generic 503, no fetch error surfaced', async (t) => {
  setEnv(t);
  installFetch(t, async () => { throw new Error('ECONNREFUSED'); });
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.ok(!body.error);
  assert.ok(!body.email);
});

test('missing config (no env) => generic 503, no fetch', async (t) => {
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
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 503);
  assert.equal(called, false);
});

// ── Cookie transport on success ──

test('2xx returns exactly two independently parseable cookies via multiValueHeaders, none via headers', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers['Set-Cookie'], undefined, 'must not use headers["Set-Cookie"]');
  assert.equal(res.headers['set-cookie'], undefined, 'must not use headers["set-cookie"]');
  const cookies = cookiesFrom(res);
  assert.equal(cookies.length, 2, 'must return exactly two cookies');
  const verifierCookie = cookies.find((c) => c.startsWith('sb_pkce_verifier='));
  const stateCookie = cookies.find((c) => c.startsWith('sb_auth_state='));
  assert.ok(verifierCookie, 'must set sb_pkce_verifier cookie');
  assert.ok(stateCookie, 'must set sb_auth_state cookie');
  for (const cookie of [verifierCookie, stateCookie]) {
    const parsed = parseCookie(cookie);
    assert.equal(parsed.attrs.includes('HttpOnly'), true, 'cookie must be HttpOnly');
    assert.equal(parsed.attrs.includes('Secure'), true, 'cookie must be Secure');
    assert.equal(parsed.attrs.includes('SameSite=Lax'), true, 'cookie must be SameSite=Lax');
    assert.equal(parsed.attrs.includes('Path=/'), true, 'cookie must have Path=/');
    assert.ok(parsed.attrs.some((a) => a.startsWith('Max-Age=')), 'cookie must have Max-Age');
  }
  const verifierVal = verifierCookie.match(/^sb_pkce_verifier=([^;]+)/)[1];
  const stateVal = stateCookie.match(/^sb_auth_state=([^;]+)/)[1];
  assert.notEqual(verifierVal, stateVal, 'verifier and state values must differ');
  assert.ok(!res.body.includes(verifierVal), 'verifier value must not be in body');
  assert.ok(!res.body.includes(stateVal), 'state value must not be in body');
  assert.equal(verifierCookie.includes('\n'), false, 'cookie must not embed a newline');
});

// ── Anti-enumeration body on success ──

test('accepted response body is generic, no email or upstream data', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({ user: { id: 'xyz' } }) }));
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.equal(res.statusCode, 202);
  const body = JSON.parse(res.body);
  assert.ok(!body.email, 'must not contain email');
  assert.ok(!body.user, 'must not contain upstream user data');
  assert.ok(!res.body.includes('xyz'), 'must not contain upstream user id');
});

// ── CORS response classes ──

test('all response classes carry exact CORS origin, credentials, and no-store', async (t) => {
  setEnv(t);
  let calls = 0;
  installFetch(t, async () => {
    calls += 1;
    return calls <= 1
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: false, status: 500, json: async () => ({}) };
  });
  const { handler } = require('./netlify/functions/auth-start');

  const ok = await handler(makeEvent({ email: VALID_EMAIL }));
  calls = 0;
  installFetch(t, async () => ({ ok: false, status: 404, json: async () => ({}) }));
  const notFound = await handler(makeEvent({ email: VALID_EMAIL }));
  calls = 0;
  installFetch(t, async () => { throw new Error('net'); });
  const network = await handler(makeEvent({ email: VALID_EMAIL }));
  const badMethod = await handler(makeEvent({ email: VALID_EMAIL }, 'GET'));
  const options = await handler(makeEvent(null, 'OPTIONS'));

  for (const res of [ok, notFound, network, badMethod, options]) {
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://stackbid.app');
    assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

// ── No email/tokens/state leaked in logs ──

test('handler does not include email, tokens, or state in response body', async (t) => {
  setEnv(t);
  installFetch(t, async () => ({ ok: true, status: 200, json: async () => ({}) }));
  const { handler } = require('./netlify/functions/auth-start');
  const res = await handler(makeEvent({ email: VALID_EMAIL }));
  assert.ok(!res.body.includes(VALID_EMAIL), 'response must not contain the email');
  assert.ok(!res.body.includes(SB_URL), 'response must not contain upstream URL');
  assert.ok(!res.body.includes(ANON_KEY), 'response must not contain anon key');
});
