// StackBid — WhatsApp Bot (v1)
//
// Точка входа: WhatsApp Business Cloud API (Meta) шлёт сюда вебхуки при
// новом входящем сообщении. Бот разбирает свободный текст (описание
// проекта + ZIP), генерирует смету той же логикой, что и сайт (промпт
// идентичен index.html), и отвечает форматированным текстом — WhatsApp не
// поддерживает HTML/таблицы, только текст с эмодзи и переносами строк.
//
// v1 сознательно ограничен текстовым вводом (фото — из следующей итерации,
// требует отдельного шага скачивания media по WhatsApp Media API).
//
// Требуемые переменные окружения (Render, сервис stackbid-app):
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (уже есть)
//   WHATSAPP_VERIFY_TOKEN   — придумать любую строку, ввести и сюда, и в Meta при настройке вебхука
//   WHATSAPP_ACCESS_TOKEN   — постоянный токен из Meta App (WhatsApp product)
//   WHATSAPP_PHONE_NUMBER_ID — ID номера в Meta Business, не сам номер телефона

const ESTIMATE_SYSTEM_PROMPT = `You are StackBid's construction materials estimator, replying inside a WhatsApp chat. A homeowner sent a free-text message describing their project and (hopefully) their ZIP code.

Extract:
- project_type (best guess from the free text)
- zip (5-digit US ZIP if present in the message, else null)
- Then generate a materials estimate.

Return ONLY this JSON, no other text:
{
  "zip_found": boolean,
  "project_type": string,
  "items": [ { "name": string, "qty": number, "unit": string, "retail_unit": number, "wholesale_unit": number, "local_unit": number } ],
  "total_retail": number,
  "total_wholesale": number,
  "total_local": number
}

Rules:
- If zip_found is false, still generate the estimate using national average pricing — do not block on missing ZIP, just don't claim local-specific pricing.
- retail_unit = current 2026 Home Depot/Lowe's shelf price. wholesale_unit = 20-28% below retail. local_unit = 5-10% below wholesale.
- 4-8 realistic line items covering the main materials for this project type.
- Use realistic current 2026 US construction market prices.`;

const PROJECT_LABOR_MAP = {
  'garage door': { trade: 'carpentry', hoursLow: 4, hoursHigh: 10 },
  'deck': { trade: 'carpentry', hoursLow: 40, hoursHigh: 80 },
  'fence': { trade: 'carpentry', hoursLow: 16, hoursHigh: 40 },
  'roof': { trade: 'roofing', hoursLow: 24, hoursHigh: 48 },
  'siding': { trade: 'carpentry', hoursLow: 40, hoursHigh: 80 },
  'foundation': { trade: 'masonry', hoursLow: 60, hoursHigh: 120 },
  'flooring': { trade: 'flooring', hoursLow: 16, hoursHigh: 40 },
  'drywall': { trade: 'drywall', hoursLow: 16, hoursHigh: 32 },
  'concrete': { trade: 'masonry', hoursLow: 24, hoursHigh: 48 },
};

function regionFromZip(zip) {
  const map = { '0':'northeast','1':'northeast','2':'south','3':'south','7':'south','4':'midwest','5':'midwest','6':'midwest','8':'west','9':'west' };
  return map[(zip || '')[0]] || 'national';
}

function guessLaborKey(projectType) {
  const t = (projectType || '').toLowerCase();
  return Object.keys(PROJECT_LABOR_MAP).find((k) => t.includes(k)) || null;
}

async function getLaborEstimate(projectType, zip, materialsTotal) {
  const key = guessLaborKey(projectType);
  if (!key) return null;
  const mapping = PROJECT_LABOR_MAP[key];
  const region = regionFromZip(zip);
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/labor_rates?trade=eq.${mapping.trade}&region=eq.${region}&select=hourly_rate_low,hourly_rate_high`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const rate = rows && rows[0];
    if (!rate) return null;
    const laborLow = Math.round(rate.hourly_rate_low * mapping.hoursLow);
    const laborHigh = Math.round(rate.hourly_rate_high * mapping.hoursHigh);
    return { laborLow, laborHigh, totalLow: Math.round(materialsTotal + laborLow), totalHigh: Math.round(materialsTotal + laborHigh) };
  } catch (e) {
    return null;
  }
}

function formatWhatsAppReply(data, labor) {
  const lines = [];
  lines.push(`🏗️ *StackBid Estimate* — ${data.project_type}`);
  if (!data.zip_found) lines.push(`_(national average pricing — reply with your ZIP code for local pricing)_`);
  lines.push('');
  data.items.slice(0, 8).forEach((item) => {
    lines.push(`• ${item.name} (${item.qty} ${item.unit}) — $${item.local_unit.toFixed(2)}/unit local`);
  });
  lines.push('');
  lines.push(`💰 *Materials Total*`);
  lines.push(`Retail: $${Math.round(data.total_retail).toLocaleString()}`);
  lines.push(`Wholesale: $${Math.round(data.total_wholesale).toLocaleString()}`);
  lines.push(`Local supplier: $${Math.round(data.total_local).toLocaleString()}`);
  lines.push(`You'd overpay $${Math.round(data.total_retail - data.total_local).toLocaleString()} at retail.`);
  if (labor) {
    lines.push('');
    lines.push(`🔨 *Estimated Labor:* $${labor.laborLow.toLocaleString()}–$${labor.laborHigh.toLocaleString()}`);
    lines.push(`📊 *Estimated Total Project:* $${labor.totalLow.toLocaleString()}–$${labor.totalHigh.toLocaleString()}`);
  }
  lines.push('');
  lines.push(`Full breakdown + PDF: https://stackbid.app`);
  lines.push(`_Prices are AI estimates, typical market variance ±5-10%. Confirm with your supplier._`);
  return lines.join('\n');
}

async function sendWhatsAppMessage(to, text) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
}

exports.handler = async (event) => {
  // Верификация вебхука при подключении в Meta (одноразово, при настройке)
  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) {
      return { statusCode: 200, body: q['hub.challenge'] };
    }
    return { statusCode: 403, body: 'Verification failed' };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (!message) return { statusCode: 200, body: 'ok' }; // статусы доставки и т.п. — игнорируем

    const from = message.from;
    const text = message.text?.body;

    if (!text) {
      await sendWhatsAppMessage(from, "👋 I'm the StackBid bot! Text me what you're building (e.g. \"20x24 deck, ZIP 77001\") and I'll send you a materials + labor cost estimate. Photo support coming soon — for now, please describe it in text.");
      return { statusCode: 200, body: 'ok' };
    }

    if (/^(hi|hello|hey|start)$/i.test(text.trim())) {
      await sendWhatsAppMessage(from, "👋 Hi! I'm the StackBid bot. Tell me what you're building and your ZIP code — e.g. \"garage door replacement, ZIP 90210\" — and I'll send a materials + labor cost estimate in under a minute.");
      return { statusCode: 200, body: 'ok' };
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: ESTIMATE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      }),
    });
    const claudeData = await claudeRes.json();
    const textBlock = (claudeData.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      await sendWhatsAppMessage(from, "Sorry, I couldn't process that — try describing your project again, e.g. \"200 sq ft deck, ZIP 77001\".");
      return { statusCode: 200, body: 'ok' };
    }
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    const data = JSON.parse(match[0]);

    const zipMatch = text.match(/\b\d{5}\b/);
    const zip = zipMatch ? zipMatch[0] : null;
    const labor = await getLaborEstimate(data.project_type, zip, data.total_local);

    const reply = formatWhatsAppReply(data, labor);
    await sendWhatsAppMessage(from, reply);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[whatsapp-webhook] error:', err.message);
    return { statusCode: 200, body: 'ok' }; // всегда 200, иначе Meta будет повторять доставку бесконечно
  }
};
