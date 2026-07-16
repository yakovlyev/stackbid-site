// Обрабатывает вебхуки Stripe: подтверждает оплату и включает/выключает
// is_pro в Supabase. Это единственное место, где is_pro должен меняться —
// никогда не доверяем фронтенду напрямую выставлять Pro-статус.
const Stripe = require('stripe');
const { Resend } = require('resend');

async function sendConfirmationEmail(email) {
  // Confirmation email — обязательный слой для FTC/state auto-renewal
  // compliance: цена, billing cycle, дата следующего списания, как отменить.
  // Best effort — сбой отправки не должен ронять обработку вебхука.
  try {
    if (!process.env.RESEND_API_KEY) return;
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'StackBid <hello@stackbid.app>',
      to: email,
      subject: "You're subscribed to StackBid Pro",
      html: `
        <p>Hi,</p>
        <p>You're now subscribed to <strong>StackBid Pro</strong> — here's a quick summary of your plan:</p>
        <ul>
          <li>Price: <strong>$9.99 / month</strong></li>
          <li>Billing: monthly, renews automatically until canceled</li>
          <li>Includes: unlimited estimates, saved PDFs, project history, price drop alerts</li>
        </ul>
        <p>You can cancel anytime from your account — it takes one click, no phone call or email required.</p>
        <p>Thanks for using StackBid!</p>
      `
    });
  } catch (e) {
    console.error('confirmation email failed:', e.message);
  }
}

async function upsertUserByEmail(SUPABASE_URL, SUPABASE_KEY, email, fields) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation'
  };
  return fetch(`${SUPABASE_URL}/rest/v1/users?on_conflict=email`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, ...fields })
  });
}

async function setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, stripeCustomerId, fields) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
  return fetch(`${SUPABASE_URL}/rest/v1/users?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(fields)
  });
}

exports.handler = async (event) => {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Stripe webhook not configured' }) };
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const email = session.customer_details?.email || session.metadata?.app_email;
        if (email) {
          await upsertUserByEmail(SUPABASE_URL, SUPABASE_KEY, email, {
            is_pro: true,
            pro_since: new Date().toISOString(),
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription
          });
          await sendConfirmationEmail(email);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const isActive = sub.status === 'active' || sub.status === 'trialing';
        await setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, sub.customer, {
          is_pro: isActive,
          stripe_subscription_id: sub.id
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        await setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, sub.customer, { is_pro: false });
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (invoice.customer) {
          await setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, invoice.customer, { is_pro: false });
        }
        break;
      }
      default:
        // Остальные события нам не нужны — Stripe шлёт десятки типов
        break;
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('stripe-webhook processing error:', err.message);
    // 200 даже при внутренней ошибке обработки — иначе Stripe будет
    // бесконечно ретраить один и тот же ивент; ошибку увидим в логах Render.
    return { statusCode: 200, body: JSON.stringify({ received: true, warning: err.message }) };
  }
};
