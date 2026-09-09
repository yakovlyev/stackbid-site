/**
 * StackBid — Онбординг-Мастер (Onboarding Nudge Agent)
 *
 * Ідея з AI Mapper (07.09), адаптована під реальний стан коду: реєстрація
 * контрактора вже збирає все одразу (ліцензія, спеціалізація, стаж) в
 * одній формі — немає багатокрокового майстра з покинутими кроками, як
 * задумувалось у Mapper. Зате є РЕАЛЬНИЙ застряглий стан: контрактор
 * реєструється, але `subscription_active` лишається false, поки Stripe
 * не підтвердить оплату (contractor-signup.js) — і зараз ніхто не
 * нагадує їм завершити цей крок.
 *
 * Шле один нагадувальний лист через 3 дні після реєстрації, якщо
 * підписка все ще не активна — не спамить повторно (перевіряє через
 * created_at, не потребує нової колонки).
 *
 * ВАЖЛИВО про фільтр: contractors також містить ~129 рядків з
 * імпортованого/сканованого каталогу (не реальні реєстрації через
 * contractor-signup.js) — у них теж subscription_active=false, і деякі
 * можуть мати реальний email справжнього бізнесу. Запит фільтрує на
 * license_number IS NOT NULL — це поле ОБОВ'ЯЗКОВЕ при реальній подачі
 * форми (contractor-signup.js кидає 400 без нього), тому майже напевно
 * відсутнє у сканованих каталожних рядках. Без цього фільтра можна
 * випадково написати реальному чужому бізнесу "ви почали реєстрацію",
 * хоча вони ніколи цього не робили.
 *
 * Запускається за розкладом (щодня, дивись render.yaml).
 *
 * Потрібні змінні оточення:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 */

const NUDGE_AFTER_DAYS = 3;
const NUDGE_WINDOW_DAYS = 1; // шле в цьому вузькому вікні, щоб не слати щодня повторно
const FROM_ADDRESS = 'StackBid <hello@stackbid.app>';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function supabaseFetch(path) {
  const res = await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`, {
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- чиста логіка вибору (легко тестувати без мережі) ----

function isInNudgeWindow(contractor, nowMs) {
  if (contractor.subscription_active) return false;
  if (!contractor.created_at) return false;
  const ageDays = (nowMs - Date.parse(contractor.created_at)) / (24 * 60 * 60 * 1000);
  return ageDays >= NUDGE_AFTER_DAYS && ageDays < NUDGE_AFTER_DAYS + NUDGE_WINDOW_DAYS;
}

function buildNudgeEmail(companyName) {
  const greeting = companyName ? `Hi ${companyName} team` : 'Hi';
  return {
    subject: 'Finish setting up your StackBid contractor account',
    html: `<p>${greeting},</p>
      <p>You started signing up for StackBid a few days ago, but your subscription isn't active yet — which means you're not receiving any leads.</p>
      <p>It only takes a minute to finish. If something went wrong or you have questions, just reply to this email.</p>
      <p><a href="https://stackbid.app/contractor-signup.html">Complete your setup</a></p>
      <p>Thanks,<br>StackBid</p>`,
  };
}

// ---- запуск ----

async function run() {
  console.log('Онбординг-Мастер — старт');
  const { Resend } = require('resend');
  const resend = new Resend(required('RESEND_API_KEY'));

  const contractors = await supabaseFetch(
    'contractors?subscription_active=eq.false&license_number=not.is.null&select=id,email,company_name,created_at',
  );
  if (!contractors || !contractors.length) {
    console.log('Нет незавершённых регистраций.');
    return;
  }

  const now = Date.now();
  const candidates = contractors.filter((c) => isInNudgeWindow(c, now));
  if (!candidates.length) {
    console.log('Есть незавершённые регистрации, но ни одна не в окне 3 дней.');
    return;
  }

  let sent = 0;
  for (const c of candidates) {
    if (!c.email) continue;
    try {
      const { subject, html } = buildNudgeEmail(c.company_name);
      await resend.emails.send({ from: FROM_ADDRESS, to: c.email, subject, html });
      sent += 1;
    } catch (e) {
      console.error(`Контрактор ${c.id}: ошибка отправки —`, e.message);
    }
  }
  console.log(`✓ Отправлено ${sent} из ${candidates.length} напоминаний.`);
}

module.exports = { isInNudgeWindow, buildNudgeEmail, NUDGE_AFTER_DAYS, NUDGE_WINDOW_DAYS };

if (require.main === module) {
  run().catch((err) => {
    console.error('Онбординг-Мастер впав:', err);
    process.exit(1);
  });
}
