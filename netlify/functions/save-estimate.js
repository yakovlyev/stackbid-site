exports.handler = async (event) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  try {
    const { user, estimate } = JSON.parse(event.body || '{}');
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role — обходить RLS, тут довірений сервер-сайд код, не браузер
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
    let userId = null;
    let freeEstimateUsed = false;
    let userWriteError = null;
    if (user?.email) {
      // Сначала проверяем текущее состояние пользователя
      const checkR = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(user.email)}&select=id,free_estimate_used,is_pro`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const existingRows = await checkR.json();
      const existing = existingRows && existingRows[0];
      freeEstimateUsed = existing ? !!existing.free_estimate_used : false;

      const r = await fetch(`${SUPABASE_URL}/rest/v1/users?on_conflict=email`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          email: user.email,
          first_name: user.first_name,
          role: user.role,
          price_alerts: user.price_alerts ?? true,
          last_seen: new Date().toISOString(),
          // Помечаем бесплатну смету використаною, якщо це перший раз
          free_estimate_used: true
        })
      });
      if (r.ok) {
        const d = await r.json();
        userId = d[0]?.id;
      } else {
        userWriteError = await r.text();
        console.error('users upsert failed:', r.status, userWriteError);
      }
    }

    let estimateId = null;
    let estimateError = null;
    if (estimate) {
      const estResp = await fetch(`${SUPABASE_URL}/rest/v1/estimates`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: userId,
          title: estimate.title || null,
          project_type: estimate.project_type || null,
          zip: estimate.zip || null,
          description: estimate.description || null,
          total_retail: estimate.total_retail ?? null,
          total_wholesale: estimate.total_wholesale ?? null,
          total_local: estimate.total_local ?? null,
          items: estimate.items || null
        })
      });
      if (estResp.ok) {
        const ed = await estResp.json();
        estimateId = ed[0]?.id || null;
      } else {
        estimateError = await estResp.text();
      }
    }

    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, user_id: userId, estimate_id: estimateId, estimate_error: estimateError, user_write_error: userWriteError }) };
  } catch (err) {
    return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
