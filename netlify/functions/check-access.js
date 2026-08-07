// Проверяет, может ли данный email получить ещё одну бесплатную смету,
// или уже использовал бесплатную попытку и не имеет активной подписки Pro.
//
// Плюс: мягкое (не блокирующее) отслеживание шаринга доступа по IP —
// если один email используется с необычно большого числа разных IP,
// аккаунт помечается suspicious_sharing=true для ручного просмотра,
// но доступ НЕ отзывается автоматически (высокий риск ложных срабатываний
// на мобильных сетях/VPN — блокировать реальных клиентов нельзя).
//
// Полноценная верификация владения email (magic-link/OTP) сознательно
// отложена на потом — сейчас есть только эта мягкая эвристика.

// Demo/владелец продукта — никогда не должен упираться в пейволл при показе продукта
const DEMO_EMAILS = new Set(['yakovlyev62@gmail.com']);

const SUSPICIOUS_IP_THRESHOLD = 3; // разных IP за WINDOW_DAYS
const WINDOW_DAYS = 30;

async function logAccessAndCheckSharing(SUPABASE_URL, SUPABASE_KEY, email, ip) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/access_log`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, ip: ip || null }),
    });
  } catch (e) {
    return; // не удалось залогировать — не считаем IP, просто выходим тихо
  }

  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/access_log?email=eq.${encodeURIComponent(email)}&created_at=gte.${since}&select=ip`,
      { headers }
    );
    const rows = await r.json();
    const distinctIps = new Set((rows || []).map((row) => row.ip).filter(Boolean));

    if (distinctIps.size > SUSPICIOUS_IP_THRESHOLD) {
      await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ suspicious_sharing: true, suspicious_sharing_flagged_at: new Date().toISOString() }),
      });
    }
  } catch (e) {
    // сбой подсчёта/флага — не критично, просто не пометим в этот раз
  }
}

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid email' }) };
    }
    const normalizedEmail = email.trim().toLowerCase();

    if (DEMO_EMAILS.has(normalizedEmail)) {
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ can_use_free: true, is_pro: true, access_granted: true }),
      };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // service role — обходить RLS, тут довірений сервер-сайд код, не браузер

    const ip = (event.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || event.headers?.['x-real-ip'] || null;
    await logAccessAndCheckSharing(SUPABASE_URL, SUPABASE_KEY, normalizedEmail, ip);

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id,free_estimate_used,is_pro,pro_since,access_token`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const existing = rows && rows[0];

    // Новый пользователь — свободная смета ещё доступна
    if (!existing) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ can_use_free: true, is_pro: false }) };
    }

    // Возвращаем access_token, чтобы клиент мог его сохранить — нужен для
    // get-estimates.js, которая иначе отдавала бы историю смет кому угодно
    // по одному email. Лениво выпускаем, если у существующей строки его
    // почему-то ещё нет (например, юзер создан до этого поля).
    let accessToken = existing.access_token;
    if (!accessToken) {
      accessToken = require('crypto').randomBytes(24).toString('base64url');
      await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken }),
      });
    }

    const isPro = !!existing.is_pro;
    const canUseFree = !existing.free_estimate_used;

    // Ценностная лестница: Handyman ($29) и Contractor Pro ($49) — тарифы
    // дороже Homeowner Pro ($9.99), поэтому их подписка ДОЛЖНА включать в
    // себя как минимум всё, что даёт Homeowner Pro (безлимитные сметы,
    // история, PDF) — иначе получается, что кто платит больше, получает
    // меньше по умолчанию (баг, найден и исправлен 28.07). Проверяем по
    // тому же email, активна ли подписка контрактора/хендимена.
    let isProViaContractor = false;
    try {
      const cr = await fetch(
        `${SUPABASE_URL}/rest/v1/contractors?email=eq.${encodeURIComponent(email)}&subscription_active=eq.true&select=id&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const crRows = await cr.json();
      isProViaContractor = !!(crRows && crRows[0]);
    } catch (e) {
      // сбой этой проверки не должен ронять весь access-check — просто не
      // даём бонус в этот раз, основной is_pro всё ещё работает
    }

    const effectivePro = isPro || isProViaContractor;

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        can_use_free: canUseFree,
        is_pro: effectivePro,
        access_token: accessToken,
        // доступ разрешён, если это первая бесплатная смета ИЛИ активна подписка Pro (напрямую или через Contractor/Handyman)
        access_granted: canUseFree || effectivePro
      })
    };
  } catch (err) {
    // При сбое проверки — не блокируем пользователя (fail-open), чтобы не терять лиды из-за бага
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ access_granted: true, error: err.message }) };
  }
};
