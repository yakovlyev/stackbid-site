// Простейший CRM для подрядчика: список лидов + отметка "связался".
// Тот же паттерн мягкой аутентификации по email, что и у остального сайта
// (никакого пароля/сессии — email как идентификатор, согласовано с текущей
// моделью доверия, а не выдумано заново).
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    if (event.httpMethod === 'GET') {
      const email = (event.queryStringParameters || {}).email;
      if (!email) return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'email required' }) };

      const cr = await fetch(`${SUPABASE_URL}/rest/v1/contractors?email=eq.${encodeURIComponent(email)}&select=id,company_name,subscription_tier,subscription_active,leads_received,leads_converted,rating,review_count,license_verified`, { headers });
      const crows = await cr.json();
      const contractor = crows?.[0];
      if (!contractor) return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: false }) };

      const lr = await fetch(`${SUPABASE_URL}/rest/v1/contractor_leads?contractor_id=eq.${contractor.id}&select=id,project_type,zip_code,budget_range,status,created_at,contacted_at&order=created_at.desc&limit=100`, { headers });
      const leads = await lr.json();

      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: true, contractor, leads: leads || [] }) };
    }

    if (event.httpMethod === 'POST') {
      const { lead_id, status } = JSON.parse(event.body || '{}');
      if (!lead_id || !['contacted', 'won', 'lost'].includes(status)) {
        return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'lead_id and valid status required' }) };
      }
      const patch = { status };
      if (status === 'contacted') patch.contacted_at = new Date().toISOString();

      await fetch(`${SUPABASE_URL}/rest/v1/contractor_leads?id=eq.${lead_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(patch),
      });

      // При "won" — увеличиваем leads_converted у подрядчика
      if (status === 'won') {
        const lr = await fetch(`${SUPABASE_URL}/rest/v1/contractor_leads?id=eq.${lead_id}&select=contractor_id`, { headers });
        const lrows = await lr.json();
        const contractorId = lrows?.[0]?.contractor_id;
        if (contractorId) {
          const cr = await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${contractorId}&select=leads_converted`, { headers });
          const crows = await cr.json();
          const current = crows?.[0]?.leads_converted || 0;
          await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${contractorId}`, {
            method: 'PATCH', headers, body: JSON.stringify({ leads_converted: current + 1 }),
          });
        }
      }

      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers: cors, body: '' };
  } catch (err) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
