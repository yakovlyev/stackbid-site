import { test } from 'vitest';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

const originalFetch = global.fetch;
const { resolveCheckoutIdentity } = await import('../netlify/functions/create-checkout-session.js');

function mockFetchSequence(responses) {
  let i = 0;
  global.fetch = async () => responses[Math.min(i++, responses.length - 1)];
}

test('SECURITY: an authenticated contractor session cannot be overridden by a different email/contractor_id in the body', async () => {
  // Сесія належить контрактору 1 (own@example.com). Тіло запиту намагається
  // видати себе за контрактора 999 (victim@example.com) - сесія повинна
  // повністю це проігнорувати.
  mockFetchSequence([
    { ok: true, json: async () => ({ id: 'auth-uid-1' }) }, // /auth/v1/user
    { ok: true, json: async () => ([{ id: 1 }]) }, // resolve auth_user_id -> contractor 1
    { ok: true, json: async () => ([{ id: 1, email: 'own@example.com' }]) }, // fetch real identity for contractor 1
  ]);
  try {
    const identity = await resolveCheckoutIdentity(
      { headers: { cookie: 'sb_session=good-token' } },
      true,
      'victim@example.com',
      999,
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    assert.equal(identity.error, undefined);
    assert.equal(identity.email, 'own@example.com');
    assert.equal(identity.contractor_id, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy path (no session) still works: matching email+contractor_id succeeds', async () => {
  mockFetchSequence([{ ok: true, json: async () => ([{ id: 5 }]) }]); // ownerCheck match
  try {
    const identity = await resolveCheckoutIdentity(
      { headers: {} },
      true,
      'legacy@example.com',
      5,
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    assert.equal(identity.error, undefined);
    assert.equal(identity.email, 'legacy@example.com');
    assert.equal(identity.contractor_id, 5);
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy path (no session) rejects a contractor_id that does not match the given email', async () => {
  mockFetchSequence([{ ok: true, json: async () => ([]) }]); // ownerCheck finds nothing
  try {
    const identity = await resolveCheckoutIdentity(
      { headers: {} },
      true,
      'attacker@example.com',
      999,
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    assert.equal(identity.statusCode, 403);
  } finally {
    global.fetch = originalFetch;
  }
});

test('legacy path (no session) rejects missing contractor_id', async () => {
  const identity = await resolveCheckoutIdentity({ headers: {} }, true, 'a@example.com', null, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(identity.statusCode, 400);
});

test('homeowner tier is unaffected by the contractor session logic and does not touch Supabase at all', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ([]) }; };
  try {
    const identity = await resolveCheckoutIdentity({ headers: {} }, false, 'homeowner@example.com', null, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    assert.equal(identity.error, undefined);
    assert.equal(identity.email, 'homeowner@example.com');
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('rejects an invalid email format on the homeowner path', async () => {
  const identity = await resolveCheckoutIdentity({ headers: {} }, false, 'not-an-email', null, process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(identity.statusCode, 400);
});

test('an authenticated session with an invalid/expired token falls back to the legacy path rather than erroring', async () => {
  mockFetchSequence([
    { ok: false, status: 401 }, // /auth/v1/user says invalid
    { ok: true, json: async () => ([{ id: 7 }]) }, // falls through to legacy ownerCheck, which succeeds
  ]);
  try {
    const identity = await resolveCheckoutIdentity(
      { headers: { cookie: 'sb_session=stale-token' } },
      true,
      'legacy2@example.com',
      7,
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    assert.equal(identity.error, undefined);
    assert.equal(identity.email, 'legacy2@example.com');
  } finally {
    global.fetch = originalFetch;
  }
});
