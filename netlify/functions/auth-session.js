// GET /api/auth-session — validates the HttpOnly sb_access_token cookie
// against Supabase Auth (/auth/v1/user) and returns only {authenticated:true}.
// Read-only: never returns the token, email, user id, or any upstream error
// body. Missing/malformed cookie short-circuits to 401 without upstream work.
const ALLOWED_ORIGIN = 'https://stackbid.app';
const AUTH_TIMEOUT_MS = 5000;

const BASE = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
};

function accessTokenFromCookies(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  let token = null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== 'sb_access_token') continue;
    if (token !== null) return null;
    const value = part.slice(eq + 1).trim();
    // Supabase access tokens are JWTs (base64url chars + dots). Anything else
    // is malformed — reject without touching the upstream.
    if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
    token = value;
  }
  return token;
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
      headers: { ...BASE, Allow: 'GET, OPTIONS', 'Content-Type': 'application/json' },
      body: JSON.stringify({ authenticated: false }),
    };
  }

  const headers = event.headers || {};
  const token = accessTokenFromCookies(headers.cookie || headers.Cookie);
  if (!token) {
    return {
      statusCode: 401,
      headers: { ...BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authenticated: false }),
    };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return {
      statusCode: 503,
      headers: { ...BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authenticated: false }),
    };
  }

  try {
    const upstream = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (upstream.status === 401 || upstream.status === 403) {
      return {
        statusCode: 401,
        headers: { ...BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ authenticated: false }),
      };
    }
    if (!upstream.ok) {
      return {
        statusCode: 503,
        headers: { ...BASE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ authenticated: false }),
      };
    }
    return {
      statusCode: 200,
      headers: { ...BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authenticated: true }),
    };
  } catch {
    return {
      statusCode: 503,
      headers: { ...BASE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authenticated: false }),
    };
  }
};
