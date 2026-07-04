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

async function getActiveMaterials() {
  return supabaseFetch('materials?active=eq.true&select=id,name,name_short,sku_hd,unit,brand,specs');
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

Search the web for current pricing. Respond with ONLY a JSON object, no other text, no markdown fences:
{"price": <number, USD, per unit specified>, "confidence": "<high|medium|low>", "note": "<one short sentence, e.g. which retailer/source>"}

If you cannot find a reliable current price, respond with {"price": null, "confidence": "low", "note": "not found"}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
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
    return { price: null, confidence: 'low', note: 'parse_error' };
  }
}

async function insertPrice(materialId, price) {
  return supabaseFetch('prices', {
    method: 'POST',
    body: JSON.stringify({
      material_id: materialId,
      supplier_id: null, // общая рыночная цена, не привязана к конкретному поставщику
      price,
      unit: 'ea',
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
  let updated = 0;

  for (const material of materials) {
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
      const pctChange = oldPrice ? ((newPrice - oldPrice) / oldPrice) * 100 : null;
      const isAnomaly = pctChange !== null && Math.abs(pctChange) > ANOMALY_THRESHOLD_PCT;

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

      await insertPrice(material.id, newPrice);
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

  console.log(`Done. Updated: ${updated}, Anomalies: ${anomalies.length}, Failures: ${failures.length}`);

  if (anomalies.length || failures.length) {
    const html = `
      <h2>StackBid Price Agent — Run ${runId}</h2>
      <p>Updated: ${updated} / ${materials.length}</p>
      ${anomalies.length ? `<h3>⚠️ Anomalies (not applied, need review)</h3><ul>${anomalies.map(a => `<li>${a.material}: $${a.oldPrice} → $${a.newPrice} (${a.pctChange}%)</li>`).join('')}</ul>` : ''}
      ${failures.length ? `<h3>❌ Failures</h3><ul>${failures.map(f => `<li>${f.material}: ${f.reason}</li>`).join('')}</ul>` : ''}
    `;
    await sendAlertEmail(
      `StackBid Price Agent: ${anomalies.length} anomalies, ${failures.length} failures`,
      html
    );
  }
}

main().catch(async (e) => {
  console.error('Fatal error in price agent:', e);
  await sendAlertEmail('StackBid Price Agent — FATAL ERROR', `<pre>${e.stack || e.message}</pre>`);
  process.exit(1);
});
