// POST /api/auth/start — starts a Supabase passwordless OTP login (magic link)
// using PKCE. Endpoint is enumeration-resistant: the caller learns nothing about
// whether an email exists. On accepted upstream 2xx we set two HttpOnly cookies
// (PKCE verifier + CSRF state) so the subsequent /api/auth/callback can redeem
// the code without exposing secrets in JS-visible storage. We deliberately never
// log the email, verifier, challenge, state, or any upstream response details.
const crypto = require('node:crypto');

const ALLOWED_ORIGIN = 'https://stackbid.app';
const CALLBACK_URL = 'https://stackbid.app/api/auth/callback';
const AUTH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 2048;
const COOKIE_MAX_AGE = 600;

const BASE = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
};

const GENERIC_ACCEPTED = JSON.stringify({ ok: true });
const GENERIC_UNAVAILABLE = JSON.stringify({ ok: false });

function baseHeaders(extra = {}) {
  return { ...BASE, 'Content-Type': 'application/json', ...extra };
}

function validateEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length >= 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function pkceVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function randomState() {
  return crypto.randomBytes(16).toString('base64url');
}

function cookiePair(verifier, state) {
  const attrs = `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  return [`sb_pkce_verifier=${verifier}; ${attrs}`, `sb_auth_state=${state}; ${attrs}`];
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'POST';

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...BASE,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...baseHeaders(), Allow: 'POST, OPTIONS' },
      body: GENERIC_UNAVAILABLE,
    };
  }

  const rawBody = typeof event.body === 'string' ? event.body : '';
  if (rawBody.length === 0 || Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return { statusCode: 400, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
  }

  const emailValue = parsed && typeof parsed === 'object' ? parsed.email : undefined;
  if (typeof emailValue !== 'string') {
    return { statusCode: 400, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
  }

  const email = emailValue.trim().toLowerCase();
  if (!validateEmail(email)) {
    return { statusCode: 400, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 503, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
  }

  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const state = randomState();
  const redirectTo = `${CALLBACK_URL}?state=${state}`;

  let upstream;
  try {
    upstream = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        create_user: false,
        code_challenge: challenge,
        code_challenge_method: 's256',
      }),
    });
  } catch {
    return { statusCode: 503, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
  }

  const status = upstream.status;

  if (status === 429) {
    const retryAfter = upstream.headers ? upstream.headers.get('retry-after') : null;
    const headers = baseHeaders();
    if (retryAfter) headers['Retry-After'] = retryAfter;
    return { statusCode: 429, headers, body: GENERIC_UNAVAILABLE };
  }

  if (status >= 200 && status < 300) {
    return {
      statusCode: 202,
      headers: baseHeaders(),
      multiValueHeaders: { 'Set-Cookie': cookiePair(verifier, state) },
      body: GENERIC_ACCEPTED,
    };
  }

  if (status >= 400 && status < 500) {
    // Unknown account / validation failure looks exactly like success:
    // enumeration resistance — no cookies, identical generic body.
    return { statusCode: 202, headers: baseHeaders(), body: GENERIC_ACCEPTED };
  }

  return { statusCode: 503, headers: baseHeaders(), body: GENERIC_UNAVAILABLE };
};
