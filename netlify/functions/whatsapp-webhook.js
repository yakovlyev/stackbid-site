// StackBid — WhatsApp Bot (v4 — голос + консультант + фото + память, 31.07)
//
// Точка входа: WhatsApp Business Cloud API (Meta) шлёт сюда вебхуки при
// новом входящем сообщении. Бот понимает текст, фото и ГОЛОСОВЫЕ сообщения,
// помнит историю переписки по номеру телефона, генерирует смету или
// отвечает на общий вопрос, и отвечает форматированным текстом — а если
// вопрос пришёл голосом, ещё и озвученным ответом.
//
// v4 (31.07) — Игорь: мексиканская испаноговорящая аудитория предпочитает
// голосовые сообщения набору текста, особенно на естественной скорости речи
// ("тараторят"). Добавлено: приём голосовых (Whisper — распознавание речи)
// и озвученный ответ (TTS), поверх существующего текстового ответа.
//
// v3 (31.07) — Игорь: испаноязычная аудитория не будет переключаться на
// другой канал ради общих вопросов про стройку, они хотят получить всё в
// одном месте (WhatsApp, на родном языке). Раньше бот умел ТОЛЬКО считать
// смету — любой вопрос вне этого сценария он пытался силой превратить в
// смету. Теперь бот сам решает: если пришло описание проекта — считает
// смету (как раньше); если пришёл общий вопрос про стройку (разрешения,
// как выбрать подрядчика, что означает термин, и т.д.) — отвечает как
// консультант, тем же прожективным анти-галлюцинационным ограничением, что
// у Ники на сайте (не выдумывать цифры/факты, признавать неуверенность).
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
//   OPENAI_API_KEY — НОВАЯ, для распознавания (Whisper) и синтеза речи (TTS)
//
// Требуемая таблица: whatsapp_sessions (см. whatsapp-sessions-schema.sql)

const MAX_HISTORY_TURNS = 6; // 6 пар user/assistant — достаточно для контекста, не раздувает промпт

const ESTIMATE_SYSTEM_PROMPT = `You are StackBid's WhatsApp assistant, replying inside an ongoing conversation with a homeowner. Messages may be in English or Spanish, and may reference earlier turns (e.g. "what if I used composite instead?") — use the conversation history to understand follow-ups.

The user's message may include a photo of their project (already analyzed and described to you as text) and/or a text description and/or a ZIP code and/or a general question about construction/renovation.

You handle TWO kinds of messages — decide which this one is:

1. PROJECT ESTIMATE — the user describes or shows a specific project they want priced (has a project type, ideally size/scope). Generate a materials + cost estimate.

2. GENERAL QUESTION — anything else construction/renovation-related: permits, how to choose a contractor, what a material or process is, typical timelines, whether they need a professional vs DIY, how StackBid itself works, etc. Answer directly and conversationally, 2-5 sentences, WhatsApp-length (not a wall of text). Same grounding rules as StackBid's on-site assistant Nika: never invent specific prices, codes, regulations, or facts you're not confident about — if unsure, say so plainly and suggest checking with a local professional or authority rather than guessing. Never claim StackBid does something it doesn't (e.g. it does not pull permits, does not guarantee contractor quality beyond what's on their profile).

Extract:
- type: "estimate" or "answer"
- language: "es" if the current message is in Spanish, otherwise "en" (default to the conversation's established language for short follow-ups)
- If type is "estimate": zip (5-digit US ZIP if present anywhere in this message or recent history, else null), project_type, then generate the estimate.
- If type is "answer": just the answer text, in the same language as the current message.

Return ONLY this JSON, no other text:
{
  "type": "estimate" | "answer",
  "language": "en" | "es",
  "text": string,               // ONLY for type "answer" — the conversational reply
  "zip_found": boolean,         // ONLY for type "estimate"
  "project_type": string,       // ONLY for type "estimate"
  "items": [ { "name": string, "qty": number, "unit": string, "retail_unit": number, "wholesale_unit": number, "local_unit": number } ],  // ONLY for type "estimate"
  "total_retail": number,       // ONLY for type "estimate"
  "total_wholesale": number,    // ONLY for type "estimate"
  "total_local": number         // ONLY for type "estimate"
}

Rules for estimates:
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

// ---------- Голос (v4, 31.07): приём и озвученный ответ ----------
// Игорь: мексиканская испаноговорящая аудитория предпочитает голосовые
// сообщения набору текста, особенно на скорости естественной речи — бот
// должен и понимать голосовые, и отвечать голосом, не только текстом.
// Это требует отдельного сервиса распознавания/синтеза речи — у Anthropic
// Claude API нет приёма/генерации аудио напрямую. Используем OpenAI
// (Whisper для распознавания, TTS для синтеза) — один провайдер, один ключ.
//
// НОВАЯ переменная окружения: OPENAI_API_KEY

async function transcribeAudio(base64, mimeType) {
  const buffer = Buffer.from(base64, 'base64');
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), `voice.${ext}`);
  form.append('model', 'whisper-1');
  // Без параметра language — Whisper сам определяет язык (EN/ES), это надёжнее,
  // чем угадывать заранее по номеру телефона или истории разговора.

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper transcription failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.text || '').trim();
}

async function synthesizeSpeech(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'nova', // нейтральный, дружелюбный голос; OpenAI TTS сам произносит текст на языке самого текста
      input: text,
      response_format: 'opus', // WhatsApp voice notes ожидают audio/ogg (opus)
    }),
  });
  if (!res.ok) throw new Error(`TTS synthesis failed: ${res.status} ${await res.text()}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadWhatsAppMedia(buffer, mimeType) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), 'reply.ogg');

  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`WhatsApp media upload failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id;
}

async function sendWhatsAppVoiceReply(to, text) {
  try {
    const audioBuffer = await synthesizeSpeech(text);
    const mediaId = await uploadWhatsAppMedia(audioBuffer, 'audio/ogg');
    const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
    await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId } }),
    });
  } catch (e) {
    console.error('[whatsapp] voice reply failed, falling back to text-only:', e.message);
    // не роняем весь ответ, если синтез/отправка голоса не удалась — текстовый
    // ответ уже отправлен отдельно до этого вызова
  }
}

// Короткая, пригодная для озвучки версия ответа — полная текстовая смета с
// построчной разбивкой хорошо читается, но плохо звучит вслух. Для голоса
// собираем компактную сводку из тех же чисел, без построения нового запроса
// к модели (дешевле и быстрее).
function buildSpokenSummary(data, labor) {
  const es = data.language === 'es';
  if (data.type === 'answer') return data.text;
  if (es) {
    let s = `Tu estimado para ${data.project_type}: materiales alrededor de $${Math.round(data.total_local).toLocaleString()}.`;
    if (labor) s += ` Mano de obra entre $${labor.laborLow.toLocaleString()} y $${labor.laborHigh.toLocaleString()}. Total estimado entre $${labor.totalLow.toLocaleString()} y $${labor.totalHigh.toLocaleString()}.`;
    s += ' Te mandé el desglose completo por escrito arriba.';
    return s;
  }
  let s = `Your ${data.project_type} estimate: materials around $${Math.round(data.total_local).toLocaleString()}.`;
  if (labor) s += ` Labor between $${labor.laborLow.toLocaleString()} and $${labor.laborHigh.toLocaleString()}. Estimated total between $${labor.totalLow.toLocaleString()} and $${labor.totalHigh.toLocaleString()}.`;
  s += ' I sent the full written breakdown above.';
  return s;
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
    const res = await fetch(`${SUPABASE_URL}/rest/v1/whatsapp_sessions?on_conflict=phone`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ phone, history: trimmed, language, updated_at: new Date().toISOString() }),
    });
    // 01.08: раньше ошибка тут проглатывалась молча — fetch() не бросает
    // исключение на HTTP-ошибки (400/500), только на сетевой сбой. Из-за
    // этого отсутствие уникального ограничения на phone в базе (теперь
    // исправлено отдельно) роняло каждое сохранение без единого следа в
    // логах — бот "забывал" разговор на каждом сообщении.
    if (!res.ok) {
      console.error('[whatsapp] saveSession got non-OK response:', res.status, await res.text());
    }
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
    let isVoiceInput = false;

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
    } else if (message.type === 'audio') {
      // Пока OPENAI_API_KEY не настроен на сервере — честно говорим об
      // этом сразу, а не пытаемся вызвать Whisper и падаем с невнятной
      // ошибкой "попробуйте ещё раз" (которая всё равно не поможет,
      // повтор без ключа снова не сработает).
      if (!process.env.OPENAI_API_KEY) {
        await sendWhatsAppMessage(from, "Voice messages aren't set up yet on my end — could you type your question instead? I can still help with photos and text right away.\n\nLos mensajes de voz aún no están disponibles de mi lado — ¿puedes escribir tu pregunta? Puedo ayudarte con fotos y texto de inmediato.");
        return { statusCode: 200, body: 'ok' };
      }
      try {
        const { base64, mimeType } = await downloadWhatsAppMedia(message.audio.id);
        userText = await transcribeAudio(base64, mimeType);
        isVoiceInput = true;
        if (!userText) {
          await sendWhatsAppMessage(from, "Sorry, I couldn't make out that voice message — could you try again or type it?\n\nLo siento, no pude entender ese mensaje de voz — ¿puedes intentar de nuevo o escribirlo?");
          return { statusCode: 200, body: 'ok' };
        }
      } catch (e) {
        console.error('[whatsapp] voice processing failed:', e.message);
        await sendWhatsAppMessage(from, "Sorry, I couldn't process that voice message — try again, or send text instead.\n\nLo siento, no pude procesar ese mensaje de voz — intenta de nuevo, o envía texto.");
        return { statusCode: 200, body: 'ok' };
      }
    }

    const session = await loadSession(from);

    if (!userText) {
      const greeting = "👋 Hi! I'm the StackBid AI assistant. I'll help you know your real materials & labor cost before you talk to a contractor. Text me what you're building, send a photo, or send a voice message — e.g. \"20x24 deck, ZIP 77001\".\n\n¡Hola! Soy el asistente de IA de StackBid. Te ayudaré a conocer el costo real de materiales y mano de obra antes de hablar con un contratista. Escríbeme qué construyes, envía una foto, o mándame un audio.";
      await sendWhatsAppMessage(from, greeting);
      return { statusCode: 200, body: 'ok' };
    }

    if (session.history.length === 0) {
      await sendWhatsAppMessage(from, "👋 Hi! I'm the StackBid AI assistant. I'll help you know your real materials & labor cost before you talk to a contractor. Tell me what you're building (text, photo, or voice) and your ZIP code — e.g. \"garage door replacement, ZIP 90210\" — and I'll send an estimate in under a minute. You can also ask me general questions about construction, permits, or hiring a contractor. I'll remember our conversation, so feel free to ask follow-ups like \"what if I used a different material?\"\n\n¡Hola! Soy el asistente de IA de StackBid. Te ayudaré a conocer el costo real de materiales y mano de obra antes de hablar con un contratista. Dime qué proyecto tienes (texto, foto o audio) y tu código postal — y te enviaré un estimado en menos de un minuto. También puedes hacerme preguntas generales sobre construcción, permisos o cómo elegir un contratista. Recuerdo nuestra conversación, así que puedes hacer preguntas de seguimiento.");
      const newHistory = [{ role: 'user', content: userText }, { role: 'assistant', content: '[Sent standard greeting]' }];
      await saveSession(from, newHistory, 'en');
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

    // v3: бот теперь отвечает и на общие вопросы, не только считает сметы —
    // ветвимся по полю type, которое возвращает модель
    let reply;
    let historyNote;

    let labor = null;
    if (data.type === 'answer') {
      reply = data.text || (data.language === 'es'
        ? 'Lo siento, no pude procesar eso — intenta de nuevo.'
        : "Sorry, I couldn't process that — try again.");
      historyNote = `[Answered a general question]`;
    } else {
      const zipMatch = userText.match(/\b\d{5}\b/);
      const zip = zipMatch ? zipMatch[0] : null;
      labor = await getLaborEstimate(data.project_type, zip, data.total_local);
      reply = formatWhatsAppReply(data, labor);
      historyNote = `[Estimate given: ${data.project_type}, total local $${Math.round(data.total_local)}]`;
    }

    await sendWhatsAppMessage(from, reply);

    // Если вопрос пришёл голосом — отвечаем и голосом тоже, коротким устным
    // резюме (полная построчная смета плохо звучит вслух), сверх текста,
    // который уже отправлен выше как письменный документ на память.
    if (isVoiceInput) {
      const spoken = buildSpokenSummary(data, labor);
      await sendWhatsAppVoiceReply(from, spoken);
    }

    const newHistory = [
      ...session.history,
      { role: 'user', content: userText },
      { role: 'assistant', content: historyNote },
    ];
    await saveSession(from, newHistory, data.language);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[whatsapp-webhook] error:', err.message);
    return { statusCode: 200, body: 'ok' };
  }
};
