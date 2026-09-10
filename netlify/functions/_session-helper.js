// Спільний хелпер для визначення контрактора через верифіковану
// Supabase Auth сесію (cookie sb_session) — використовується скрізь, де
// потрібна "справжня ізоляція власності": contractor-dashboard.js та
// create-checkout-session.js. Винесено в один файл 10.09, щоб не
// дублювати логіку і не ризикувати розбіжністю поведінки між місцями.
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

async function resolveContractorIdViaSession(event, SUPABASE_URL, SUPABASE_KEY) {
  const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie);
  const sessionToken = cookies.sb_session;
  if (!sessionToken) return null;

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${sessionToken}` },
  });
  if (!userRes.ok) return null; // прострочена/невалідна сесія — падаємо назад на легасі-шлях, не помилка
  const authUser = await userRes.json();
  if (!authUser?.id) return null;

  const cr = await fetch(`${SUPABASE_URL}/rest/v1/contractors?auth_user_id=eq.${authUser.id}&select=id`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  const rows = cr.ok ? await cr.json() : [];
  return rows?.[0]?.id || null;
}

module.exports = { parseCookies, resolveContractorIdViaSession };
