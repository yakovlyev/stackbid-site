// Регистрация Pro-подрядчика.
//
// ВАЖНО (исправлено 17.07.2026 — реальный риск, найден до того, как кто-то
// пострадал): раньше эта функция сразу выставляла subscription_active=true
// в базе просто по факту заполнения формы — то есть подрядчик получал
// доступ без единой привязанной карты, а через 30 дней должно было начать
// списываться $49/мес неизвестно каким механизмом (никакого механизма
// физически не было). Обратный, более опасный сценарий — "заплатил и
// ничего не получил" — тоже был возможен в теории при любом сбое между
// формой и базой. Теперь: запись создаётся НЕактивной, подрядчик уходит на
// настоящий Stripe Checkout с 30-дневным триалом (карта привязывается
// сразу, первое списание делает сам Stripe через 30 дней — не наш код).
// subscription_active становится true только когда Stripe подтвердит через
// вебхук (stripe-webhook.js), что подписка реально создана.
const Stripe = require('stripe');

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { name, company, email, phone, state, zip, license, specialization, years_in_business } = JSON.parse(event.body || '{}');

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
        license_verified: false, // верификация — отдельный ручной/будущий процесс
        years_in_business: years_in_business || null,
        specializations: [specialization || 'General Contractor'],
        service_zip_codes: [zip],
        subscription_tier: 'pending_payment',
        subscription_active: false, // становится true только когда Stripe подтвердит оплату/триал
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

    // Сразу создаём Stripe Checkout Session с 30-дневным триалом — фронтенд
    // должен перенаправить пользователя на полученный url для ввода карты.
    // Handyman платит $29/мес, а не $49 — они и так зарабатывают своим
    // трудом на месте, полноценный подрядчик-тариф для них не оправдан.
    const isHandyman = (specialization || '').trim() === 'Handyman';
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const STRIPE_PRICE_ID = isHandyman
      ? process.env.STRIPE_PRICE_ID_HANDYMAN
      : process.env.STRIPE_PRICE_ID_CONTRACTOR;
    const SITE_URL = process.env.SITE_URL || 'https://stackbid.app';

    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      // Оплата ещё не настроена на бэкенде (нужен STRIPE_PRICE_ID_CONTRACTOR
      // и/или STRIPE_PRICE_ID_HANDYMAN в Render) — честно говорим об этом,
      // не притворяемся, что всё готово.
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          contractor_id: contractorId,
          checkout_url: null,
          warning: 'Contractor billing is not fully configured yet — your info is saved, but activation is pending. We will follow up by email.',
        }),
      };
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${SITE_URL}/contractor-dashboard.html?signup=success`,
      cancel_url: `${SITE_URL}/?contractor_signup=cancelled`,
      subscription_data: {
        trial_period_days: 30,
        metadata: { tier: isHandyman ? 'handyman' : 'contractor', contractor_id: String(contractorId) },
      },
      metadata: { tier: isHandyman ? 'handyman' : 'contractor', contractor_id: String(contractorId), app_email: email },
    });

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, contractor_id: contractorId, checkout_url: session.url }) };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
