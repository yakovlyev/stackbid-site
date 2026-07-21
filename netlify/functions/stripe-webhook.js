// Обрабатывает вебхуки Stripe: подтверждает оплату и включает/выключает
// is_pro (homeowner) или subscription_active (contractor) в Supabase. Это
// единственное место, где эти поля должны меняться — никогда не доверяем
// фронтенду напрямую выставлять статус подписки.
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

async function sendContractorConfirmationEmail(email, trialEnd, isHandyman) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const resend = new Resend(process.env.RESEND_API_KEY);
    const trialEndStr = trialEnd ? new Date(trialEnd * 1000).toLocaleDateString() : 'in 30 days';
    const price = isHandyman ? '$29' : '$49';
    const roleLabel = isHandyman ? 'Handyman' : 'Contractor';
    await resend.emails.send({
      from: 'StackBid <hello@stackbid.app>',
      to: email,
      subject: `Your StackBid Pro ${roleLabel.toLowerCase()} trial is confirmed`,
      html: `
        <p>Hi,</p>
        <p>Your card is on file and your <strong>30-day free trial</strong> of StackBid Pro ${roleLabel} is active — priority placement and lead notifications start now.</p>
        <ul>
          <li>Price after trial: <strong>${price} / month</strong></li>
          <li>First charge: <strong>${trialEndStr}</strong></li>
          <li>Billing: monthly, renews automatically until canceled</li>
        </ul>
        <p>You can cancel anytime before the trial ends and you won't be charged. Manage your subscription from your <a href="https://stackbid.app/contractor-dashboard.html">contractor dashboard</a>.</p>
        <p>Thanks for joining StackBid!</p>
      `
    });
  } catch (e) {
    console.error('contractor confirmation email failed:', e.message);
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

async function updateContractorById(SUPABASE_URL, SUPABASE_KEY, contractorId, fields) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  return fetch(`${SUPABASE_URL}/rest/v1/contractors?id=eq.${contractorId}`, {
    method: 'PATCH', headers, body: JSON.stringify(fields),
  });
}

async function updateContractorByCustomerId(SUPABASE_URL, SUPABASE_KEY, stripeCustomerId, fields) {
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
  return fetch(`${SUPABASE_URL}/rest/v1/contractors?stripe_customer_id=eq.${encodeURIComponent(stripeCustomerId)}`, {
    method: 'PATCH', headers, body: JSON.stringify(fields),
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
        const isContractor = session.metadata?.tier === 'contractor' || session.metadata?.tier === 'handyman';
        const email = session.customer_details?.email || session.metadata?.app_email;

        if (isContractor && session.metadata?.contractor_id) {
          // Подрядчик подтвердил карту — Stripe сам начнёт списывать через
          // 30 дней (trial_period_days), мы просто активируем доступ сейчас.
          await updateContractorById(SUPABASE_URL, SUPABASE_KEY, session.metadata.contractor_id, {
            subscription_active: true,
            subscription_tier: 'trial',
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
          });
          // trial_end читаем из подписки отдельно, т.к. в session его нет напрямую
          try {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            await updateContractorById(SUPABASE_URL, SUPABASE_KEY, session.metadata.contractor_id, {
              trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
            });
            if (email) await sendContractorConfirmationEmail(email, sub.trial_end, session.metadata?.tier === 'handyman');
          } catch (e) {
            console.error('could not fetch subscription for trial_end:', e.message);
          }
        } else if (email) {
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
        if ((sub.metadata?.tier === 'contractor' || sub.metadata?.tier === 'handyman') && sub.metadata?.contractor_id) {
          await updateContractorById(SUPABASE_URL, SUPABASE_KEY, sub.metadata.contractor_id, {
            subscription_active: isActive,
            subscription_tier: sub.status === 'trialing' ? 'trial' : 'pro',
            stripe_subscription_id: sub.id,
          });
        } else {
          await setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, sub.customer, {
            is_pro: isActive,
            stripe_subscription_id: sub.id
          });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        if ((sub.metadata?.tier === 'contractor' || sub.metadata?.tier === 'handyman') && sub.metadata?.contractor_id) {
          await updateContractorById(SUPABASE_URL, SUPABASE_KEY, sub.metadata.contractor_id, { subscription_active: false, subscription_tier: 'cancelled' });
        } else {
          await setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, sub.customer, { is_pro: false });
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (invoice.customer) {
          // Пробуем оба варианта — не знаем заранее, чей это customer
          await setProByCustomerId(SUPABASE_URL, SUPABASE_KEY, invoice.customer, { is_pro: false });
          await updateContractorByCustomerId(SUPABASE_URL, SUPABASE_KEY, invoice.customer, { subscription_active: false });
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
