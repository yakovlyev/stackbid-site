// StackBid — WhatsApp Bot (v2 — фото + память диалога, 27.07)
//
// Точка входа: WhatsApp Business Cloud API (Meta) шлёт сюда вебхуки при
// новом входящем сообщении. Бот понимает и текст, и фото проекта, помнит
// историю переписки по номеру телефона (иначе теряет смысл как ассистент —
// прямое требование Игоря), генерирует смету и отвечает форматированным
// текстом (WhatsApp не поддерживает HTML/таблицы).
//
// v2 добавляет к v1:
//   - Фото: скачивание через WhatsApp Media API → анализ тем же vision-подходом,
//     что и на сайте (index.html analyzePhoto), адаптированным под полную
//     смету проекта, а не один материал
//   - Память: whatsapp_sessions (Supabase) — компактная история по номеру,
//     передаётся в Claude как context на каждое сообщение, так что "а если
//     из другого материала?" работает как продолжение разговора
//
// Двуязычный (EN/ES) с 27.07: модель определяет язык, formatWhatsAppReply
// рендерит подписи на нужном языке; приветствия захардкожены на обоих.
//
// Требуемые переменные окружения (Render, сервис stackbid-app):
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (уже есть)
//   WHATSAPP_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
//
// Требуемая таблица: whatsapp_sessions (см. whatsapp-sessions-schema.sql)

const MAX_HISTORY_TURNS = 6; // 6 пар user/assistant — достаточно для контекста, не раздувает промпт

const ESTIMATE_SYSTEM_PROMPT = `You are StackBid's construction cost estimator, replying inside an ongoing WhatsApp conversation with a homeowner. Messages may be in English or Spanish, and may reference earlier turns in this same conversation (e.g. "what if I used composite instead?", "what about a bigger size?") — use the conversation history to understand follow-ups and adjust the PREVIOUS estimate rather than starting from scratch when the user is clearly following up.

The user's message may include a photo of their project (already analyzed and described to you as text) and/or a text description and/or a ZIP code.

Extract:
- language: "es" if the current message is in Spanish, otherwise "en" (default to the conversation's established language if the current message is just a short follow-up like a number or "yes")
- project_type
- zip (5-digit US ZIP if present anywhere in this message or recent history, else null)
- Then generate (or update) a materials estimate.

Return ONLY this JSON, no other text:
{
  "language": "en" | "es",
  "zip_found": boolean,
  "project_type": string,
  "items": [ { "name": string, "qty": number, "unit": string, "retail_unit": number, "wholesale_unit": number, "local_unit": number } ],
  "total_retail": number,
  "total_wholesale": number,
  "total_local": number
}

Rules:
- If zip_found is false, still generate the estimate using national average pricing.
- retail_unit = current 2026 Home Depot/Lowe's shelf price. wholesale_unit = 20-28% below retail. local_unit = 5-10% below wholesale.
- 4-8 realistic line items. Item "name" in the same language as the current message.
- Use realistic current 2026 US construction market prices.
- Never fabricate that you remember something not actually present in the provided history — if a follow-up is ambiguous, make the most reasonable assumption and proceed (don't ask a clarifying question, WhatsApp users expect a direct answer).`;

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
  const es = data.language === 'es';
  const lines = [];
  lines.push(`🏗️ *StackBid ${es ? 'Estimado' : 'Estimate'}* — ${data.project_type}`);
  if (!data.zip_found) {
    lines.push(es
      ? `_(precio promedio nacional — responde con tu código postal para precios locales)_`
      : `_(national average pricing — reply with your ZIP code for local pricing)_`);
  }
  lines.push('');
  data.items.slice(0, 8).forEach((item) => {
    lines.push(`• ${item.name} (${item.qty} ${item.unit}) — $${item.local_unit.toFixed(2)}/unit local`);
  });
  lines.push('');
  lines.push(es ? `💰 *Total de Materiales*` : `💰 *Materials Total*`);
  lines.push(`${es ? 'Minorista' : 'Retail'}: $${Math.round(data.total_retail).toLocaleString()}`);
  lines.push(`${es ? 'Mayorista' : 'Wholesale'}: $${Math.round(data.total_wholesale).toLocaleString()}`);
  lines.push(`${es ? 'Proveedor local' : 'Local supplier'}: $${Math.round(data.total_local).toLocaleString()}`);
  lines.push(es
    ? `Pagarías $${Math.round(data.total_retail - data.total_local).toLocaleString()} de más al precio minorista.`
    : `You'd overpay $${Math.round(data.total_retail - data.total_local).toLocaleString()} at retail.`);
  if (labor) {
    lines.push('');
    lines.push(`🔨 *${es ? 'Mano de Obra Estimada' : 'Estimated Labor'}:* $${labor.laborLow.toLocaleString()}–$${labor.laborHigh.toLocaleString()}`);
    lines.push(`📊 *${es ? 'Costo Total Estimado del Proyecto' : 'Estimated Total Project'}:* $${labor.totalLow.toLocaleString()}–$${labor.totalHigh.toLocaleString()}`);
  }
  lines.push('');
  lines.push(es ? `Desglose completo + PDF: https://stackbid.app` : `Full breakdown + PDF: https://stackbid.app`);
  lines.push(es
    ? `_Los precios son estimados por IA, variación típica del mercado ±5-10%. Confirma con tu proveedor._`
    : `_Prices are AI estimates, typical market variance ±5-10%. Confirm with your supplier._`);
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

// ---------- Фото: скачивание через WhatsApp Media API ----------

async function downloadWhatsAppMedia(mediaId) {
  const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
  });
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('No media URL returned by Meta');

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  const arrayBuffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return { base64, mimeType: meta.mime_type || 'image/jpeg' };
}

// Отдельный, более простой vision-вызов — просто описывает, что на фото,
// текстом. Это описание потом идёт в общую историю разговора (не храним
// base64 в whatsapp_sessions — слишком тяжело и не нужно повторно).
async function describePhoto(base64, mimeType) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: 'Describe this photo in one or two sentences for a construction cost estimator — what room/area/material/condition is shown, in English. If it is not construction/home-related, say so plainly.' },
        ],
      }],
    }),
  });
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  return block ? block.text.trim() : 'A photo was sent but could not be described.';
}

// ---------- Память диалога (Supabase) ----------

async function loadSession(phone) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?phone=eq.${phone}&select=history,language`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await r.json();
    if (rows && rows[0]) return { history: rows[0].history || [], language: rows[0].language || 'en' };
  } catch (e) {
    console.error('[whatsapp] loadSession failed:', e.message);
  }
  return { history: [], language: 'en' };
}

async function saveSession(phone, history, language) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const trimmed = history.slice(-MAX_HISTORY_TURNS * 2);
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?on_conflict=phone`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ phone, history: trimmed, language, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.error('[whatsapp] saveSession failed:', e.message);
  }
}

// ---------- Main ----------

exports.handler = async (event) => {
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
    if (!message) return { statusCode: 200, body: 'ok' };

    const from = message.from;
    let userText = null;

    if (message.type === 'text') {
      userText = message.text?.body || null;
    } else if (message.type === 'image') {
      try {
        const { base64, mimeType } = await downloadWhatsAppMedia(message.image.id);
        const photoDescription = await describePhoto(base64, mimeType);
        const caption = message.image.caption || '';
        userText = `[Photo sent: ${photoDescription}]${caption ? ` Caption: ${caption}` : ''}`;
      } catch (e) {
        console.error('[whatsapp] photo processing failed:', e.message);
        await sendWhatsAppMessage(from, "Sorry, I couldn't process that photo — try again, or describe your project in text.\n\nLo siento, no pude procesar esa foto — intenta de nuevo, o describe tu proyecto en texto.");
        return { statusCode: 200, body: 'ok' };
      }
    }

    const session = await loadSession(from);

    if (!userText) {
      const greeting = "👋 I'm the StackBid bot / Soy el bot de StackBid! Text me what you're building, or send a photo of the project (e.g. \"20x24 deck, ZIP 77001\") — Escríbeme qué construyes, o envía una foto del proyecto — and I'll send you a materials + labor cost estimate.";
      await sendWhatsAppMessage(from, greeting);
      return { statusCode: 200, body: 'ok' };
    }

    if (session.history.length === 0 && /^(hi|hello|hey|start|hola|buenas|empezar)$/i.test(userText.trim())) {
      await sendWhatsAppMessage(from, "👋 Hi! I'm the StackBid bot. Tell me what you're building (text or photo) and your ZIP code — e.g. \"garage door replacement, ZIP 90210\" — and I'll send a materials + labor cost estimate in under a minute. I'll remember our conversation, so feel free to ask follow-ups like \"what if I used a different material?\"\n\n¡Hola! Soy el bot de StackBid. Dime qué proyecto tienes (texto o foto) y tu código postal — y te enviaré un estimado en menos de un minuto. Recuerdo nuestra conversación, así que puedes hacer preguntas de seguimiento.");
      return { statusCode: 200, body: 'ok' };
    }

    const claudeMessages = [
      ...session.history.map((h) => ({ role: h.role, content: h.content })),
      { role: 'user', content: userText },
    ];

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: ESTIMATE_SYSTEM_PROMPT,
        messages: claudeMessages,
      }),
    });
    const claudeData = await claudeRes.json();
    const textBlock = (claudeData.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      await sendWhatsAppMessage(from, "Sorry, I couldn't process that — try describing your project again, e.g. \"200 sq ft deck, ZIP 77001\".\n\nLo siento, no pude procesar eso — intenta describir tu proyecto de nuevo.");
      return { statusCode: 200, body: 'ok' };
    }
    const match = textBlock.text.match(/\{[\s\S]*\}/);
    if (!match) {
      await sendWhatsAppMessage(from, "Sorry, something went wrong generating your estimate — please try again.\n\nLo siento, algo salió mal generando tu estimado — intenta de nuevo.");
      return { statusCode: 200, body: 'ok' };
    }
    const data = JSON.parse(match[0]);

    const zipMatch = userText.match(/\b\d{5}\b/);
    const zip = zipMatch ? zipMatch[0] : null;
    const labor = await getLaborEstimate(data.project_type, zip, data.total_local);

    const reply = formatWhatsAppReply(data, labor);
    await sendWhatsAppMessage(from, reply);

    const newHistory = [
      ...session.history,
      { role: 'user', content: userText },
      { role: 'assistant', content: `[Estimate given: ${data.project_type}, total local $${Math.round(data.total_local)}]` },
    ];
    await saveSession(from, newHistory, data.language);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[whatsapp-webhook] error:', err.message);
    return { statusCode: 200, body: 'ok' };
  }
};
