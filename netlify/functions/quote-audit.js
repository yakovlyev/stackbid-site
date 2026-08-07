// Аудит сметы подрядчика — пользователь загружает PDF полученного предложения,
// Claude читает его напрямую как документ (Anthropic API поддерживает PDF-инпут,
// извлекать текст вручную не нужно) и честно разбирает по пунктам.
//
// ВАЖНО (добавлено 06.08 по прямому вопросу Игоря): первая версия сравнивала
// смету только "знаниями Claude", без сверки с нашей реальной базой price-agent.
// Теперь после того как Claude извлёк позиции из PDF, КОД (не модель) сверяет
// каждую позицию с таблицами materials/prices через тот же ilike-паттерн, что
// использует netlify/functions/prices.js — если находится совпадение, в ответ
// добавляется db_reference с РЕАЛЬНОЙ, недавно проверенной ценой из нашей базы.
// Это не вторая модельная генерация — просто SQL-джойн, поэтому цифры настолько
// же надёжны, как и в основной смете сайта.
//
// Честность цифр (см. правило проекта про fabricated content):
// - Claude работает ТОЛЬКО с тем, что реально написано в загруженном PDF.
// - Системный промпт запрещает придумывать точный % переплаты без реальной
//   разбивки материалы/работа в PDF.
// - db_reference — это только "вот наша отслеживаемая цена по этому материалу",
//   не готовый вердикт "вас обманывают" — окончательное сравнение делает
//   фронтенд/пользователь, а не мы за него.
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { pdf_base64, zip } = JSON.parse(event.body || '{}');
    if (!pdf_base64 || typeof pdf_base64 !== 'string') {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'pdf_base64 required' }) };
    }
    // ~15MB base64 ceiling — generous for a quote PDF, blocks abuse
    if (pdf_base64.length > 20_000_000) {
      return { statusCode: 413, headers: cors, body: JSON.stringify({ error: 'File too large' }) };
    }

    const SYSTEM_PROMPT = `You are analyzing a contractor's quote PDF for a US homeowner, on behalf of StackBid (stackbid.app), a construction-cost transparency tool.

STRICT RULES — these matter more than being impressive:
1. Only reference numbers and line items that are ACTUALLY WRITTEN in the uploaded PDF. Never invent a "typical market rate" and never state a precise overpay percentage unless the PDF itself gives you enough of a materials/labor breakdown to compute one honestly.
2. If the PDF does NOT separate materials from labor, say so explicitly and explain that without that split, you can only give general observations — do not fabricate a split.
3. Never invent legal citations, certifications, or claims about regulations. If something looks unusual, flag it as "worth asking the contractor about" — not as a confirmed overcharge.
4. If the PDF is not actually a construction quote (e.g. it's unrelated), say so plainly and stop.
5. Never claim StackBid guarantees savings or that this analysis is a substitute for a licensed second opinion.

For each material line item, also give a short GENERIC search term for that material (e.g. "2x4 lumber", "asphalt shingles", "vinyl siding", "PVC pipe") in "material_search_term" — this is just a lookup hint for our own price database, not a price itself. Use null if the line item is pure labor or not a physical material.

Output as JSON only, no markdown fences, matching exactly this shape:
{
  "is_valid_quote": boolean,
  "contractor_name": string|null,
  "quote_total": number|null,
  "has_materials_labor_split": boolean,
  "line_items": [{"description": string, "amount": number|null, "unit": string|null, "material_search_term": string|null, "note": string}],
  "observations": [string],
  "questions_to_ask_contractor": [string],
  "summary": string
}
"summary" is 2-3 honest sentences, no invented certainty. "observations" are neutral, specific things noticed (e.g. "Materials and labor are combined into one line, so a materials-vs-market comparison isn't possible from this PDF alone").`;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
            { type: 'text', text: `Analyze this contractor quote PDF.${zip ? ` Homeowner ZIP: ${zip}.` : ''} Return only the JSON object described in your instructions, nothing else.` }
          ]
        }]
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('quote-audit Anthropic error:', anthropicRes.status, errText.slice(0, 500));
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Analysis failed, please try again' }) };
    }

    const result = await anthropicRes.json();
    const rawText = (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let parsed;
    try {
      const cleaned = rawText.replace(/^```json\s*|```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('quote-audit JSON parse failed:', rawText.slice(0, 500));
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Could not parse the quote — try a clearer PDF' }) };
    }

    // Реальная сверка с нашей базой — код, не модель. Тот же паттерн, что prices.js.
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (SUPABASE_URL && SUPABASE_ANON_KEY && Array.isArray(parsed.line_items)) {
      for (const item of parsed.line_items) {
        item.db_reference = null;
        if (!item.material_search_term) continue;
        try {
          const matResp = await fetch(
            `${SUPABASE_URL}/rest/v1/materials?name=ilike.*${encodeURIComponent(item.material_search_term)}*&select=id,name,unit&limit=1`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
          );
          const materials = await matResp.json();
          if (!Array.isArray(materials) || !materials.length) continue;
          const mat = materials[0];
          const priceResp = await fetch(
            `${SUPABASE_URL}/rest/v1/prices?material_id=eq.${mat.id}&select=price,updated_at&order=updated_at.desc&limit=1`,
            { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
          );
          const prices = await priceResp.json();
          if (Array.isArray(prices) && prices.length) {
            item.db_reference = {
              matched_name: mat.name,
              unit: mat.unit,
              tracked_price: prices[0].price,
              as_of: prices[0].updated_at,
            };
          }
        } catch (e) {
          console.error('quote-audit db lookup failed for', item.material_search_term, e.message);
          // Не роняем весь запрос из-за одной несматчившейся позиции
        }
      }
    }

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
  } catch (e) {
    console.error('quote-audit error:', e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
