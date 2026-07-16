// Backs the internal /admin-prices.html review page. Replaces "resolve it by
// reading an email and fixing the DB by hand" with a small UI: list flagged
// anomalies (from price-agent.js) + let Igor Apply (accept the new scraped
// price) or Dismiss (keep the old price, mark reviewed) in one click.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET; // shared secret, set in Render env vars

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (!ADMIN_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_SECRET not configured on server' }) };
  }

  const params = event.httpMethod === 'GET'
    ? event.queryStringParameters || {}
    : JSON.parse(event.body || '{}');

  if (params.key !== ADMIN_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid key' }) };
  }

  try {
    if (event.httpMethod === 'GET') {
      const logs = await sb(
        `price_update_log?flagged_anomaly=eq.true&resolved=eq.false&select=id,material_id,old_price,new_price,percent_change,source_note,created_at&order=created_at.desc`
      );
      const materialIds = [...new Set((logs || []).map(l => l.material_id))];
      let materialsById = {};
      if (materialIds.length) {
        const mats = await sb(`materials?id=in.(${materialIds.join(',')})&select=id,name,unit`);
        materialsById = Object.fromEntries((mats || []).map(m => [m.id, m]));
      }
      const enriched = (logs || []).map(l => ({ ...l, material: materialsById[l.material_id] || null }));
      return { statusCode: 200, headers, body: JSON.stringify({ anomalies: enriched }) };
    }

    if (event.httpMethod === 'POST') {
      const { log_id, action } = params;
      if (!log_id || !['apply', 'dismiss'].includes(action)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'log_id and action (apply|dismiss) required' }) };
      }

      const [log] = await sb(`price_update_log?id=eq.${log_id}&select=*`);
      if (!log) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Log entry not found' }) };

      if (action === 'apply') {
        const [material] = await sb(`materials?id=eq.${log.material_id}&select=unit`);
        await sb('prices', {
          method: 'POST',
          body: JSON.stringify({
            material_id: log.material_id,
            supplier_id: null,
            price: log.new_price,
            unit: material?.unit || 'ea',
            source: 'manual', // manually confirmed by a human after review, not raw scrape
            valid_from: new Date().toISOString().slice(0, 10),
          }),
        });
      }

      await sb(`price_update_log?id=eq.${log_id}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          resolved: true,
          resolved_at: new Date().toISOString(),
          resolution_action: action === 'apply' ? 'applied' : 'dismissed',
        }),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
