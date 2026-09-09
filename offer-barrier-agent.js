/**
 * StackBid — Оферта-Барьер (Offer-Boundary Checker)
 *
 * Ідея з AI Mapper (07.09). StackBid вже має непогані дисклеймери
 * (terms.html: "for informational purposes only", "approximations",
 * "not liable for damages"). Цей агент — не одноразовий пошук багу, а
 * ПОСТІЙНИЙ страж: перевіряє, чи не проповзла десь пізніше формула, яка
 * перетворює оцінку на юридично зобов'язуючу пропозицію або гарантію
 * точної ціни — в текстах сайту І в системному промпті Nika (обидва
 * можуть змінюватись окремо один від одного).
 *
 * Запускається за розкладом (щотижня, дивись render.yaml) — читає
 * поточні файли з репозиторію напряму, жодної БД не потрібно.
 *
 * Потрібні змінні оточення:
 *   ANTHROPIC_API_KEY
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNT_ID
 *   REPORT_TO_EMAIL
 */

const fs = require('node:fs');
const path = require('node:path');

const ZOHO_MAIL_API = 'https://mail.zoho.com/api';
const FROM_ADDRESS = 'hello@stackbid.app';

// Файли, які реально бачить користувач і які МОЖУТЬ містити обіцянки
// точної ціни чи гарантій — саме ті місця, де юридичний ризик матеріалізується.
const FILES_TO_CHECK = ['terms.html', 'index.html', 'es.html', 'netlify/functions/assistant.js'];

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function readTextSafely(repoRoot, relPath) {
  try {
    return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  } catch (e) {
    return null;
  }
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

const REVIEW_RULES = `You are a legal-risk reviewer for StackBid (a US construction-cost estimator, NOT a licensed appraiser or contractor). StackBid's estimates are explicitly informational/approximate, never a binding offer or guaranteed price — this is already established in terms.html.

You will be given the raw source of a file (HTML or JS). Find any USER-FACING TEXT (ignore code identifiers, CSS, comments) that could reasonably be read as: a guarantee of exact/final price, a legally binding offer, a promise/warranty about outcome, or anything contradicting "informational only, not a quote from a specific contractor."

Output ONLY a JSON array, no markdown fences. One object per issue found (empty array if none): [{"quote": "<=200 char excerpt", "risk": "one sentence describing the legal risk", "suggested_fix": "a safer rewording of that exact phrase"}]. Be conservative — normal marketing language like "get your estimate" or "save money" is NOT a violation. Only flag things a reasonable person could read as a guarantee or binding commitment.`;

async function reviewFile(filename, content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: REVIEW_RULES,
      messages: [{ role: 'user', content: `File: ${filename}\n\n${content.slice(0, 60000)}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic review call failed for ${filename}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
  try {
    return JSON.parse(cleaned || '[]');
  } catch {
    console.error(`Оферта-Барьер: не вдалось розпарсити відповідь для ${filename}:`, cleaned.slice(0, 300));
    return [];
  }
}

function buildReportHtml(findingsByFile) {
  const files = Object.keys(findingsByFile).filter((f) => findingsByFile[f].length);
  if (!files.length) {
    return '<p>Оферта-Барьер: рискованных формулировок не найдено, всё чисто.</p>';
  }
  const sections = files
    .map((f) => {
      const rows = findingsByFile[f]
        .map(
          (item) =>
            `<tr><td>${escapeHtml(item.quote)}</td><td>${escapeHtml(item.risk)}</td><td>${escapeHtml(item.suggested_fix)}</td></tr>`,
        )
        .join('');
      return `<h4>${escapeHtml(f)}</h4><table border="1" cellpadding="6" style="border-collapse:collapse;"><tr><th>Цитата</th><th>Риск</th><th>Предложенная правка</th></tr>${rows}</table>`;
    })
    .join('');
  return `<p>Оферта-Барьер нашёл потенциально рискованные формулировки:</p>${sections}`;
}

async function run(repoRoot = __dirname) {
  console.log('Оферта-Барьер — старт');
  const findingsByFile = {};
  for (const relPath of FILES_TO_CHECK) {
    const content = readTextSafely(repoRoot, relPath);
    if (!content) {
      console.log(`Пропущено (не найден): ${relPath}`);
      continue;
    }
    findingsByFile[relPath] = await reviewFile(relPath, content);
  }

  const totalFindings = Object.values(findingsByFile).reduce((sum, arr) => sum + arr.length, 0);
  if (totalFindings) {
    await sendReportEmail(
      `⚠️ Оферта-Барьер: ${totalFindings} рискованных формулировок`,
      buildReportHtml(findingsByFile),
    );
    console.log(`✓ Найдено ${totalFindings} формулировок, отчёт отправлен.`);
  } else {
    console.log('✓ Всё чисто, ничего не отправлено.');
  }
}

module.exports = { escapeHtml, buildReportHtml, reviewFile, readTextSafely };

if (require.main === module) {
  run().catch((err) => {
    console.error('Оферта-Барьер впав:', err);
    process.exit(1);
  });
}
