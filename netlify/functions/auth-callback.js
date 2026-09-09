// GET /api/auth/callback — redeems the Supabase OTP magic-link code using PKCE.
// After the user clicks the link, Supabase redirects the browser here (the
// redirect target is baked into auth-start.js as
// https://stackbid.app/api/auth/callback) with ?code=..&state=... We:
//   1. enforce exactly-once sb_auth_state + sb_pkce_verifier cookies and a
//      scalar, size-bounded query code + state (duplicates/malformed reject
//      without touching upstream);
//   2. verify the query state exactly matches the cookie state via a
//      timing-safe comparison (CSRF protection);
//   3. exchange auth_code + code_verifier for a Supabase session
//      (POST /auth/v1/token?grant_type=pkce), validating the 2xx JSON payload
//      strictly (nonempty bounded access/refresh strings, bounded positive
//      integer expires_in);
//   4. on success set HttpOnly session cookies and 303 to /my-estimates.html;
//      on ANY failure fail closed to /my-estimates.html?auth=failed clearing
//      only the two transient cookies.
// Tokens, verifier, expiry and state are never returned in a body nor logged.
const crypto = require('node:crypto');

const ALLOWED_ORIGIN = 'https://stackbid.app';
const SUCCESS_LOCATION = '/my-estimates.html';
const FAILURE_LOCATION = '/my-estimates.html?auth=failed';
const AUTH_TIMEOUT_MS = 5000;

// Bounds. Bound values mirror what auth-start.js generates (verifier =
// randomBytes(32).toString('base64url') = 43 chars, state = randomBytes(16) = 22
// chars) while capping hostile inputs.
const MAX_CODE_LEN = 4096;
const MAX_QUERY_STATE_LEN = 256;
const MIN_VERIFIER_LEN = 43;
const MAX_VERIFIER_LEN = 128;
const MIN_STATE_LEN = 8;
const MAX_STATE_LEN = 128;
const MAX_TOKEN_LEN = 2048;
const MAX_EXPIRES_IN = 864000;
const REFRESH_MAX_AGE = 2592000;

const COOKIE_ATTRS = 'HttpOnly; Secure; SameSite=Lax; Path=/';

const BASE = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'private, no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
};

const CLEAR_STATE = `sb_auth_state=; ${COOKIE_ATTRS}; Max-Age=0`;
const CLEAR_VERIFIER = `sb_pkce_verifier=; ${COOKIE_ATTRS}; Max-Age=0`;
const CLEAR_COOKIES = [CLEAR_STATE, CLEAR_VERIFIER];

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const COOKIE_VALUE_RE = /^[A-Za-z0-9._~-]+$/;

function isBase64Url(s) {
  return BASE64URL_RE.test(s);
}

// Returns the cookie value, null when absent, or undefined when the cookie is
// present more than once (ambiguous -> treat as invalid).
function grabCookie(header, name) {
  let value = null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    const val = part.slice(eq + 1).trim();
    if (value !== null) return undefined;
    value = val;
  }
  return value;
}

// Exactly one well-formed state + verifier cookie pair, or null (fail closed).
function transientPair(event) {
  const headers = event.headers || {};
  const header = headers.cookie || headers.Cookie;
  if (typeof header !== 'string' || header.length === 0) return null;

  const state = grabCookie(header, 'sb_auth_state');
  const verifier = grabCookie(header, 'sb_pkce_verifier');
  if (state === undefined || verifier === undefined) return null; // duplicate
  if (state === null || verifier === null) return null; // missing

  if (!isBase64Url(state) || !isBase64Url(verifier)) return null;
  if (state.length < MIN_STATE_LEN || state.length > MAX_STATE_LEN) return null;
  if (verifier.length < MIN_VERIFIER_LEN || verifier.length > MAX_VERIFIER_LEN) return null;

  return { state, verifier };
}

// Exact, timing-safe state comparison. Length mismatch short-circuits (no
// secret content is compared there — lengths themselves are public bounds).
function statesEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Strict session payload validation — any deviation fails closed.
function validSession(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { access_token, refresh_token, expires_in } = payload;
  if (typeof access_token !== 'string' || access_token.length === 0 || access_token.length > MAX_TOKEN_LEN) return null;
  if (typeof refresh_token !== 'string' || refresh_token.length === 0 || refresh_token.length > MAX_TOKEN_LEN)
    return null;
  if (!COOKIE_VALUE_RE.test(access_token) || !COOKIE_VALUE_RE.test(refresh_token)) return null;
  if (typeof expires_in !== 'number' || !Number.isFinite(expires_in) || !Number.isInteger(expires_in)) return null;
  if (expires_in <= 0 || expires_in > MAX_EXPIRES_IN) return null;
  return { access_token, refresh_token, expires_in };
}

function failClosed() {
  return {
    statusCode: 303,
    headers: { ...BASE, Location: FAILURE_LOCATION },
    multiValueHeaders: { 'Set-Cookie': CLEAR_COOKIES },
    body: '',
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...BASE,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (method !== 'GET') {
    return {
      statusCode: 405,
      headers: { ...BASE, Allow: 'GET, OPTIONS' },
      body: '',
    };
  }

  const transient = transientPair(event);
  if (!transient) return failClosed();

  const query =
    event.queryStringParameters && typeof event.queryStringParameters === 'object' ? event.queryStringParameters : {};
  const code = query.code;
  const queryState = query.state;
  // Scalar + bounds; duplicate query params arrive as arrays and are rejected.
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LEN) return failClosed();
  if (typeof queryState !== 'string' || queryState.length === 0 || queryState.length > MAX_QUERY_STATE_LEN)
    return failClosed();
  if (!statesEqual(queryState, transient.state)) return failClosed();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return failClosed();

  let upstream;
  try {
    upstream = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ auth_code: code, code_verifier: transient.verifier }),
    });
  } catch {
    return failClosed();
  }

  if (!upstream.ok) return failClosed();

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return failClosed();
  }

  const session = validSession(payload);
  if (!session) return failClosed();

  return {
    statusCode: 303,
    headers: { ...BASE, Location: SUCCESS_LOCATION },
    multiValueHeaders: {
      'Set-Cookie': [
        `sb_access_token=${session.access_token}; ${COOKIE_ATTRS}; Max-Age=${session.expires_in}`,
        `sb_refresh_token=${session.refresh_token}; ${COOKIE_ATTRS}; Max-Age=${REFRESH_MAX_AGE}`,
        CLEAR_STATE,
        CLEAR_VERIFIER,
      ],
    },
    body: '',
  };
};
