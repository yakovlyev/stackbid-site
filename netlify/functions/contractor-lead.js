// Приём лида для подрядчика: пишет в contractor_leads, шлёт email-уведомление
// подрядчику с готовым "квалифицированным пакетом" (тип проекта, ZIP, бюджет —
// та самая идея из разбора конкурентов: лид приходит уже подготовленным),
// увеличивает contractors.leads_received.
const { Resend } = require('resend');

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { contractor_id, user_email, project_type, zip_code, budget_low, budget_high } = JSON.parse(event.body || '{}');
    if (!contractor_id) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'contractor_id required' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    // Найти user_id по email, если он у нас уже есть (не обязателен для лида)
    let userId = null;
    if (user_email) {
      const ur = await fetch(`${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(user_email)}&select=id`, { headers });
      const urows = await ur.json();
      userId = urows?.[0]?.id || null;
    }

    const budgetRange = budget_low && budget_high ? `$${Math.round(budget_low).toLocaleString()} - $${Math.round(budget_high).toLocaleString()}` : null;

    const leadR = await fetch(`${SUPABASE_URL}/rest/v1/contractor_leads`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        contractor_id,
        user_id: userId,
        project_type: project_type || null,
        zip_code: zip_code || null,
        budget_range: budgetRange,
        status: 'new',
      }),
    });
    if (!leadR.ok) {
      const errText = await leadR.text();
      console.error('lead insert failed:', leadR.status, errText);
      return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not submit request, please try calling directly' }) };
    }

    // Получить контактные данные подрядчика + текущий счётчик лидов
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${contractor_id}&select=email,company_name,leads_received`, { headers });
    const crows = await cr.json();
    const contractor = crows?.[0];

    if (contractor?.email && process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      try {
        await resend.emails.send({
          from: 'StackBid <hello@stackbid.app>',
          to: contractor.email,
          subject: `New lead: ${project_type || 'project'} in ${zip_code || 'your area'}`,
          html: `<p>Hi ${contractor.company_name || ''},</p>
                 <p>A homeowner just requested your contact info through StackBid:</p>
                 <ul>
                   <li><strong>Project type:</strong> ${project_type || 'not specified'}</li>
                   <li><strong>ZIP code:</strong> ${zip_code || 'not specified'}</li>
                   <li><strong>Estimated budget:</strong> ${budgetRange || 'not specified'}</li>
                 </ul>
                 <p>They already know their materials and labor budget, so this is a warm lead — reach out soon for the best chance of winning the job.</p>`,
        });
      } catch (e) {
        console.error('lead notification email failed:', e.message);
        // лид уже сохранён в базе — сбой письма не должен ломать ответ пользователю
      }

      // Увеличиваем счётчик лидов (не критично при гонке — простая инкрементальная запись)
      await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${contractor_id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ leads_received: (contractor.leads_received || 0) + 1 }),
      });
    }

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
