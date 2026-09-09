/**
 * StackBid — Отзыв-Добытчик (Review Request Agent)
 *
 * Ідея з AI Mapper (07.09). Ловить правильний момент для запиту відгуку:
 * 14-28 днів після того, як контрактор позначив лід "won" (contacted_at
 * використовується як проксі моменту початку робіт — окремого "won_at"
 * немає, contacted_at — найближче наближення без нової колонки під
 * саме це). Шле лист домовласнику через Resend (той самий шлях, що вже
 * використовує assistant.js для PDF кошторисів).
 *
 * ПОТРІБНА одна нова nullable колонка (review-requested-at-migration.sql,
 * НЕ застосована — чекає дозволу, той самий гейт, що і всі DB-зміни цієї
 * ночі) — без неї агент буде слати лист один і той самий день у день.
 *
 * Запускається за розкладом (щодня, дивись render.yaml).
 *
 * Потрібні змінні оточення:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 */

const MIN_DAYS_AFTER_WON = 14;
const MAX_DAYS_AFTER_WON = 28;
const FROM_ADDRESS = 'StackBid <hello@stackbid.app>';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- чиста логіка вибору кандидатів (легко тестувати без мережі) ----

function isReadyForReviewRequest(lead, nowMs) {
  if (lead.status !== 'won') return false;
  if (lead.review_requested_at) return false;
  if (!lead.contacted_at) return false;
  const ageDays = (nowMs - Date.parse(lead.contacted_at)) / (24 * 60 * 60 * 1000);
  return ageDays >= MIN_DAYS_AFTER_WON && ageDays <= MAX_DAYS_AFTER_WON;
}

function buildReviewRequestEmail(firstName) {
  const greeting = firstName ? `Hi ${firstName}` : 'Hi there';
  return {
    subject: 'How did your project turn out?',
    html: `<p>${greeting},</p>
      <p>A couple of weeks ago StackBid matched you with a contractor for your project. We'd love to know how it went.</p>
      <p>If you have a minute, a short review helps other homeowners find contractors they can trust — and helps us improve our matching too.</p>
      <p><a href="https://stackbid.app/review">Leave a quick review</a></p>
      <p>Thanks for using StackBid!</p>`,
  };
}

// ---- запуск ----

async function sendViaResend(Resend, to, firstName) {
  const resend = new Resend(required('RESEND_API_KEY'));
  const { subject, html } = buildReviewRequestEmail(firstName);
  await resend.emails.send({ from: FROM_ADDRESS, to, subject, html });
}

async function run() {
  console.log('Отзыв-Добытчик — старт');
  const { Resend } = require('resend');

  const leads = await supabaseFetch(
    'contractor_leads?status=eq.won&review_requested_at=is.null&select=id,user_id,status,contacted_at,review_requested_at',
  );
  if (!leads || !leads.length) {
    console.log('Нет закрытых лидов без запроса отзыва.');
    return;
  }

  const now = Date.now();
  const candidates = leads.filter((l) => isReadyForReviewRequest(l, now));
  if (!candidates.length) {
    console.log('Есть закрытые лиды, но ни один ещё не в окне 14-28 дней.');
    return;
  }

  let sent = 0;
  for (const lead of candidates) {
    try {
      const users = await supabaseFetch(`users?id=eq.${lead.user_id}&select=email,first_name`);
      const user = users?.[0];
      if (!user?.email) {
        console.error(`Лид ${lead.id}: не найден email пользователя, пропущено`);
        continue;
      }
      await sendViaResend(Resend, user.email, user.first_name);
      await supabaseFetch(`contractor_leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ review_requested_at: new Date().toISOString() }),
      });
      sent += 1;
    } catch (e) {
      console.error(`Лид ${lead.id}: ошибка отправки —`, e.message);
    }
  }
  console.log(`✓ Отправлено ${sent} из ${candidates.length} запросов на отзыв.`);
}

module.exports = { isReadyForReviewRequest, buildReviewRequestEmail, MIN_DAYS_AFTER_WON, MAX_DAYS_AFTER_WON };

if (require.main === module) {
  run().catch((err) => {
    console.error('Отзыв-Добытчик впав:', err);
    process.exit(1);
  });
}
