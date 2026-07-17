// Создаёт Stripe Checkout Session для подписки StackBid Pro ($9.99/мес)
// и возвращает URL, куда фронтенд должен перенаправить пользователя.
const Stripe = require('stripe');

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID; // price_... для $9.99/month
    const SITE_URL = process.env.SITE_URL || 'https://stackbid.app';

    if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
      // Явно говорим, что оплата ещё не настроена, вместо непонятной 500-ошибки
      return {
        statusCode: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Payments are not configured yet' })
      };
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${SITE_URL}/?pro=success`,
      cancel_url: `${SITE_URL}/?pro=cancelled`,
      allow_promotion_codes: true,
      // email нужен и в metadata — customer_email не всегда 1-в-1 совпадает
      // с итоговым Customer.email (например, если юзер меняет его на странице оплаты)
      metadata: { app_email: email }
    });

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Could not start checkout' }) };
  }
};
