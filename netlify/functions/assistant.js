// StackBid AI Assistant — чат-напарник поверх уже готовой инфраструктуры
// (Claude API для генерации смет, PDFKit+Resend для писем). Не отдельный
// продукт с нуля — тонкая обвязка через tool-use поверх того, что уже есть.
//
// MVP-скоуп сознательно узкий:
//   - Отвечает на вопросы про ТЕКУЩУЮ смету (почему так дорого, что такое
//     wholesale, посоветовать более дешёвый материал и т.п.) — просто чат
//     с контекстом, без побочных эффектов.
//   - Одно реальное действие с side-effect: отправить PDF сметы на email
//     (reuse buildPdfBuffer из email-pdf.js) — через tool_use.
// Сравнение двух смет и другие действия — сознательно НЕ в этой версии,
// чтобы не размывать скоуп первого релиза.

const { Resend } = require('resend');
const { buildPdfBuffer } = require('./email-pdf');

const SYSTEM_PROMPT = `You are the StackBid Assistant — a friendly, concise helper built into the StackBid materials cost estimator. You help homeowners understand THEIR CURRENT estimate (shown to you as JSON context below) and can email them a PDF copy of it if they ask.

Rules:
- Be brief. This is a chat widget on a mobile-friendly page, not an essay.
- Only discuss this estimate, construction materials, pricing, and how StackBid works. Politely decline unrelated requests.
- If asked to suggest a cheaper alternative for a material, use your own knowledge of construction materials to suggest one plausible cheaper option and explain the tradeoff briefly (this is a suggestion, not a guaranteed price — say so).
- If the person asks to email/send the PDF, and you don't have their email yet, ask for it. Once you have a valid-looking email, call the send_pdf_email tool.
- Never invent specific dollar prices beyond what's in the provided estimate context — for anything you're not sure about, say so plainly.`;

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { messages, estimate, zip } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'messages required' }) };
    }

    const estimateContext = estimate
      ? `Current estimate context (JSON): ${JSON.stringify(estimate).slice(0, 6000)}\nZIP: ${zip || 'unknown'}`
      : 'No estimate has been generated yet in this session.';

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: `${SYSTEM_PROMPT}\n\n${estimateContext}`,
        messages,
        tools: [
          {
            name: 'send_pdf_email',
            description: 'Email the current estimate as a PDF attachment to the given address. Only call this once you have a plausible email address from the user.',
            input_schema: {
              type: 'object',
              properties: { email: { type: 'string', description: 'The email address to send the PDF to' } },
              required: ['email'],
            },
          },
        ],
      }),
    });

    const data = await anthropicRes.json();
    if (data.type === 'error') {
      return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: data.error?.message || 'Claude API error' }) };
    }

    // Обрабатываем tool_use, если модель решила отправить PDF
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'send_pdf_email');
    let actionResult = null;

    if (toolUse && estimate) {
      const email = toolUse.input.email;
      if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        try {
          const pdfBuffer = await buildPdfBuffer(estimate, zip);
          const resend = new Resend(process.env.RESEND_API_KEY);
          await resend.emails.send({
            from: 'StackBid <hello@stackbid.app>',
            to: email,
            subject: `Your StackBid estimate${estimate.title ? ': ' + estimate.title : ''}`,
            html: `<p>Hi,</p><p>Here's the materials estimate you asked our assistant to send — attached as a PDF.</p><p>Thanks for using StackBid!</p>`,
            attachments: [{ filename: 'stackbid-estimate.pdf', content: pdfBuffer }],
          });
          actionResult = { sent: true, email };
        } catch (e) {
          actionResult = { sent: false, error: e.message };
        }
      } else {
        actionResult = { sent: false, error: 'invalid_email' };
      }
    }

    // Собираем финальный текст для показа пользователю: если был tool_use,
    // просим модель одним коротким сообщением подтвердить результат (без
    // второго полного круга — экономим токены и время ответа виджета).
    let replyText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (toolUse && actionResult) {
      replyText = actionResult.sent
        ? `✅ Sent! Check ${actionResult.email} for your PDF estimate.`
        : `I couldn't send that — ${actionResult.error === 'invalid_email' ? 'that email address doesn\'t look valid, could you double-check it?' : 'something went wrong on our end, please try again in a moment.'}`;
    }
    if (!replyText) replyText = "I'm here to help with your estimate — what would you like to know?";

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply: replyText, action: actionResult }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
