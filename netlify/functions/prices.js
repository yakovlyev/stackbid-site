exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://stackbid.app',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };

  try {
    const { material_names, zip } = JSON.parse(event.body || '{}');
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
    const results = [];

    for (const term of (material_names || []).slice(0, 20)) {
      const matResp = await fetch(
        `${SUPABASE_URL}/rest/v1/materials?name=ilike.*${encodeURIComponent(term)}*&select=id,name,unit,specs,brand`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const materials = await matResp.json();
      if (!materials.length) continue;
      const mat = materials[0];
      const priceResp = await fetch(
        `${SUPABASE_URL}/rest/v1/prices?material_id=eq.${mat.id}&select=price,supplier_id,updated_at`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const prices = await priceResp.json();
      const hdPrice = prices.find(p => p.supplier_id === 1)?.price;
      const wsPrice = prices.find(p => p.supplier_id === 3)?.price;
      const localPrice = prices.find(p => p.supplier_id === 4)?.price;
      // price-agent.js (weekly HD/Lowe's scraper) writes rows with supplier_id = null —
      // a general market price, not tied to one of the three columns above. This is our
      // most-recently-verified real-world price, used to sanity-check the AI's live estimate,
      // not just to fill gaps when the AI has nothing.
      const marketRows = prices.filter(p => p.supplier_id === null || p.supplier_id === undefined)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      const referencePrice = marketRows[0]?.price;
      const referenceDate = marketRows[0]?.updated_at;
      if (hdPrice || referencePrice) {
        results.push({
          search_term: term, name: mat.name, unit: mat.unit,
          hd_price: hdPrice, wholesale_price: wsPrice || (hdPrice ? hdPrice * 0.75 : undefined),
          local_price: localPrice || (hdPrice ? hdPrice * 0.69 : undefined),
          from_db: true,
          reference_price: referencePrice || null,
          reference_date: referenceDate || null,
        });
      }
    }

    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ results, zip, found: results.length }) };
  } catch (err) {
    return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message, results: [] }) };
  }
};
