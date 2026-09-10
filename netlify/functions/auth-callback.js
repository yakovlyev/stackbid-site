// Крок 3: обробка magic-link токена. Приймає access_token, який
// client-side сторінка витягла з URL fragment (#access_token=...) —
// сервер fragment ніколи не бачить, тому обмін відбувається так.
//
// Робить РІВНО дві речі:
//   1. Перевіряє токен напряму у Supabase (GET /auth/v1/user) — не довіряє
//      тому, що прислав клієнт, підтверджує реальність через сам Supabase.
//   2. Атомарний "claim": якщо існує contractors-рядок з таким самим email
//      і auth_user_id ще NULL — прив'язує його до цього верифікованого
//      Auth UID. Умова "auth_user_id=is.null" у самому PATCH-запиті —
//      і є той захист від гонки (два одночасні запити не можуть обидва
//      успішно прив'язати той самий рядок).
//
// НЕ чіпає contractor-dashboard.js/html у цьому ж кроці — email-only шлях
// лишається робочим паралельно, поки новий не підтверджений (правило з
// архітектурного документа: не вимикати старе, поки нове не перевірене).
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function cookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://stackbid.app' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service temporarily unavailable' }) };
  }

  let access_token;
  try {
    ({ access_token } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  if (!access_token || typeof access_token !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'access_token required' }) };
  }

  // 1. Перевіряємо токен напряму у Supabase — джерело правди про те, хто
  // реально пройшов magic-link верифікацію, а не те, що прислав клієнт.
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
  }
  const authUser = await userRes.json();
  const verifiedEmail = String(authUser?.email || '')
    .trim()
    .toLowerCase();
  const authUserId = authUser?.id;
  if (!verifiedEmail || !authUserId) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid session payload' }) };
  }

  // 2. Атомарний claim — тільки якщо є рядок з ЦИМ email і auth_user_id
  // ще не зайнято. Умова в самому запиті на запис (PATCH ... WHERE
  // auth_user_id IS NULL), не окремий "перевір потім запиши" — це і є
  // захист від гонки двох одночасних логінів.
  let claimed = false;
  try {
    const claimRes = await fetch(
      `${SUPABASE_URL}/rest/v1/contractors?email=eq.${encodeURIComponent(verifiedEmail)}&auth_user_id=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ auth_user_id: authUserId }),
      },
    );
    const claimedRows = claimRes.ok ? await claimRes.json() : [];
    claimed = Array.isArray(claimedRows) && claimedRows.length > 0;
  } catch (e) {
    console.error('auth-callback: claim step failed (non-fatal, session still issued):', e.message);
  }

  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Set-Cookie': cookieHeader('sb_session', access_token, 60 * 60 * 8), // 8 годин, узгоджено з типовим Supabase access-token TTL
    },
    body: JSON.stringify({ ok: true, claimed, redirect: '/contractor-dashboard.html' }),
  };
};
