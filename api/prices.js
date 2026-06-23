// Vercel Edge Function — StackBid Price Lookup from Supabase
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const { material_names, zip, state } = await req.json();
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

    // Search materials by name (fuzzy match)
    const searchTerms = (material_names || []).slice(0, 20);
    const results = [];

    for (const term of searchTerms) {
      // Search materials table
      const matResp = await fetch(
        `${SUPABASE_URL}/rest/v1/materials?name=ilike.*${encodeURIComponent(term)}*&select=id,name,unit,specs,brand,category_id`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const materials = await matResp.json();
      if (!materials.length) continue;

      const mat = materials[0];

      // Get prices for this material
      const priceResp = await fetch(
        `${SUPABASE_URL}/rest/v1/prices?material_id=eq.${mat.id}&select=price,unit,supplier_id,region&order=supplier_id`,
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
      );
      const prices = await priceResp.json();

      // Map supplier_id to type
      const hdPrice    = prices.find(p => p.supplier_id === 1)?.price;
      const wsPrice    = prices.find(p => p.supplier_id === 3)?.price;
      const localPrice = prices.find(p => p.supplier_id === 4)?.price;

      if (hdPrice) {
        results.push({
          search_term: term,
          material_id: mat.id,
          name: mat.name,
          unit: mat.unit,
          specs: mat.specs,
          brand: mat.brand,
          hd_price: hdPrice,
          wholesale_price: wsPrice || hdPrice * 0.75,
          local_price: localPrice || hdPrice * 0.69,
          from_db: true
        });
      }
    }

    return new Response(JSON.stringify({ results, zip, found: results.length }), {
      status: 200, headers: corsHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, results: [] }), {
      status: 500, headers: corsHeaders
    });
  }
}
