// Vercel Edge Function — StackBid API Proxy
// Хранит ANTHROPIC_API_KEY на сервере, никогда не отдаёт клиенту

export const config = { runtime: 'edge' };

export default async function handler(req) {

  // Разрешаем только POST
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // CORS — разрешаем запросы с нашего домена
  const origin = req.headers.get('origin') || '';
  const allowed = ['https://stackbid.app', 'http://localhost:3000', 'http://127.0.0.1'];
  const corsOrigin = allowed.includes(origin) ? origin : 'https://stackbid.app';

  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const body = await req.json();

    // Базовая валидация
    if (!body.messages || !Array.isArray(body.messages)) {
      return new Response(JSON.stringify({ error: 'Invalid request body' }), {
        status: 400, headers: corsHeaders
      });
    }

    // API ключ берём из Vercel Environment Variables — никогда не в коде
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500, headers: corsHeaders
      });
    }

    // Проксируем запрос к Anthropic
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 1000,
        messages: body.messages,
        system: body.system || undefined
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'API error' }), {
        status: response.status, headers: corsHeaders
      });
    }

    return new Response(JSON.stringify(data), {
      status: 200, headers: corsHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: corsHeaders
    });
  }
}
