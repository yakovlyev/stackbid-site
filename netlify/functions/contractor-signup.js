// Регистрация Pro-подрядчика. Раньше форма писала в Supabase напрямую
// anon-ключом — у таблицы contractors нет политики на INSERT для anon,
// поэтому запись молча проваливалась каждый раз (RLS отклонял, ошибка
// не проверялась, форма всё равно показывала "успех"). Теперь пишет
// через сервер с SERVICE_KEY — как и весь остальной бэкенд.
const { Resend } = require('resend');

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { name, company, email, phone, state, zip, license, specialization } = JSON.parse(event.body || '{}');

    if (!name || !company || !email || !phone || !state || !zip || !license) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing required fields' }) };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/contractors`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        company_name: company,
        contact_name: name,
        email,
        phone,
        state,
        zip_code: zip,
        city: '',
        license_number: license,
        license_verified: false, // верификация — отдельный ручной/будущий процесс, не выставляем true просто по факту регистрации
        specializations: [specialization || 'General Contractor'],
        service_zip_codes: [zip],
        subscription_tier: 'trial',
        subscription_active: true, // 30-дневный пробный период активен сразу
        leads_received: 0,
        leads_converted: 0,
        source: 'pro_signup',
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('contractor insert failed:', r.status, errText);
      return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not save your application — please try again or email hello@stackbid.app' }) };
    }
    const rows = await r.json();
    const contractorId = rows[0]?.id;

    // Письмо подрядчику — подтверждение
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      try {
        await resend.emails.send({
          from: 'StackBid <hello@stackbid.app>',
          to: email,
          subject: 'Welcome to StackBid Pro — your 30-day trial is active',
          html: `<p>Hi ${name},</p><p>You're in! <strong>${company}</strong> is now listed on StackBid with your 30-day Pro trial active — priority placement and lead notifications are live now.</p><p>When a homeowner in your area requests a quote, you'll get an email with their project type, ZIP, and budget range right away.</p><p>Questions? Just reply to this email.</p><p>— StackBid</p>`,
        });
        // Внутреннее уведомление
        await resend.emails.send({
          from: 'StackBid <hello@stackbid.app>',
          to: 'hello@stackbid.app',
          subject: `New Pro contractor signup: ${company}`,
          html: `<p>${company} (${name}, ${email}, ${phone}) signed up for Pro trial. State: ${state} ${zip}. License: ${license}.</p>`,
        });
      } catch (e) {
        console.error('contractor signup email failed:', e.message);
        // не блокируем регистрацию из-за сбоя письма — контрактор уже сохранён в базе
      }
    }

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, contractor_id: contractorId }) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
