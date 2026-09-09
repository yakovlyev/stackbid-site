const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const staged = fs.readFileSync(new URL('./my-estimates-auth.html', `file://${__dirname}/`), 'utf8');
const legacy = fs.readFileSync(new URL('./my-estimates.html', `file://${__dirname}/`), 'utf8');

function script() {
  const match = staged.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match);
  return match[1];
}

function element() {
  return { innerHTML: '', value: '', style: {}, addEventListener() {} };
}

function sandbox(fetch) {
  const elements = Object.fromEntries(['auth-form-row', 'auth-form', 'email', 'auth-status', 'content'].map((id) => [id, element()]));
  return {
    context: vm.createContext({
      document: { readyState: 'loading', addEventListener() {}, getElementById: (id) => elements[id] },
      window: { location: { search: '' } },
      fetch,
      console,
    }),
    elements,
  };
}

test('staged page is not linked from the current legacy history page', () => {
  assert.equal(legacy.includes('my-estimates-auth.html'), false);
});

test('staged page never stores email or auth token in localStorage', () => {
  assert.equal(staged.includes('localStorage'), false);
  assert.equal(staged.includes('sb_user_email'), false);
  assert.equal(staged.includes('sb_access_token'), false);
});

test('authenticated boot calls auth-session then v2 history with credentials and escapes stored markup', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth-session') return { status: 200, ok: true, json: async () => ({ authenticated: true }) };
    return {
      status: 200,
      ok: true,
      json: async () => ({
        is_pro: false,
        estimates: [{ title: '<img src=x onerror=alert(1)>', zip: '90210', total_retail: 100, created_at: '2026-01-01' }],
      }),
    };
  };
  const { context, elements } = sandbox(fakeFetch);
  vm.runInContext(script(), context);
  await context.boot();
  assert.equal(calls[0].url, '/api/auth-session');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].url, '/.netlify/functions/get-estimates-auth');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(elements.content.innerHTML.includes('<img src=x'), false);
  assert.equal(elements.content.innerHTML.includes('&lt;img src=x'), true);
});

test('unauthenticated boot does not request history and form starts generic magic-link flow', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth-session') return { status: 401, ok: false, json: async () => ({ authenticated: false }) };
    return { status: 202, ok: true, json: async () => ({ accepted: true }) };
  };
  const { context, elements } = sandbox(fakeFetch);
  vm.runInContext(script(), context);
  await context.boot();
  assert.equal(calls.some((call) => call.url.includes('get-estimates-auth')), false);
  elements.email.value = 'owner@example.com';
  await context.startAuth({ preventDefault() {} });
  const start = calls.find((call) => call.url === '/api/auth-start');
  assert.equal(start.init.method, 'POST');
  assert.equal(start.init.credentials, 'include');
  assert.deepEqual(JSON.parse(start.init.body), { email: 'owner@example.com' });
  assert.match(elements['auth-status'].innerHTML, /check your inbox/i);
});
