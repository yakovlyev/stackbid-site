/**
 * StackBid — Автоматизация-Ревизор (Automation Coverage Auditor)
 *
 * Ідея з AI Mapper (07.09): "де людина все ще робить те, що можна
 * віддати агенту." Не намагається бути розумним аналізатором бізнес-
 * процесів (для цього немає даних) — натомість чесно збирає докупи те,
 * що вже прямим текстом позначено в коді як ручний процес (коментарі
 * "вручную"/"manual"/TODO), розкидане по десятку файлів, в один список,
 * який реально хтось прочитає раз на місяць, а не забуде.
 *
 * Запускається за розкладом (щомісяця, дивись render.yaml) — читає
 * файли з репозиторію напряму, жодної БД чи зовнішнього API не потрібно.
 *
 * Потрібні змінні оточення:
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNT_ID
 *   REPORT_TO_EMAIL
 */

const fs = require('node:fs');
const path = require('node:path');

const ZOHO_MAIL_API = 'https://mail.zoho.com/api';
const FROM_ADDRESS = 'hello@stackbid.app';

// Патерни, що позначають ручний процес чи незакінчену автоматизацію —
// саме такі коментарі вже реально є в коді (перевірено 08.09 грепом).
const MARKER_PATTERN = /(вручную|manually|TODO|not automat\w*|manual process)/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests']);
const EXTENSIONS = new Set(['.js', '.html']);

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function walkFiles(dir, repoRoot) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, repoRoot));
    } else if (EXTENSIONS.has(path.extname(entry.name)) && entry.name !== 'automation-audit-agent.js') {
      results.push(path.relative(repoRoot, full));
    }
  }
  return results;
}

function findMarkersInFile(repoRoot, relPath) {
  const content = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const lines = content.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (MARKER_PATTERN.test(line)) {
      hits.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 200) });
    }
  });
  return hits;
}

function scanRepo(repoRoot) {
  const files = walkFiles(repoRoot, repoRoot);
  const allHits = [];
  for (const f of files) {
    allHits.push(...findMarkersInFile(repoRoot, f));
  }
  return allHits;
}

function buildReportHtml(hits) {
  if (!hits.length) {
    return '<p>Автоматизация-Ревизор: маркеров ручных процессов не найдено.</p>';
  }
  const rows = hits
    .map((h) => `<tr><td>${escapeHtml(h.file)}:${h.line}</td><td><code>${escapeHtml(h.text)}</code></td></tr>`)
    .join('');
  return `<p>Автоматизация-Ревизор: ${hits.length} мест в коде, помеченных как ручной процесс или незаконченная автоматизация:</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;"><tr><th>Файл:строка</th><th>Текст</th></tr>${rows}</table>`;
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

async function run(repoRoot = __dirname) {
  console.log('Автоматизация-Ревизор — старт');
  const hits = scanRepo(repoRoot);
  await sendReportEmail(`🔍 Автоматизация-Ревизор: ${hits.length} мест с ручным процессом`, buildReportHtml(hits));
  console.log(`✓ Найдено ${hits.length} маркеров, отчёт отправлен.`);
}

module.exports = { escapeHtml, buildReportHtml, findMarkersInFile, walkFiles, scanRepo, MARKER_PATTERN };

if (require.main === module) {
  run().catch((err) => {
    console.error('Автоматизация-Ревизор впав:', err);
    process.exit(1);
  });
}
