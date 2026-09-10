// Простейший CRM для подрядчика: список лидов + отметка "связался".
// НОВЕ (наступний крок після auth-callback.js): якщо є валідна cookie-сесія
// (sb_session), контрактор визначається через ВЕРИФІКОВАНИЙ Supabase Auth
// UID — це і є "справжня ізоляція власності", а не довіра до email/
// contractor_id, які клієнт може підставити. Старий email-шлях лишається
// як резерв — свідомо, поки новий не обкатаний (правило: не вимикати
// старе, поки нове не перевірене).
const { parseCookies, resolveContractorIdViaSession } = require('./_session-helper');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': 'https://stackbid.app',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

  try {
    if (event.httpMethod === 'GET') {
      const sessionContractorId = await resolveContractorIdViaSession(event, SUPABASE_URL, SUPABASE_KEY);
      const email = (event.queryStringParameters || {}).email;
      if (!sessionContractorId && !email) {
        return {
          statusCode: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'email required' }),
        };
      }

      const contractorFilter = sessionContractorId
        ? `id=eq.${sessionContractorId}`
        : `email=eq.${encodeURIComponent(email)}`;
      const cr = await fetch(
        `${SUPABASE_URL}/rest/v1/contractors?${contractorFilter}&select=id,company_name,subscription_tier,subscription_active,leads_received,leads_converted,rating,review_count,license_verified`,
        { headers },
      );
      const crows = await cr.json();
      const contractor = crows?.[0];
      if (!contractor)
        return {
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ found: false }),
        };

      const lr = await fetch(
        `${SUPABASE_URL}/rest/v1/contractor_leads?contractor_id=eq.${contractor.id}&select=id,project_type,zip_code,budget_range,status,created_at,contacted_at&order=created_at.desc&limit=100`,
        { headers },
      );
      const leads = await lr.json();

      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: true, contractor, leads: leads || [], viaSession: !!sessionContractorId }),
      };
    }

    if (event.httpMethod === 'POST') {
      const { lead_id, status, email } = JSON.parse(event.body || '{}');
      if (!lead_id || !['contacted', 'won', 'lost'].includes(status)) {
        return {
          statusCode: 400,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'lead_id and valid status required' }),
        };
      }

      const lr0 = await fetch(`${SUPABASE_URL}/rest/v1/contractor_leads?id=eq.${lead_id}&select=contractor_id`, {
        headers,
      });
      const lrows0 = await lr0.json();
      const leadContractorId = lrows0?.[0]?.contractor_id;
      if (!leadContractorId) {
        return {
          statusCode: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'lead not found' }),
        };
      }

      // Захист від IDOR, тепер у двох варіантах: якщо є сесія — власність
      // підтверджується через верифікований UID (найнадійніше); інакше —
      // старий email-шлях лишається як резерв, поки не всі контрактори
      // перейшли на новий вхід.
      const sessionContractorId = await resolveContractorIdViaSession(event, SUPABASE_URL, SUPABASE_KEY);
      let isOwner = false;
      if (sessionContractorId) {
        isOwner = sessionContractorId === leadContractorId;
      } else if (email) {
        const ownerCheck = await fetch(
          `${SUPABASE_URL}/rest/v1/contractors?id=eq.${leadContractorId}&email=eq.${encodeURIComponent(email)}&select=id`,
          { headers },
        );
        const ownerRows = await ownerCheck.json();
        isOwner = !!ownerRows?.[0];
      }
      if (!isOwner) {
        return {
          statusCode: 403,
          headers: { ...cors, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'not your lead' }),
        };
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
        const cr = await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${leadContractorId}&select=leads_converted`, {
          headers,
        });
        const crows = await cr.json();
        const current = crows?.[0]?.leads_converted || 0;
        await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${leadContractorId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ leads_converted: current + 1 }),
        });
      }

      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    return { statusCode: 405, headers: cors, body: '' };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};

module.exports.parseCookies = parseCookies;
module.exports.resolveContractorIdViaSession = resolveContractorIdViaSession;
