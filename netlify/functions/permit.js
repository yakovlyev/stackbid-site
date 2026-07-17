exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://stackbid.app',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  try {
    const { zip, type, size } = JSON.parse(event.body || '{}');
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const prompt = `You are a US building permit expert with current 2026 knowledge.
Project: ${type} · ZIP: ${zip} · Size: ${size || 'not specified'}
Return ONLY valid JSON:
{"state":"state name","city":"likely city","permit_required":true,"confidence":"high","permit_name":"Building Permit","typical_cost_min":150,"typical_cost_max":600,"processing_days_min":3,"processing_days_max":15,"portal_url":"","exemptions":[],"required_docs":["Site plan","Construction drawings"],"key_rules":["Rule 1"],"warning":null,"contractor_license_required":true}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] })
    });

    const data = await response.json();
    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
