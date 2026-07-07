// Проверяет, может ли данный email получить ещё одну бесплатную смету,
// или уже использовал бесплатную попытку и не имеет активной подписки Pro.
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=free_estimate_used,is_pro,pro_since`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const existing = rows && rows[0];

    // Новый пользователь — свободная смета ещё доступна
    if (!existing) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ can_use_free: true, is_pro: false }) };
    }

    const isPro = !!existing.is_pro;
    const canUseFree = !existing.free_estimate_used;

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        can_use_free: canUseFree,
        is_pro: isPro,
        // доступ разрешён, если это первая бесплатная смета ИЛИ активна подписка Pro
        access_granted: canUseFree || isPro
      })
    };
  } catch (err) {
    // При сбое проверки — не блокируем пользователя (fail-open), чтобы не терять лиды из-за бага
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ access_granted: true, error: err.message }) };
  }
};
