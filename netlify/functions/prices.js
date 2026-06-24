exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
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
        `${SUPABASE_URL}/rest/v1/prices?material_id=eq.${mat.id}&select=price,supplier_id`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const prices = await priceResp.json();
      const hdPrice = prices.find(p => p.supplier_id === 1)?.price;
      const wsPrice = prices.find(p => p.supplier_id === 3)?.price;
      const localPrice = prices.find(p => p.supplier_id === 4)?.price;
      if (hdPrice) results.push({ search_term: term, name: mat.name, unit: mat.unit, hd_price: hdPrice, wholesale_price: wsPrice || hdPrice * 0.75, local_price: localPrice || hdPrice * 0.69, from_db: true });
    }

    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ results, zip, found: results.length }) };
  } catch (err) {
    return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message, results: [] }) };
  }
};
