/**
 * StackBid — Weekly Price Update Agent
 *
 * Раз в неделю (через GitHub Actions cron) проходит по всем активным материалам,
 * ищет актуальную рыночную цену через Anthropic API + web search,
 * валидирует аномалии (>30% скачок) и обновляет Supabase.
 *
 * Требуемые переменные окружения (GitHub repo secrets):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL              (например https://xbxknpsqecwahxzwsvpt.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY (НЕ anon key — нужен для записи мимо RLS)
 *   RESEND_API_KEY            (для алертов на почту при сбоях)
 *   ALERT_EMAIL               (куда слать алерты, напр. stackbid.app@gmail.com)
 */

const ANOMALY_THRESHOLD_PCT = 30;

/**
 * Определяет процент изменения цены и является ли оно аномальным.
 * Вынесено в отдельную чистую функцию специально, чтобы её можно было
 * протестировать напрямую (см. price-agent.test.js), не запуская весь агент.
 */
function evaluatePriceChange(oldPrice, newPrice, thresholdPct = ANOMALY_THRESHOLD_PCT) {
  if (oldPrice === null || oldPrice === undefined || oldPrice === 0) {
    return { pctChange: null, isAnomaly: false };
  }
  const pctChange = ((newPrice - oldPrice) / oldPrice) * 100;
  const isAnomaly = Math.abs(pctChange) > thresholdPct;
  return { pctChange, isAnomaly };
}

module.exports = { evaluatePriceChange, ANOMALY_THRESHOLD_PCT };
const MAX_RUNTIME_MS = 5 * 60 * 1000; // 5 минут — жёсткий потолок на весь прогон, чтобы не висеть бесконечно
const runId = new Date().toISOString();
const startedAt = Date.now();

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
      'apikey': required('SUPABASE_SERVICE_ROLE_KEY'),
      'Authorization': `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getActiveMaterials() {
  // manual_pricing_only=true — товары, которых физически нет в рознице HD/Lowe's
  // (спец. заказ, дистрибьюторские бренды и т.п.). Агент их не трогает вообще,
  // чтобы не жечь API-вызовы на заведомо безрезультатный поиск.
  return supabaseFetch(
    'materials?active=eq.true&manual_pricing_only=eq.false&select=id,name,name_short,sku_hd,unit,brand,specs'
  );
}

async function getLastPrice(materialId) {
  const rows = await supabaseFetch(
    `prices?material_id=eq.${materialId}&order=updated_at.desc&limit=1&select=price,updated_at`
  );
  return rows && rows.length ? rows[0] : null;
}

async function askAgentForPrice(material) {
  const prompt = `Find the current typical US retail price for this construction material as sold at major home improvement retailers (Home Depot, Lowe's) in 2026:

Product: ${material.name}
Brand: ${material.brand || 'any major brand'}
Specs: ${material.specs || 'n/a'}
Unit: ${material.unit}

IMPORTANT — how to find the actual price:
Individual product pages (homedepot.com/p/... and lowes.com/pd/...) load their price via JavaScript AFTER the page loads, so a fetch of that page will NOT contain a price — you will see navigation, descriptions, and specs, but no dollar amount, even though the product is real and in stock. Do not rely on product pages for the price.

Category/listing pages (homedepot.com/b/... and lowes.com/pl/...) DO show prices as plain text, because they render a grid of products with prices for browsing/filtering. This is where you should look:
1. Use web_search to find the category or listing page for this type of material (e.g. search "site:homedepot.com [material] " or "site:lowes.com [material]" together with terms like "lumber", "dimensional lumber", etc. — aim for a /b/ or /pl/ URL, not a /p/ or /pd/ URL).
2. Use web_fetch to open that listing page and read the prices shown for each product in the grid.
3. Match the listed product that best fits the brand/specs given above, and report its price. If multiple close matches exist, prefer the one most consistent with the given specs, and note in your answer which specific product you matched.
4. Make sure the price you report is per exactly one ${material.unit} (not per pack, pallet, bundle, or case). Listing pages sometimes show "$X/package" — if so, divide by the pack quantity shown and say so in the note.
5. If a listing page redirects you to a single product with no visible price, try a broader or different category search rather than giving up immediately.

Do all searching and fetching first. Your FINAL message must contain ONLY a JSON object and nothing else — no markdown fences, no explanation before or after it:
{"price": <number, USD, per ${material.unit}>, "confidence": "<high|medium|low>", "note": "<one short sentence: retailer, which product you matched, and whether you divided a multi-unit price>"}

If you cannot find a reliable current price after searching and fetching listing pages, respond with exactly {"price": null, "confidence": "low", "note": "not found"}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-fetch-2025-09-10',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
        { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 3000 },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cleaned = textBlocks.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Модель иногда добавляет пояснение до/после JSON — пробуем вытащить сам объект,
    // прежде чем сдаваться и записывать parse_error.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        // falls through
      }
    }
    return { price: null, confidence: 'low', note: 'parse_error' };
  }
}

async function insertPrice(materialId, price, unit) {
  return supabaseFetch('prices', {
    method: 'POST',
    body: JSON.stringify({
      material_id: materialId,
      supplier_id: null, // общая рыночная цена, не привязана к конкретному поставщику
      price,
      unit: unit || 'ea',
      source: 'api',
      valid_from: new Date().toISOString().slice(0, 10),
    }),
  });
}

async function logUpdate(entry) {
  return supabaseFetch('price_update_log', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify({ ...entry, run_id: runId }),
  });
}

async function sendAlertEmail(subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.ALERT_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'StackBid Price Agent <hello@stackbid.app>',
        to: [process.env.ALERT_EMAIL],
        subject,
        html,
      }),
    });
  } catch (e) {
    console.error('Failed to send alert email:', e.message);
  }
}

async function main() {
  console.log(`[${runId}] Starting weekly price update run...`);

  const materials = await getActiveMaterials();
  console.log(`Found ${materials.length} active materials.`);

  const anomalies = [];
  const failures = [];
  const skipped = [];
  let updated = 0;

  for (let i = 0; i < materials.length; i++) {
    const material = materials[i];

    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      const remaining = materials.slice(i).map(m => m.name);
      skipped.push(...remaining);
      console.log(`Time budget (${MAX_RUNTIME_MS / 60000} min) reached. Stopping early. Skipped ${remaining.length} materials — they'll be picked up next run.`);
      break;
    }

    try {
      const last = await getLastPrice(material.id);
      const result = await askAgentForPrice(material);

      if (result.price === null || typeof result.price !== 'number') {
        failures.push({ material: material.name, reason: result.note || 'no price found' });
        await logUpdate({
          material_id: material.id,
          old_price: last ? last.price : null,
          new_price: null,
          percent_change: null,
          flagged_anomaly: false,
          source_note: `FAILED: ${result.note || 'no price'}`,
        });
        continue;
      }

      const oldPrice = last ? Number(last.price) : null;
      const newPrice = Number(result.price);
      const { pctChange, isAnomaly } = evaluatePriceChange(oldPrice, newPrice);

      if (isAnomaly) {
        // Аномалия — логируем, но НЕ применяем автоматически, чтобы не поломать цены ошибкой агента
        anomalies.push({
          material: material.name,
          oldPrice,
          newPrice,
          pctChange: pctChange.toFixed(1),
        });
        await logUpdate({
          material_id: material.id,
          old_price: oldPrice,
          new_price: newPrice,
          percent_change: pctChange,
          flagged_anomaly: true,
          source_note: `ANOMALY (not applied): ${result.note}`,
        });
        continue;
      }

      await insertPrice(material.id, newPrice, material.unit);
      await logUpdate({
        material_id: material.id,
        old_price: oldPrice,
        new_price: newPrice,
        percent_change: pctChange,
        flagged_anomaly: false,
        source_note: result.note,
      });
      updated++;
    } catch (e) {
      failures.push({ material: material.name, reason: e.message });
      console.error(`Error processing ${material.name}:`, e.message);
    }
  }

  console.log(`Done. Updated: ${updated}, Anomalies: ${anomalies.length}, Failures: ${failures.length}, Skipped (time budget): ${skipped.length}`);

  if (anomalies.length || failures.length || skipped.length) {
    const html = `
      <h2>StackBid Price Agent — Run ${runId}</h2>
      <p>Updated: ${updated} / ${materials.length}</p>
      ${skipped.length ? `<h3>⏱️ Skipped (time budget reached, will retry next run)</h3><ul>${skipped.map(m => `<li>${m}</li>`).join('')}</ul>` : ''}
      ${anomalies.length ? `<h3>⚠️ Anomalies (not applied, need review)</h3><ul>${anomalies.map(a => `<li>${a.material}: $${a.oldPrice} → $${a.newPrice} (${a.pctChange}%)</li>`).join('')}</ul>` : ''}
      ${failures.length ? `<h3>❌ Failures</h3><ul>${failures.map(f => `<li>${f.material}: ${f.reason}</li>`).join('')}</ul>` : ''}
    `;
    await sendAlertEmail(
      `StackBid Price Agent: ${updated} updated, ${anomalies.length} anomalies, ${failures.length} failures, ${skipped.length} skipped`,
      html
    );
  }
}

// Запускаем агента только при прямом вызове (node price-agent.js), а не при
// require() из тестов — иначе тесты случайно триггерят реальный прогон агента.
if (require.main === module) {
  main().catch(async (e) => {
    console.error('Fatal error in price agent:', e);
    await sendAlertEmail('StackBid Price Agent — FATAL ERROR', `<pre>${e.stack || e.message}</pre>`);
    process.exit(1);
  });
}


