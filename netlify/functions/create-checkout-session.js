// Создаёт Stripe Checkout Session для подписки — либо homeowner ($9.99/мес),
// либо contractor ($49/мес, с настоящим 30-дневным Stripe-триалом вместо
// того чтобы мы сами вручную считали даты и активировали доступ в базе).
// Реальная карта требуется сразу при регистрации — так Stripe сам управляет
// списанием после триала через свой платёжный движок, это единственный
// надёжный способ гарантировать, что либо у подрядчика есть доступ, либо с
// него не списывают ни цента — а не "заплатил и ничего не получил".
const Stripe = require('stripe');
const { resolveContractorIdViaSession } = require('./_session-helper');

// Винесено окремо, щоб тестувати саму логіку визначення особи (найважливіша
// частина цієї безпекової правки) без потреби мокати весь Stripe SDK.
// Повертає { email, contractor_id } АБО { error, statusCode } при відмові.
async function resolveCheckoutIdentity(event, isContractor, bodyEmail, bodyContractorId, SUPABASE_URL, SUPABASE_KEY) {
  if (!isContractor) {
    if (!bodyEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bodyEmail)) {
      return { error: 'Invalid email', statusCode: 400 };
    }
    return { email: bodyEmail, contractor_id: null };
  }

  // БЕЗОПАСНОСТЬ (BOSS-approved slice, 10.09): если есть валидная сессия
  // контрактора — email/contractor_id из тела запроса ИГНОРИРУЮТСЯ
  // полностью, они не могут перекрыть аутентифицированную личность.
  const sessionContractorId = await resolveContractorIdViaSession(event, SUPABASE_URL, SUPABASE_KEY);
  if (sessionContractorId) {
    const cr = await fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${sessionContractorId}&select=id,email`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = cr.ok ? await cr.json() : [];
    if (!rows?.[0]?.email) {
      return { error: 'Service temporarily unavailable', statusCode: 503 };
    }
    return { email: rows[0].email, contractor_id: rows[0].id };
  }

  // Нет сессии — легаси-путь (email+contractor_id из тела, с проверкой
  // соответствия), как и раньше. Временно, пока не все контракторы
  // перешли на новый вход.
  if (!bodyEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bodyEmail)) {
    return { error: 'Invalid email', statusCode: 400 };
  }
  if (!bodyContractorId) {
    return { error: 'contractor_id required', statusCode: 400 };
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { error: 'Service temporarily unavailable', statusCode: 503 };
  }
  const ownerCheck = await fetch(
    `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(bodyContractorId)}&email=eq.${encodeURIComponent(bodyEmail)}&select=id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  const ownerRows = ownerCheck.ok ? await ownerCheck.json() : [];
  if (!ownerRows?.[0]) {
    return { error: 'contractor_id does not match this email', statusCode: 403 };
  }
  return { email: bodyEmail, contractor_id: bodyContractorId };
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': 'https://stackbid.app',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email: bodyEmail, tier, contractor_id: bodyContractorId } = JSON.parse(event.body || '{}');
    const isContractor = tier === 'contractor';

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const SITE_URL = process.env.SITE_URL || 'https://stackbid.app';
    const STRIPE_PRICE_ID = isContractor ? process.env.STRIPE_PRICE_ID_CONTRACTOR : process.env.STRIPE_PRICE_ID;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      // Явно говорим, что оплата ещё не настроена, вместо непонятной 500-ошибки
      return {
        statusCode: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: isContractor
            ? 'Contractor billing is not configured yet — please email hello@stackbid.app'
            : 'Payments are not configured yet',
        }),
      };
    }

    let email = bodyEmail;
    let contractor_id = bodyContractorId;

    const identity = await resolveCheckoutIdentity(
      event,
      isContractor,
      bodyEmail,
      bodyContractorId,
      SUPABASE_URL,
      SUPABASE_KEY,
    );
    if (identity.error) {
      return {
        statusCode: identity.statusCode,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: identity.error }),
      };
    }
    email = identity.email;
    contractor_id = identity.contractor_id;

    const stripe = new Stripe(STRIPE_SECRET_KEY);

    const sessionParams = {
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: isContractor ? `${SITE_URL}/contractor-dashboard.html?signup=success` : `${SITE_URL}/?pro=success`,
      cancel_url: isContractor ? `${SITE_URL}/?contractor_signup=cancelled` : `${SITE_URL}/?pro=cancelled`,
      allow_promotion_codes: true,
      metadata: { app_email: email, tier: isContractor ? 'contractor' : 'homeowner' },
    };

    if (isContractor) {
      // Реальный 30-дневный триал через Stripe — карта привязывается сейчас,
      // первое списание случится автоматически через сам Stripe через 30 дней,
      // не через наш код. metadata на subscription_data — чтобы она была видна
      // и в последующих customer.subscription.* вебхуках, не только в этом.
      sessionParams.subscription_data = {
        trial_period_days: 30,
        metadata: { tier: 'contractor', contractor_id: String(contractor_id) },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not start checkout' }),
    };
  }
};

module.exports.resolveCheckoutIdentity = resolveCheckoutIdentity;
