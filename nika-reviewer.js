/**
 * StackBid — Ника-Ревизор (Nika Reviewer)
 *
 * Ідея з AI Mapper (07.09): контролює діалоги Nika (asssistant.js) на
 * шкідливі патерни — вигадані ціни поза наданим контекстом кошторису,
 * обіцянки гарантій точності ціни, місця де користувач пішов, не
 * отримавши кошторис. Читає лог з nika_conversations (додано в
 * assistant.js цієї ж сесії — раніше розмови взагалі не зберігались),
 * проганяє через Claude пачками, позначає перевірене, шле звіт на пошту
 * тим самим шляхом, що вже працює в analytics-agent.js (Zoho Mail).
 *
 * Запускається за розкладом (щодня, дивись render.yaml).
 *
 * Потрібні змінні оточення:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   ANTHROPIC_API_KEY
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ACCOUNT_ID
 *   REPORT_TO_EMAIL
 */

const ZOHO_MAIL_API = 'https://mail.zoho.com/api';
const FROM_ADDRESS = 'hello@stackbid.app';
const BATCH_SIZE = 25;

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function supabaseFetch(path, options = {}) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
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

// ---------- Zoho Mail (той самий патерн, що в analytics-agent.js) ----------

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

// ---------- Claude review ----------

const REVIEW_RULES = `You are auditing transcripts of "Nika", an AI assistant embedded in StackBid (a US construction-cost estimator). Nika's own rules are: never invent specific dollar prices beyond what's in the provided estimate context; never promise a price is guaranteed/exact; be honest that the labor-hours figure is StackBid's own estimate, not a federal number (only the wage rate is BLS); never read out every line item; only discuss the estimate/materials/pricing/how StackBid works.

For each conversation given, decide if Nika's response VIOLATED any of these rules. Be conservative — only flag a real, clear violation, not stylistic nitpicks. Output ONLY a JSON array, no markdown fences, one object per conversation that has at least one violation (skip clean ones entirely): [{"id": <id>, "violation": "one of: fabricated_price | guarantee_promise | mislabeled_labor_source | listed_every_item | off_topic", "quote": "<=200 char excerpt from the response showing the issue", "severity": "low|medium|high"}]`;

async function reviewBatch(conversations) {
  const payload = conversations.map((c) => ({ id: c.id, question: c.question, response: c.response }));
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
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic review call failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const cleaned = raw.replace(/^```json\s*|```$/g, '').trim();
  try {
    return JSON.parse(cleaned || '[]');
  } catch (e) {
    console.error('Nika-Ревізор: не вдалось розпарсити відповідь Claude:', cleaned.slice(0, 300));
    return [];
  }
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildReportHtml(flagged, totalReviewed) {
  if (!flagged.length) {
    return `<p>Ника-Ревизор проверил ${totalReviewed} новых диалогов Nika — нарушений не найдено.</p>`;
  }
  const rows = flagged
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.severity)}</td><td>${escapeHtml(f.violation)}</td><td>${escapeHtml(f.quote)}</td></tr>`,
    )
    .join('');
  return `<p>Ника-Ревизор проверил ${totalReviewed} новых диалогов, найдено ${flagged.length} с нарушением:</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;"><tr><th>Severity</th><th>Тип</th><th>Цитата</th></tr>${rows}</table>`;
}

async function run() {
  console.log('Ника-Ревизор — старт');
  const unreviewed = await supabaseFetch(
    'nika_conversations?reviewed_at=is.null&select=id,question,response&order=created_at.asc&limit=' + BATCH_SIZE,
  );
  if (!unreviewed || !unreviewed.length) {
    console.log('Нет новых диалогов для проверки.');
    return;
  }

  const flagged = await reviewBatch(unreviewed);

  for (const c of unreviewed) {
    const flag = flagged.find((f) => f.id === c.id) || null;
    await supabaseFetch(`nika_conversations?id=eq.${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ reviewed_at: new Date().toISOString(), review_flags: flag }),
    });
  }

  if (flagged.length) {
    await sendReportEmail(
      `⚠️ Nika: ${flagged.length} диалог(ов) с нарушением — Ника-Ревизор`,
      buildReportHtml(flagged, unreviewed.length),
    );
    console.log(`✓ Найдено ${flagged.length} нарушений, отчёт отправлен.`);
  } else {
    console.log(`✓ Проверено ${unreviewed.length} диалогов, всё чисто.`);
  }
}

module.exports = { escapeHtml, buildReportHtml, reviewBatch };

if (require.main === module) {
  run().catch((err) => {
    console.error('Ника-Ревизор впав:', err);
    process.exit(1);
  });
}
