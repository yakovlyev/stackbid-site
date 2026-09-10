const { parseAccessToken } = require('./_auth-identity');

const ALLOWED_ORIGIN = 'https://stackbid.app';
const TIMEOUT_MS = 5000;
const BASE_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
};
const CLEAR_COOKIES = [
  'sb_access_token=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
  'sb_refresh_token=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
];

function response(statusCode, body = '', clear = false, extraHeaders = {}) {
  const result = {
    statusCode,
    headers: { ...BASE_HEADERS, ...extraHeaders },
    body: body === '' ? '' : JSON.stringify(body),
  };
  if (body !== '') result.headers['Content-Type'] = 'application/json';
  if (clear) result.multiValueHeaders = { 'Set-Cookie': CLEAR_COOKIES };
  return result;
}

exports.handler = async (event = {}) => {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (origin !== ALLOWED_ORIGIN) {
    return response(403, { error: 'Forbidden' });
  }

  const method = event.httpMethod || '';
  if (method === 'OPTIONS') {
    return response(204, '', false, {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
  }
  if (method !== 'POST') {
    return response(405, { error: 'Method not allowed' }, false, { Allow: 'POST, OPTIONS' });
  }

  let parsed;
  try {
    parsed = parseAccessToken(headers.cookie || headers.Cookie);
  } catch {
    return response(503, { error: 'Service unavailable' }, true);
  }
  if (parsed.status !== 'ok') return response(204, '', true);

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || typeof anonKey !== 'string' || !url || !anonKey) {
    return response(503, { error: 'Service unavailable' }, true);
  }

  let upstream;
  try {
    upstream = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/logout?scope=local`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${parsed.token}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return response(503, { error: 'Service unavailable' }, true);
  }

  if (upstream.ok || upstream.status === 401) {
    return response(204, '', true);
  }
  return response(503, { error: 'Service unavailable' }, true);
};
