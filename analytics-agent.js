/**
 * StackBid — Analytics Agent
 *
 * Раз в 3 дня (Render Cron Job) собирает ОДИН полный отчёт: реальные бизнес-
 * метрики из Supabase (регистрации, сметы, тарифы, how_heard) + трафик и
 * посещаемость страниц из Google Analytics 4 (через официальный GA4 Data
 * API) — и присылает письмом. Игорь ничего отдельно не открывает.
 *
 * Требуемые переменные окружения (Render):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNT_ID
 *   REPORT_TO_EMAIL        — куда слать отчёт. Поддерживает несколько адресов
 *                            через запятую (Zoho Mail API это принимает), например:
 *                            "agent.analytic@gmail.com,maksim@example.com"
 *                            Сейчас: agent.analytic@gmail.com (Игорь, для всех
 *                            аналитических отчётов по всем проектам). Максим
 *                            добавит свой адрес вечером 31.07 — просто дописать
 *                            через запятую в этой же переменной на Render.
 *   GA4_PROPERTY_ID        — числовой ID property в GA4 (Admin → Property Settings)
 *   GA4_SERVICE_ACCOUNT_JSON — содержимое JSON-ключа сервисного аккаунта Google
 *                              (целиком, как одна строка/переменная окружения)
 *
 * Разовая настройка GA4 (не код, см. инструкцию отдельным файлом):
 *   1. Google Cloud Console → создать проект → включить "Google Analytics Data API"
 *   2. Создать Service Account → сгенерировать JSON-ключ
 *   3. В GA4 (analytics.google.com) → Admin → Property Access Management →
 *      добавить email сервисного аккаунта как Viewer
 *   4. Вписать GA4_PROPERTY_ID и GA4_SERVICE_ACCOUNT_JSON в Render
 *
 * Расписание в render.yaml: каждые 3 дня в 9 утра (cron: 0 9 with a step-3 day field)
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const ZOHO_MAIL_API = 'https://mail.zoho.com/api';
const FROM_ADDRESS = 'hello@stackbid.app';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function supabaseFetch(path) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------- Zoho Mail (тот же паттерн, что в email-agent.js) ----------

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
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fromAddress: FROM_ADDRESS,
      toAddress: required('REPORT_TO_EMAIL'),
      subject,
      content: html,
    }),
  });
  if (!res.ok) throw new Error(`Zoho send failed: ${res.status} ${await res.text()}`);
}

// ---------- Google Analytics 4 (реальный трафик и страницы) ----------

async function fetchGA4Data() {
  const propertyId = required('GA4_PROPERTY_ID');
  const credsJson = required('GA4_SERVICE_ACCOUNT_JSON');
  let credentials;
  try {
    credentials = JSON.parse(credsJson);
  } catch (e) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is not valid JSON — paste the full service account key file content');
  }

  const client = new BetaAnalyticsDataClient({ credentials });

  const [trafficReport] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '3daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 15,
  });

  const [pagesReport] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '3daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 15,
  });

  const [totalsReport] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '3daysAgo', endDate: 'today' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'screenPageViews' }],
  });

  const rowsOf = (report) =>
    (report.rows || []).map((r) => ({
      dim: r.dimensionValues?.[0]?.value || '(не указано)',
      metrics: r.metricValues.map((m) => m.value),
    }));

  const totals = totalsReport.rows?.[0]?.metricValues || [];

  return {
    traffic: rowsOf(trafficReport),
    pages: rowsOf(pagesReport),
    totalSessions: totals[0]?.value || '0',
    totalUsers: totals[1]?.value || '0',
    totalPageViews: totals[2]?.value || '0',
  };
}



function countBy(rows, field) {
  const counts = {};
  for (const r of rows) {
    const key = r[field] || '(не указано)';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

async function buildReport() {
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

  // Новые сметы за период — по типам проектов
  const estimates = await supabaseFetch(
    `estimates?select=project_type,zip,total_retail,total_local,created_at&created_at=gte.${since}&limit=1000`
  );

  // Новые регистрации подрядчиков/хендименов — по тарифу и по how_heard
  const contractors = await supabaseFetch(
    `contractors?select=subscription_tier,specializations,how_heard,subscription_active,created_at&created_at=gte.${since}&limit=1000`
  );

  // Новые пользователи сайта (email-gate) и сколько из них стали Pro
  const users = await supabaseFetch(
    `users?select=is_pro,created_at&created_at=gte.${since}&limit=1000`
  );

  const estimatesByType = countBy(estimates, 'project_type');
  const contractorsByTier = countBy(contractors, 'subscription_tier');
  const contractorsBySource = countBy(contractors, 'how_heard');
  const activeContractors = contractors.filter((c) => c.subscription_active).length;
  const newProUsers = users.filter((u) => u.is_pro).length;

  // GA4 — если ещё не настроен (нет переменных), не роняем весь отчёт,
  // просто помечаем этот блок как "не настроено" и отправляем остальное
  let ga4 = null;
  let ga4Error = null;
  try {
    ga4 = await fetchGA4Data();
  } catch (e) {
    ga4Error = e.message;
  }

  const rows = (label, data) =>
    data.length
      ? data.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;">${k}</td><td style="padding:4px 0;font-weight:600;">${v}</td></tr>`).join('')
      : `<tr><td colspan="2" style="padding:4px 0;color:#999;">нет данных за период</td></tr>`;

  const ga4Html = ga4
    ? `
    <h3>🌐 Трафик (Google Analytics): ${ga4.totalSessions} сессий, ${ga4.totalUsers} пользователей, ${ga4.totalPageViews} просмотров страниц</h3>
    <h4>Откуда пришли:</h4>
    <table><tr><th align="left">Источник</th><th align="left">Сессии</th><th align="left">Пользователи</th></tr>
      ${ga4.traffic.map((r) => `<tr><td style="padding:4px 12px 4px 0;">${r.dim}</td><td style="padding:4px 12px 4px 0;">${r.metrics[0]}</td><td style="padding:4px 0;">${r.metrics[1]}</td></tr>`).join('') || '<tr><td colspan="3" style="color:#999;">нет данных</td></tr>'}
    </table>
    <h4>Какие страницы смотрели:</h4>
    <table><tr><th align="left">Страница</th><th align="left">Просмотров</th></tr>
      ${ga4.pages.map((r) => `<tr><td style="padding:4px 12px 4px 0;">${r.dim}</td><td style="padding:4px 0;font-weight:600;">${r.metrics[0]}</td></tr>`).join('') || '<tr><td colspan="2" style="color:#999;">нет данных</td></tr>'}
    </table>`
    : `
    <h3>🌐 Трафик (Google Analytics)</h3>
    <p style="color:#c0392b;">GA4 ещё не настроен для этого отчёта (${ga4Error}). Бизнес-метрики ниже — реальные, это только блок трафика временно недоступен. См. инструкцию по подключению GA4 API.</p>`;

  const html = `
    <h2>StackBid — отчёт за последние 3 дня</h2>
    <p style="color:#666;">${new Date(since).toLocaleDateString('ru-RU')} — ${new Date().toLocaleDateString('ru-RU')}</p>

    <h3>📊 Сметы: ${estimates.length} всего</h3>
    <table>${rows('project_type', estimatesByType)}</table>

    <h3>👷 Новые регистрации подрядчиков/хендименов: ${contractors.length}</h3>
    <p>Из них активных (после подтверждения оплаты/триала): <b>${activeContractors}</b></p>
    <table><tr><th align="left">Тариф</th><th align="left">Кол-во</th></tr>${rows('tier', contractorsByTier)}</table>
    <h4>Откуда узнали (how_heard):</h4>
    <table>${rows('source', contractorsBySource)}</table>

    <h3>👤 Новые пользователи сайта: ${users.length}</h3>
    <p>Из них купили Homeowner Pro: <b>${newProUsers}</b></p>

    <p style="color:#999;font-size:13px;margin-top:24px;">
      Это данные из наших таблиц (реальные регистрации/сметы), не из Google Analytics.
      Источники трафика и посещаемость страниц — в GA4 (G-FRXYX65KWN), analytics.google.com.
    </p>
  `;

  return { html, estimatesCount: estimates.length, contractorsCount: contractors.length, usersCount: users.length };
}

async function run() {
  console.log('Analytics Agent — старт');
  const { html, estimatesCount, contractorsCount, usersCount } = await buildReport();
  const subject = `StackBid отчёт: ${estimatesCount} смет, ${contractorsCount} новых про, ${usersCount} юзеров (3 дня)`;
  await sendReportEmail(subject, html);
  console.log('Отчёт отправлен:', subject);
}

run().catch((err) => {
  console.error('Analytics Agent упал:', err);
  process.exit(1);
});
