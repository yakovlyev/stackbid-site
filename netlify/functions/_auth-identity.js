// Shared auth-identity boundary for Netlify functions. Parses exactly one
// HttpOnly sb_access_token cookie value from the event, validates it against
// Supabase Auth (/auth/v1/user) with a bounded 5s AbortSignal, and returns a
// structured INTERNAL identity — never the token and never upstream PII
// (email etc.). Consumers map REASONS to their own fail-closed status codes.
//
// Rules:
//   - missing/duplicate/malformed/oversized cookie -> rejected WITHOUT an
//     upstream call;
//   - only 2xx responses are accepted; 401/403 => UNAUTHORIZED, 5xx/network =>
//     UNAVAILABLE;
//   - the 2xx payload must have a non-empty, bounded, UUID-like user.id
//     (anything else => INVALID);
//   - missing SUPABASE_URL/SUPABASE_ANON_KEY => MISCONFIGURED (no upstream).
const AUTH_TIMEOUT_MS = 5000;
const MAX_TOKEN_LEN = 2048;
const MAX_USER_ID_LEN = 128;
const TOKEN_RE = /^[A-Za-z0-9._-]+$/; // JWT-safe (base64url segments + dots)
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const REASONS = Object.freeze({
  NO_TOKEN: 'no_token',
  MALFORMED: 'malformed',
  UNAUTHORIZED: 'unauthorized',
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  MISCONFIGURED: 'misconfigured',
});

const COOKIE_NAME = 'sb_access_token';

// { status: 'ok', token } | { status: 'none' } | { status: 'malformed' }
function parseAccessToken(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return { status: 'none' };

  let token = null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    // Per spec an "=" is also valid inside a Base64-encoded cookie value, but a
    // Supabase access token is a JWT (base64url + dots), never "=". A value
    // containing one is malformed, not a valid token.
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    if (token !== null) return { status: 'malformed' }; // duplicate
    const value = part.slice(eq + 1).trim();
    if (value.length === 0 || value.length > MAX_TOKEN_LEN || !TOKEN_RE.test(value)) return { status: 'malformed' };
    token = value;
  }

  if (token === null) return { status: 'none' };
  return { status: 'ok', token };
}

function validUserId(payload) {
  const id = payload && typeof payload === 'object' ? payload.id : undefined;
  if (typeof id !== 'string') return null;
  if (id.length === 0 || id.length > MAX_USER_ID_LEN) return null;
  if (!UUID_RE.test(id)) return null;
  return id;
}

async function resolveIdentity(event) {
  const headers = event?.headers || {};
  const parsed = parseAccessToken(headers.cookie || headers.Cookie);
  if (parsed.status === 'none') return { ok: false, reason: REASONS.NO_TOKEN };
  if (parsed.status === 'malformed') return { ok: false, reason: REASONS.MALFORMED };

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (typeof supabaseUrl !== 'string' || typeof anonKey !== 'string' || !supabaseUrl || !anonKey) {
    return { ok: false, reason: REASONS.MISCONFIGURED };
  }

  let upstream;
  try {
    upstream = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${parsed.token}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return { ok: false, reason: REASONS.UNAVAILABLE };
  }

  if (upstream.status === 401 || upstream.status === 403) return { ok: false, reason: REASONS.UNAUTHORIZED };
  if (!upstream.ok) return { ok: false, reason: REASONS.UNAVAILABLE };

  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return { ok: false, reason: REASONS.INVALID };
  }

  const authUserId = validUserId(payload);
  if (!authUserId) return { ok: false, reason: REASONS.INVALID };

  return { ok: true, authUserId };
}

module.exports = { resolveIdentity, parseAccessToken, REASONS, AUTH_TIMEOUT_MS, MAX_TOKEN_LEN };
