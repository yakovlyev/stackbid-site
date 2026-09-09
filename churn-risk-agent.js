/**
 * StackBid — Анти-Отток (Contractor Churn Risk Digest)
 *
 * Ідея з AI Mapper (07.09). Ловить підрядника до відміни підписки, а не
 * після. Використовує ТІЛЬКИ колонки, які вже реально існують і
 * підтверджені в живій базі (leads_received, leads_converted,
 * subscription_active, subscription_tier, review_count) — жодних нових
 * полів чи таблиць не потрібно.
 *
 * Три ознаки ризику (навмисно прості й пояснювані, не чорна скринька):
 *   1. paying_zero_conversion — платить, отримав ≥3 ліди, жодного не
 *      закрив. Класична ознака "плачу, а користі нема".
 *   2. paying_zero_leads — платить, за весь час не отримав жодного ліда
 *      (проблема мэтчингу/покриття гео, не підрядника).
 *   3. inactive_recent — активна підписка, але жодного нового ліда за
 *      останні 30 днів (раніше отримував — тепер тиша).
 *
 * Запускається за розкладом (щотижня, дивись render.yaml).
 *
 * Потрібні змінні оточення:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNT_ID
 *   REPORT_TO_EMAIL
 */

const ZOHO_MAIL_API = 'https://mail.zoho.com/api';
const FROM_ADDRESS = 'hello@stackbid.app';
const INACTIVE_DAYS = 30;
const ZERO_CONVERSION_MIN_LEADS = 3;

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

async function getZohoAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: required('ZOHO_CLIENT_ID'),
    client_secret: required('ZOHO_CLIENT_SECRET'),
    refresh_token: required('ZOHO_REFRESH_TOKEN'),
  });
  const res = await fetch(`https://accounts.zoho.com/oauth/v2/token?${params}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Zoho token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`Zoho token refresh returned no access_token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function sendReportEmail(subject, html) {
  const accessToken = await getZohoAccessToken();
  const accountId = required('ZOHO_ACCOUNT_ID');
  const res = await fetch(`${ZOHO_MAIL_API}/accounts/${accountId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromAddress: FROM_ADDRESS, toAddress: required('REPORT_TO_EMAIL'), subject, content: html }),
  });
  if (!res.ok) throw new Error(`Zoho send failed: ${res.status} ${await res.text()}`);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- чиста логіка ризику (легко тестувати без мережі) ----

function assessRisk(contractor, recentLeadCount) {
  const { leads_received = 0, leads_converted = 0, subscription_active } = contractor;
  if (!subscription_active) return null;

  if (leads_received === 0) {
    return { reason: 'paying_zero_leads', detail: 'Платит, ни одного лида за всё время' };
  }
  if (leads_received >= ZERO_CONVERSION_MIN_LEADS && leads_converted === 0) {
    return { reason: 'paying_zero_conversion', detail: `Платит, ${leads_received} лидов, 0 закрыто` };
  }
  if (recentLeadCount === 0) {
    return { reason: 'inactive_recent', detail: `0 новых лидов за последние ${INACTIVE_DAYS} дней` };
  }
  return null;
}

function buildDigestHtml(atRisk) {
  if (!atRisk.length) {
    return '<p>Анти-Отток: подрядчиков в зоне риска не найдено.</p>';
  }
  const rows = atRisk
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.company_name)}</td><td>${escapeHtml(r.subscription_tier)}</td><td>${escapeHtml(r.reason)}</td><td>${escapeHtml(r.detail)}</td></tr>`,
    )
    .join('');
  return `<p>Анти-Отток: ${atRisk.length} подрядчик(ов) в зоне риска отказа от подписки:</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;"><tr><th>Компания</th><th>Тариф</th><th>Причина</th><th>Детали</th></tr>${rows}</table>`;
}

// ---- запуск ----

async function run() {
  console.log('Анти-Отток — старт');
  const contractors = await supabaseFetch(
    'contractors?subscription_active=eq.true&select=id,company_name,subscription_tier,leads_received,leads_converted',
  );
  if (!contractors || !contractors.length) {
    console.log('Нет активных подписчиков.');
    return;
  }

  const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recentLeads = await supabaseFetch(`contractor_leads?created_at=gte.${cutoff}&select=contractor_id`);
  const recentCountByContractor = new Map();
  for (const lead of recentLeads || []) {
    recentCountByContractor.set(lead.contractor_id, (recentCountByContractor.get(lead.contractor_id) || 0) + 1);
  }

  const atRisk = [];
  for (const c of contractors) {
    const risk = assessRisk(c, recentCountByContractor.get(c.id) || 0);
    if (risk) atRisk.push({ company_name: c.company_name, subscription_tier: c.subscription_tier, ...risk });
  }

  await sendReportEmail(`⚠️ Анти-Отток: ${atRisk.length} подрядчик(ов) в зоне риска`, buildDigestHtml(atRisk));
  console.log(`✓ Проверено ${contractors.length} подписчиков, в зоне риска: ${atRisk.length}.`);
}

module.exports = { escapeHtml, assessRisk, buildDigestHtml };

if (require.main === module) {
  run().catch((err) => {
    console.error('Анти-Отток впав:', err);
    process.exit(1);
  });
}
