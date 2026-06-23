// Vercel Edge Function — Permit Checker proxy
export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { zip, type, size } = await req.json();
    const apiKey = process.env.ANTHROPIC_API_KEY;

    const prompt = `You are a US building permit expert with current 2026 knowledge.
Project: ${type} · ZIP: ${zip} · Size: ${size || 'not specified'}
Return ONLY valid JSON:
{
  "state": "state name",
  "city": "likely city for this ZIP",
  "permit_required": true,
  "confidence": "high/medium/low",
  "permit_name": "official permit name",
  "typical_cost_min": 150,
  "typical_cost_max": 600,
  "processing_days_min": 3,
  "processing_days_max": 15,
  "portal_url": "city permit portal URL",
  "exemptions": ["exemption 1"],
  "required_docs": ["doc 1"],
  "key_rules": ["rule 1", "rule 2"],
  "warning": null,
  "contractor_license_required": true
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error' }), { status: 500 });
  }
}
