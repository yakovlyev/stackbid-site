// Крок 6.3: обмін refresh cookie на свіжий access_token, коли 8-годинна
// сесія спливла, але refresh (30 днів) ще дійсний. Це і є "не падати
// мовчки" — без цього контрактору довелось би заново просити magic link
// щоразу через 8 годин.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://stackbid.app' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service temporarily unavailable' }) };
  }

  const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie);
  const refreshToken = cookies.sb_refresh;
  if (!refreshToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'No refresh session' }) };
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    // Сам refresh_token теж прострочився/відкликаний — реальне завершення
    // сесії, більше нічого автоматично зробити не можна.
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Refresh session expired, please sign in again' }),
    };
  }
  const data = await res.json();
  if (!data.access_token) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Refresh session expired, please sign in again' }),
    };
  }

  const setCookies = [cookieHeader('sb_session', data.access_token, 60 * 60 * 8)];
  if (data.refresh_token) {
    setCookies.push(cookieHeader('sb_refresh', data.refresh_token, 60 * 60 * 24 * 30));
  }

  return { statusCode: 200, headers: { ...headers, 'Set-Cookie': setCookies }, body: JSON.stringify({ ok: true }) };
};
