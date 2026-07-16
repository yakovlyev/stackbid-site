/**
 * StackBid — Price Update Agent (Batch API version)
 *
 * Runs DAILY (see render.yaml). Each run does exactly one of two things:
 *   (a) If a batch from a previous run is still pending → check it; if done,
 *       process the results (validate, apply, or flag anomalies).
 *   (b) If no batch is pending → pick the next N materials (stalest first,
 *       weighted by category price_check_tier) and submit them as a new
 *       Anthropic Message Batch (50% cheaper than synchronous calls).
 *
 * This two-phase design avoids blocking a cron run on an async job that can
 * legitimately take minutes to hours — we simply pick it up next run.
 *
 * Требуемые переменные окружения (GitHub repo secrets / Render env vars):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
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

// Volatile categories get checked roughly ~5x more often than stable ones for
// the same position in the queue, by inflating how "stale" their price looks.
// This lives on the `categories.price_check_tier` column in Supabase (not
// hardcoded here) so it can be retuned per-category without a redeploy —
// important once the catalog grows well past a few hundred materials.
const TIER_WEIGHT = { volatile: 2.0, moderate: 1.0, stable: 0.4 };

const MAX_MATERIALS_PER_BATCH = 40; // batch jobs aren't wall-clock constrained like
// synchronous calls were, so this can be meaningfully higher than the old 15/run
// synchronous cap — cost is still bounded by this number × ~1 batch/day.

const runId = new Date().toISOString();

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

async function anthropicFetch(path, options = {}) {
  const res = await fetch(`https://api.anthropic.com/v1/${path}`, {
    ...options,
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-fetch-2025-09-10',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getActiveMaterials() {
  // manual_pricing_only=true — товары, которых физически нет в рознице HD/Lowe's
  // (спец. заказ, дистрибьюторские бренды и т.п.). Агент их не трогает вообще.
  const materials = await supabaseFetch(
    'materials?active=eq.true&manual_pricing_only=eq.false&select=id,name,name_short,sku_hd,unit,brand,specs,category_id'
  );
  const categories = await supabaseFetch('categories?select=id,price_check_tier');
  const tierByCategory = Object.fromEntries((categories || []).map(c => [c.id, c.price_check_tier]));

  const latestPrices = await supabaseFetch('prices?select=material_id,updated_at&order=updated_at.desc');
  const lastUpdatedMap = {};
  (latestPrices || []).forEach(p => {
    if (!(p.material_id in lastUpdatedMap)) lastUpdatedMap[p.material_id] = p.updated_at;
  });

  const now = Date.now();
  materials.forEach(m => {
    const lastUpdate = lastUpdatedMap[m.id] || null;
    const tier = tierByCategory[m.category_id] || 'moderate';
    const weight = TIER_WEIGHT[tier] || 1.0;
    const realAgeDays = lastUpdate ? (now - new Date(lastUpdate).getTime()) / 86400000 : null;
    // Never-priced materials get an effectively infinite age so they always
    // come first, regardless of tier.
    m._effectiveAge = realAgeDays === null ? Infinity : realAgeDays * weight;
    m._tier = tier;
  });

  materials.sort((a, b) => b._effectiveAge - a._effectiveAge); // stalest (weighted) first
  return materials;
}

function buildPrompt(material) {
  return `Find the current typical US retail price for this construction material as sold at major home improvement retailers (Home Depot, Lowe's) in 2026:

Product: ${material.name}
Brand: ${material.brand || 'any major brand'}
Specs: ${material.specs || 'n/a'}
Unit: ${material.unit}

IMPORTANT — how to find the actual price:
Individual product pages (homedepot.com/p/... and lowes.com/pd/...) load their price via JavaScript AFTER the page loads, so a fetch of that page will NOT contain a price. Do not rely on product pages for the price.

Category/listing pages (homedepot.com/b/... and lowes.com/pl/...) DO show prices as plain text. This is where you should look:
1. Use web_search to find the category or listing page for this type of material (aim for a /b/ or /pl/ URL, not a /p/ or /pd/ URL).
2. Use web_fetch to open that listing page and read the prices shown for each product in the grid.
3. Match the listed product that best fits the brand/specs given above, and report its price.
4. Make sure the price you report is per exactly one ${material.unit} (not per pack, pallet, bundle, or case) — divide if needed and say so in the note.
5. If your first search doesn't turn up a usable listing page, don't give up — within this same turn, try: the other retailer (Home Depot vs Lowe's), a broader/more generic search term (drop specific dimensions or the brand name), or a different phrasing. Only report "not found" after trying at least two different search angles.

Do all searching and fetching first. Your FINAL message must contain ONLY a JSON object and nothing else — no markdown fences, no explanation before or after it:
{"price": <number, USD, per ${material.unit}>, "confidence": "<high|medium|low>", "note": "<one short sentence: retailer, which product you matched, and whether you divided a multi-unit price>"}

If you truly cannot find a reliable current price after trying multiple search angles, respond with exactly {"price": null, "confidence": "low", "note": "not found"}`;
}

function parseResult(data) {
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cleaned = textBlocks.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* falls through */ }
    }
    return { price: null, confidence: 'low', note: 'parse_error' };
  }
}

async function getLastPrice(materialId) {
  const rows = await supabaseFetch(
    `prices?material_id=eq.${materialId}&order=updated_at.desc&limit=1&select=price,updated_at`
  );
  return rows && rows.length ? rows[0] : null;
}

async function insertPrice(materialId, price, unit) {
  return supabaseFetch('prices', {
    method: 'POST',
    body: JSON.stringify({
      material_id: materialId,
      supplier_id: null,
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
      body: JSON.stringify({ from: 'StackBid Price Agent <hello@stackbid.app>', to: [process.env.ALERT_EMAIL], subject, html }),
    });
  } catch (e) {
    console.error('Failed to send alert email:', e.message);
  }
}

async function getPendingBatch() {
  const rows = await supabaseFetch(`price_batch_runs?status=eq.pending&order=submitted_at.desc&limit=1&select=*`);
  return rows && rows.length ? rows[0] : null;
}

async function markBatchStatus(id, status) {
  return supabaseFetch(`price_batch_runs?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify({ status, processed_at: new Date().toISOString() }),
  });
}

/** Phase A: submit a new batch for the next N stalest materials. */
async function submitNewBatch() {
  const materials = await getActiveMaterials();
  const toProcess = materials.slice(0, MAX_MATERIALS_PER_BATCH);

  if (!toProcess.length) {
    console.log('No materials to process.');
    return;
  }

  const customIdMap = {};
  const requests = toProcess.map((material, i) => {
    const customId = `mat-${material.id}-${i}`;
    customIdMap[customId] = { id: material.id, name: material.name, unit: material.unit };
    return {
      custom_id: customId,
      params: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: buildPrompt(material) }],
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 2000 },
        ],
      },
    };
  });

  const batch = await anthropicFetch('messages/batches', {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });

  await supabaseFetch('price_batch_runs', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify({ batch_id: batch.id, custom_id_map: customIdMap, status: 'pending' }),
  });

  console.log(`Submitted batch ${batch.id} with ${toProcess.length} materials (tiers: ${toProcess.map(m => m._tier).join(',')})`);
}

/** Phase B: check a previously-submitted batch; process results if done. */
async function checkPendingBatch(pending) {
  const batch = await anthropicFetch(`messages/batches/${pending.batch_id}`);

  if (batch.processing_status !== 'ended') {
    console.log(`Batch ${pending.batch_id} still ${batch.processing_status}. Will check again next run.`);
    return;
  }

  const resultsRes = await fetch(batch.results_url, {
    headers: { 'x-api-key': required('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
  });
  const resultsText = await resultsRes.text();
  const lines = resultsText.trim().split('\n').filter(Boolean);

  const anomalies = [];
  const failures = [];
  let updated = 0;

  for (const line of lines) {
    const entry = JSON.parse(line);
    const material = pending.custom_id_map[entry.custom_id];
    if (!material) continue;

    if (entry.result.type !== 'succeeded') {
      failures.push({ material: material.name, reason: entry.result.type });
      await logUpdate({ material_id: material.id, old_price: null, new_price: null, percent_change: null, flagged_anomaly: false, source_note: `FAILED: batch ${entry.result.type}` });
      continue;
    }

    const parsed = parseResult(entry.result.message);
    if (parsed.price === null || typeof parsed.price !== 'number') {
      failures.push({ material: material.name, reason: parsed.note || 'no price found' });
      await logUpdate({ material_id: material.id, old_price: null, new_price: null, percent_change: null, flagged_anomaly: false, source_note: `FAILED: ${parsed.note || 'no price'}` });
      continue;
    }

    const last = await getLastPrice(material.id);
    const oldPrice = last ? Number(last.price) : null;
    const newPrice = Number(parsed.price);
    const { pctChange, isAnomaly } = evaluatePriceChange(oldPrice, newPrice);

    if (isAnomaly) {
      anomalies.push({ material: material.name, oldPrice, newPrice, pctChange: pctChange.toFixed(1) });
      await logUpdate({ material_id: material.id, old_price: oldPrice, new_price: newPrice, percent_change: pctChange, flagged_anomaly: true, source_note: `ANOMALY (not applied): ${parsed.note}` });
      continue;
    }

    await insertPrice(material.id, newPrice, material.unit);
    await logUpdate({ material_id: material.id, old_price: oldPrice, new_price: newPrice, percent_change: pctChange, flagged_anomaly: false, source_note: parsed.note });
    updated++;
  }

  await markBatchStatus(pending.id, 'processed');

  console.log(`Batch ${pending.batch_id} done. Updated: ${updated}, Anomalies: ${anomalies.length}, Failures: ${failures.length}`);

  if (anomalies.length || failures.length) {
    const html = `
      <h2>StackBid Price Agent (batch ${pending.batch_id})</h2>
      <p>Updated: ${updated} / ${lines.length}</p>
      ${anomalies.length ? `<h3>⚠️ Anomalies (not applied, review at /admin-prices.html)</h3><ul>${anomalies.map(a => `<li>${a.material}: $${a.oldPrice} → $${a.newPrice} (${a.pctChange}%)</li>`).join('')}</ul>` : ''}
      ${failures.length ? `<h3>❌ Failures</h3><ul>${failures.map(f => `<li>${f.material}: ${f.reason}</li>`).join('')}</ul>` : ''}
    `;
    await sendAlertEmail(`StackBid Price Agent: ${updated} updated, ${anomalies.length} anomalies, ${failures.length} failures`, html);
  }
}

async function main() {
  console.log(`[${runId}] Starting price update run (batch mode)...`);

  const pending = await getPendingBatch();
  if (pending) {
    await checkPendingBatch(pending);
  } else {
    await submitNewBatch();
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
