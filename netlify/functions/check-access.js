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
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role — обходить RLS, тут довірений сервер-сайд код, не браузер

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

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        can_use_free: canUseFree,
        is_pro: isPro,
        access_token: accessToken,
        // доступ разрешён, если это первая бесплатная смета ИЛИ активна подписка Pro
        access_granted: canUseFree || isPro
      })
    };
  } catch (err) {
    // При сбое проверки — не блокируем пользователя (fail-open), чтобы не терять лиды из-за бага
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ access_granted: true, error: err.message }) };
  }
};
