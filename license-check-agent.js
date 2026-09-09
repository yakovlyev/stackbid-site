/**
 * StackBid — Лицензия-Чек (License Verification Digest)
 *
 * Ідея з AI Mapper (07.09). Чесна версія, не вигадана: жоден штат США не
 * має безкоштовного офіційного API для перевірки ліцензій підрядників —
 * тільки платні сторонні скрейпери чужих урядових сайтів (перевірено
 * пошуком 08.09). Будувати власний скрейпер офіційного сайту штату — це
 * саме той ToS-ризик, який Спрямоватор Джерела-Комплаенс з цієї ж карти
 * агентів явно застерігає уникати.
 *
 * Тому цей агент НЕ автоматизує саму перевірку — він перетворює те, що
 * зараз є мовчазним `license_verified: false` (див. contractor-signup.js,
 * коментар "верификация — отдельный ручной/будущий процесс", який
 * ніколи насправді не запускався) на конкретний щотижневий список з
 * готовим посиланням на офіційний безкоштовний реєстр потрібного штату —
 * команді залишається один клік по кожному, а не пошук з нуля.
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

// Офіційні БЕЗКОШТОВНІ публічні реєстри перевірки ліцензій підрядників по
// штату. Навмисно неповний список — тільки штати, де є прямий публічний
// пошук без штучного посередника; для решти — універсальне посилання на
// пошук "[штат] contractor license lookup", команда шукає сама.
const STATE_LICENSE_LOOKUP = {
  CA: 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx',
  TX: 'https://www.tdlr.texas.gov/LicenseSearch/',
  FL: 'https://www.myfloridalicense.com/wl11.asp?mode=0&SID=',
  NY: 'https://appext20.dos.ny.gov/lcns_public/licensee_search',
  AZ: 'https://roc.az.gov/contractor-search',
  NV: 'https://app.nvcontractorsboard.com/Clients/NVSCB/Public/PublicRegistrySearch.aspx',
  WA: 'https://secure.lni.wa.gov/verify/',
  OR: 'https://ccb.oregon.gov/pages/consumers.aspx',
  NC: 'https://www.nclbgc.org/verify-a-license/',
  GA: 'https://verify.sos.ga.gov/verification/',
};

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

function lookupUrlFor(state) {
  const code = String(state || '')
    .trim()
    .toUpperCase();
  return (
    STATE_LICENSE_LOOKUP[code] ||
    `https://www.google.com/search?q=${encodeURIComponent(code + ' contractor license lookup official')}`
  );
}

function buildDigestHtml(contractors) {
  if (!contractors.length) {
    return '<p>Лицензия-Чек: непроверенных подрядчиков с номером лицензии нет.</p>';
  }
  const rows = contractors
    .map((c) => {
      const url = lookupUrlFor(c.state);
      return `<tr><td>${escapeHtml(c.company_name)}</td><td>${escapeHtml(c.state)}</td><td>${escapeHtml(c.license_number)}</td><td><a href="${url}">Проверить</a></td></tr>`;
    })
    .join('');
  return `<p>Лицензия-Чек: ${contractors.length} подрядчик(ов) с непроверенной лицензией — по клику на "Проверить" открывается официальный бесплатный реестр нужного штата (для штатов без прямого реестра — гугл-поиск на официальный сайт):</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;"><tr><th>Компания</th><th>Штат</th><th>№ лицензии</th><th></th></tr>${rows}</table>
    <p style="color:#667;font-size:13px;">После ручной проверки отметь <code>license_verified = true</code> в Supabase (таблица contractors) — это не делается автоматически, ни один штат не даёт бесплатного API для этого.</p>`;
}

async function run() {
  console.log('Лицензия-Чек — старт');
  const unverified = await supabaseFetch(
    'contractors?license_verified=eq.false&license_number=not.is.null&select=company_name,state,license_number&order=created_at.asc',
  );
  if (!unverified || !unverified.length) {
    console.log('Непроверенных лицензий нет.');
    return;
  }
  await sendReportEmail(`📋 Лицензия-Чек: ${unverified.length} непроверенных лицензий`, buildDigestHtml(unverified));
  console.log(`✓ Отчёт с ${unverified.length} подрядчиками отправлен.`);
}

module.exports = { escapeHtml, lookupUrlFor, buildDigestHtml, STATE_LICENSE_LOOKUP };

if (require.main === module) {
  run().catch((err) => {
    console.error('Лицензия-Чек впав:', err);
    process.exit(1);
  });
}
