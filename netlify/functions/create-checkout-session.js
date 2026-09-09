// Создаёт Stripe Checkout Session для подписки — либо homeowner ($9.99/мес),
// либо contractor ($49/мес, с настоящим 30-дневным Stripe-триалом вместо
// того чтобы мы сами вручную считали даты и активировали доступ в базе).
// Реальная карта требуется сразу при регистрации — так Stripe сам управляет
// списанием после триала через свой платёжный движок, это единственный
// надёжный способ гарантировать, что либо у подрядчика есть доступ, либо с
// него не списывают ни цента — а не "заплатил и ничего не получил".
const Stripe = require('stripe');

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email, tier, contractor_id } = JSON.parse(event.body || '{}');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const SITE_URL = process.env.SITE_URL || 'https://stackbid.app';
    const isContractor = tier === 'contractor';
    const STRIPE_PRICE_ID = isContractor ? process.env.STRIPE_PRICE_ID_CONTRACTOR : process.env.STRIPE_PRICE_ID;

    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      // Явно говорим, что оплата ещё не настроена, вместо непонятной 500-ошибки
      return {
        statusCode: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: isContractor ? 'Contractor billing is not configured yet — please email hello@stackbid.app' : 'Payments are not configured yet' })
      };
    }
    if (isContractor && !contractor_id) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'contractor_id required' }) };
    }

    // ВИПРАВЛЕНО 09.09 (знайдено паралельним агентом-аудитором): раніше
    // contractor_id бралось з тіла запиту БЕЗ жодної перевірки — будь-хто
    // міг підставити чужий contractor_id разом зі своїм email, реально
    // оплатити, і вебхук активував би тріал/підписку на ЧУЖОМУ профілі
    // підрядника замість того, хто платить. Тепер перевіряємо, що цей
    // contractor_id реально належить саме цьому email, перш ніж взагалі
    // створювати сесію Stripe.
    if (isContractor) {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!SUPABASE_URL || !SUPABASE_KEY) {
        return { statusCode: 503, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Service temporarily unavailable' }) };
      }
      const ownerCheck = await fetch(
        `${SUPABASE_URL}/rest/v1/contractors?id=eq.${encodeURIComponent(contractor_id)}&email=eq.${encodeURIComponent(email)}&select=id`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const ownerRows = ownerCheck.ok ? await ownerCheck.json() : [];
      if (!ownerRows?.[0]) {
        return { statusCode: 403, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'contractor_id does not match this email' }) };
      }
    }

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

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not start checkout' }) };
  }
};
