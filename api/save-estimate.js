// Vercel Edge Function — Save estimate + user to Supabase
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const { user, estimate } = await req.json();
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
    const headers = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    };

    // Upsert user
    let userId = null;
    if (user?.email) {
      const userResp = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          email: user.email,
          first_name: user.first_name,
          role: user.role,
          zip: estimate?.zip,
          price_alerts: user.price_alerts ?? true,
          last_seen: new Date().toISOString()
        })
      });
      const userData = await userResp.json();
      userId = userData[0]?.id;
    }

    // Save estimate
    let estimateId = null, sharedToken = null;
    if (estimate) {
      const estResp = await fetch(`${SUPABASE_URL}/rest/v1/estimates`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          user_id: userId,
          title: estimate.title,
          project_type: estimate.project_type,
          zip: estimate.zip,
          description: estimate.description,
          total_retail: estimate.total_retail,
          total_wholesale: estimate.total_wholesale,
          total_local: estimate.total_local,
          items: estimate.items
        })
      });
      const estData = await estResp.json();
      estimateId = estData[0]?.id;
      sharedToken = estData[0]?.shared_token;
    }

    return new Response(JSON.stringify({
      success: true,
      user_id: userId,
      estimate_id: estimateId,
      share_url: sharedToken ? `https://stackbid.app/estimate/${sharedToken}` : null
    }), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders
    });
  }
}
