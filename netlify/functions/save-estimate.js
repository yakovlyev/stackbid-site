exports.handler = async (event) => {
  const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  try {
    const { user, estimate } = JSON.parse(event.body || '{}');
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };
    let userId = null;
    if (user?.email) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/users`, { method: 'POST', headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ email: user.email, first_name: user.first_name, role: user.role, price_alerts: user.price_alerts ?? true, last_seen: new Date().toISOString() }) });
      const d = await r.json();
      userId = d[0]?.id;
    }
    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, user_id: userId }) };
  } catch (err) {
    return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
