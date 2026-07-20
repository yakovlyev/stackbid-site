// Форма обратной связи на сайте. Раньше просто слала уведомление на личный
// Gmail и никак не отвечала человеку. Теперь: сохраняет сообщение (как и
// раньше — источник данных/аудита) и сама генерирует + отправляет ответ
// через Claude, без участия человека — тот же принцип, что и у
// email-agent.js для входящей почты.
const { Resend } = require('resend');

const REPLY_SYSTEM_PROMPT = `You are replying on behalf of StackBid (stackbid.app), a free AI-powered
construction materials cost estimator for US homeowners. Business facts you must get right:
- First estimate is free (email required, no credit card).
- After that, StackBid Pro is $9.99/month for unlimited estimates.
- Contractor Pro listing is $49/month, first 30 days free, self-service signup on the site.
- We do not sell materials or deliver anything — we estimate costs and point to suppliers.
- There is no phone support — only email and the in-app chat assistant on the site.

Write a short, warm, accurate reply in plain English to the message below, signed "— The StackBid Team".
This reply is sent automatically with no human review — be genuinely helpful and honest, never invent
facts or promise something a human will "follow up" on, since nobody will. If the message reports a bug
or problem you're not certain how to solve, say so plainly, ask for any details that would help (browser,
device, steps to reproduce), and suggest trying the in-app assistant (chat bubble on stackbid.app) too.
If it's clearly spam or unrelated to StackBid, respond with exactly: SKIP

Respond with ONLY the reply text (or exactly "SKIP"), no JSON, no markdown fences, no preamble.`;

async function generateReply(name, message) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: REPLY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `From: ${name}\n\n${message}` }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text;
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://stackbid.app',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };

  try {
    const { name, email, message } = JSON.parse(event.body || '{}');
    if (!name || !email || !message) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY;

    // 1. Save to Supabase — единственный источник аудита/лога, без письма человеку
    await fetch(`${SUPABASE_URL}/rest/v1/contact_messages`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ name, email, message, created_at: new Date().toISOString() })
    });

    // 2. Генерируем и сразу отправляем ответ — без человека в процессе
    if (RESEND_KEY && process.env.ANTHROPIC_API_KEY) {
      try {
        const reply = await generateReply(name, message);
        if (reply && reply.trim().toUpperCase() !== 'SKIP') {
          const resend = new Resend(RESEND_KEY);
          await resend.emails.send({
            from: 'StackBid <hello@stackbid.app>',
            to: email,
            subject: 'Re: your message to StackBid',
            html: reply.replace(/\n/g, '<br>'),
          });
        }
      } catch (e) {
        console.error('contact auto-reply failed:', e.message);
        // сообщение уже сохранено в базе — сбой авто-ответа не должен ломать форму для юзера
      }
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};
