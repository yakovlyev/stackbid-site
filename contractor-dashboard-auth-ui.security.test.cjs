const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const stagedPath = new URL('./contractor-dashboard-auth.html', `file://${__dirname}/`);
const legacy = fs.readFileSync(new URL('./contractor-dashboard.html', `file://${__dirname}/`), 'utf8');

function staged() {
  return fs.readFileSync(stagedPath, 'utf8');
}

function script(source) {
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match);
  return match[1];
}

function element() {
  return { innerHTML: '', style: {}, addEventListener() {} };
}

function sandbox(fetch) {
  const elements = Object.fromEntries(['auth-notice', 'content'].map((id) => [id, element()]));
  return {
    context: vm.createContext({
      document: { readyState: 'loading', addEventListener() {}, getElementById: (id) => elements[id] },
      fetch,
      console,
      Date,
    }),
    elements,
  };
}

test('staged contractor page is not linked from legacy dashboard', () => {
  assert.equal(legacy.includes('contractor-dashboard-auth.html'), false);
});

test('staged page has no email identity storage or state-changing controls', () => {
  const source = staged();
  assert.equal(source.includes('localStorage'), false);
  assert.equal(source.includes('stackbid_contractor_email'), false);
  assert.equal(source.includes('/api/contractor-dashboard?email='), false);
  assert.equal(source.includes("method: 'POST'"), false);
  assert.equal(source.includes('setStatus('), false);
});

test('authenticated boot reads staged endpoint with credentials and escapes fields', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth-session') return { status: 200, ok: true, json: async () => ({ authenticated: true }) };
    return {
      status: 200,
      ok: true,
      json: async () => ({
        found: true,
        contractor: { company_name: '<img src=x onerror=alert(1)>', subscription_tier: 'pro', leads_received: 3, leads_converted: 1, rating: 4.8, review_count: 5, license_verified: true },
        leads: [{ id: 9, project_type: '<svg onload=alert(1)>', zip_code: '90210', budget_range: '$10k', status: 'new', created_at: '2026-01-01' }],
      }),
    };
  };
  const source = staged();
  const { context, elements } = sandbox(fakeFetch);
  vm.runInContext(script(source), context);
  await context.boot();
  assert.equal(calls[0].url, '/api/auth-session');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[1].url, '/.netlify/functions/contractor-dashboard-auth');
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.credentials, 'include');
  assert.equal(calls[1].init.body, undefined);
  assert.equal(elements.content.innerHTML.includes('<img src=x'), false);
  assert.equal(elements.content.innerHTML.includes('&lt;img src=x'), true);
  assert.equal(elements.content.innerHTML.includes('<svg onload='), false);
  assert.equal(elements.content.innerHTML.includes('&lt;svg onload='), true);
});

test('unauthenticated boot does not request contractor data', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return { status: 401, ok: false, json: async () => ({ authenticated: false }) };
  };
  const source = staged();
  const { context, elements } = sandbox(fakeFetch);
  vm.runInContext(script(source), context);
  await context.boot();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/auth-session');
  assert.match(elements['auth-notice'].innerHTML, /sign in/i);
  assert.equal(elements.content.innerHTML, '');
});
