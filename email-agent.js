/**
 * StackBid — Inbox Triage Agent
 *
 * Раз в час (Render Cron Job) проверяет новые письма на hello@stackbid.app,
 * классифицирует их через Anthropic API и готовит черновик ответа —
 * НЕ отправляет автоматически. Черновик кладётся в папку Drafts в самом
 * Zoho, плюс дублирующая сводка уходит на stackbid.hello@gmail.com,
 * чтобы Игорь мог проверять и одобрять руками, пока агент не наберёт
 * стабильно высокий процент точных ответов.
 *
 * Требуемые переменные окружения (Render):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REFRESH_TOKEN        (получается один раз через Self Client, дальше вечный)
 *   ZOHO_ACCOUNT_ID           (numeric account id для hello@stackbid.app)
 *   DIGEST_TO_EMAIL           (stackbid.hello@gmail.com)
 *
 * Требуемая таблица в Supabase (см. email-agent-schema.sql):
 *   email_agent_log
 */

const MAX_RUNTIME_MS = 5 * 60 * 1000; // тот же жёсткий потолок, что и у price-agent
const startedAt = Date.now();

const ZOHO_MAIL_API = 'https://mail.zoho.com/api';
const FROM_ADDRESS = 'hello@stackbid.app';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function timeLeft() {
  return MAX_RUNTIME_MS - (Date.now() - startedAt);
}

async function supabaseFetch(path, options = {}) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'apikey': required('SUPABASE_SERVICE_ROLE_KEY'),
      'Authorization': `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      'Prefer': options.prefer || 'return=representation',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---------- Zoho Mail API ----------

async function getZohoAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: required('ZOHO_CLIENT_ID'),
    client_secret: required('ZOHO_CLIENT_SECRET'),
    refresh_token: required('ZOHO_REFRESH_TOKEN'),
  });
  const res = await fetch(`https://accounts.zoho.com/oauth/v2/token?${params}`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`Zoho token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Zoho token refresh returned no access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function zohoFetch(accessToken, path, options = {}) {
  const res = await fetch(`${ZOHO_MAIL_API}/${path}`, {
    ...options,
    headers: {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Zoho ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getInboxFolderId(accessToken, accountId) {
  const data = await zohoFetch(accessToken, `accounts/${accountId}/folders`);
  const inbox = (data.data || []).find(f => f.folderName === 'Inbox' || f.path === '/Inbox');
  if (!inbox) throw new Error(`Could not find Inbox folder in: ${JSON.stringify(data.data)}`);
  return inbox.folderId;
}

async function getNewMessages(accessToken, accountId, limit = 20) {
  const data = await zohoFetch(
    accessToken,
    `accounts/${accountId}/messages/search?searchKey=newMails&limit=${limit}&includeto=true`
  );
  return data.data || [];
}

async function getMessageContent(accessToken, accountId, folderId, messageId) {
  const data = await zohoFetch(
    accessToken,
    `accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`
  );
  return data.data ? data.data.content : '';
}

async function createDraft(accessToken, accountId, { toAddress, subject, content }) {
  return zohoFetch(accessToken, `accounts/${accountId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      mode: 'draft',
      fromAddress: FROM_ADDRESS,
      toAddress,
      subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
      content,
      mailFormat: 'html',
    }),
  });
}

async function sendMail(accessToken, accountId, { toAddress, subject, content }) {
  return zohoFetch(accessToken, `accounts/${accountId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      fromAddress: FROM_ADDRESS,
      toAddress,
      subject,
      content,
    }),
  });
}

// ---------- Anthropic — классификация + черновик ответа ----------

const SYSTEM_CONTEXT = `You triage inbound email for StackBid (stackbid.app), a free AI-powered
construction materials cost estimator for US homeowners. Business facts you must get right:
- First estimate is free (email required, no credit card).
- After that, StackBid Pro is $9.99/month for unlimited estimates.
- Contractor Pro listing is $49/month, first 30 days free.
- We do not sell materials or deliver anything — we estimate costs and point to suppliers.
- Support/contact email: hello@stackbid.app

Classify each email into exactly one category:
- "homeowner_question" — a homeowner asking how the tool/pricing/estimate works
- "contractor_inquiry" — a contractor asking about Pro listing
- "press_partnership" — media, partnership, or business development inquiry
- "bug_or_complaint" — reports a problem, error, or is unhappy — ALWAYS needs a human, never draft a confident fix
- "spam" — irrelevant, promotional, or clearly automated spam

For every category except "spam", draft a short, warm, accurate reply in plain English, signed "— The StackBid Team".
For "bug_or_complaint", the draft should acknowledge the issue and say a team member will follow up personally —
never invent a technical explanation or promise a specific fix.
For "spam", leave draft_reply as an empty string.

Respond with ONLY a JSON object, no markdown fences, no extra text:
{"category": "...", "confidence": "high|medium|low", "draft_reply": "..."}`;

async function classifyAndDraft(email) {
  const prompt = `From: ${email.fromAddress}
Subject: ${email.subject}

${email.bodyText}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: SYSTEM_CONTEXT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cleaned = textBlocks.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    return { category: 'bug_or_complaint', confidence: 'low', draft_reply: '' };
  }
}

// ---------- Supabase — не обрабатывать письмо дважды ----------

async function isAlreadyProcessed(messageId) {
  const rows = await supabaseFetch(`email_agent_log?message_id=eq.${messageId}&select=message_id`);
  return rows && rows.length > 0;
}

async function logProcessed({ messageId, fromAddress, subject, category, confidence, draftCreated }) {
  return supabaseFetch('email_agent_log', {
    method: 'POST',
    prefer: 'return=minimal',
    body: JSON.stringify({
      message_id: messageId,
      from_address: fromAddress,
      subject,
      category,
      confidence,
      draft_created: draftCreated,
      processed_at: new Date().toISOString(),
    }),
  });
}

// ---------- Основной прогон ----------

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function main() {
  const accountId = required('ZOHO_ACCOUNT_ID');
  const accessToken = await getZohoAccessToken();
  const folderId = await getInboxFolderId(accessToken, accountId);
  const messages = await getNewMessages(accessToken, accountId);

  const digestItems = [];
  let processedCount = 0;

  for (const msg of messages) {
    if (timeLeft() < 20000) {
      console.log('Approaching runtime cap, stopping early.');
      break;
    }

    const messageId = msg.messageId;
    if (await isAlreadyProcessed(messageId)) continue;

    let result = { category: 'bug_or_complaint', confidence: 'low', draft_reply: '' };
    let draftCreated = false;

    try {
      const rawContent = await getMessageContent(accessToken, accountId, msg.folderId || folderId, messageId);
      const email = {
        fromAddress: msg.fromAddress,
        subject: msg.subject || '(no subject)',
        bodyText: stripHtml(rawContent).slice(0, 6000), // cap length fed to the model
      };

      result = await classifyAndDraft(email);

      if (result.category !== 'spam' && result.draft_reply) {
        await createDraft(accessToken, accountId, {
          toAddress: email.fromAddress,
          subject: email.subject,
          content: result.draft_reply.replace(/\n/g, '<br>'),
        });
        draftCreated = true;
      }

      digestItems.push({
        from: email.fromAddress,
        subject: email.subject,
        category: result.category,
        confidence: result.confidence,
        draft: result.draft_reply,
      });

      processedCount++;
    } catch (err) {
      console.error(`Failed processing message ${messageId}:`, err.message);
      digestItems.push({
        from: msg.fromAddress,
        subject: msg.subject,
        category: 'error',
        confidence: 'n/a',
        draft: `Processing failed: ${err.message}`,
      });
    }

    await logProcessed({
      messageId,
      fromAddress: msg.fromAddress,
      subject: msg.subject,
      category: result.category,
      confidence: result.confidence,
      draftCreated,
    });
  }

  if (digestItems.length > 0) {
    const html = digestItems.map(item => `
      <div style="border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:12px;">
        <div style="font-size:12px;color:#888;text-transform:uppercase;">${escapeHtml(item.category)} · ${escapeHtml(item.confidence)}</div>
        <div style="font-weight:700;margin:4px 0;">${escapeHtml(item.subject)}</div>
        <div style="font-size:13px;color:#555;margin-bottom:8px;">From: ${escapeHtml(item.from)}</div>
        <div style="font-size:14px;white-space:pre-wrap;background:#f9f9f9;padding:10px;border-radius:6px;">${escapeHtml(item.draft || '(no draft — spam or skipped)')}</div>
      </div>
    `).join('');

    await sendMail(accessToken, accountId, {
      toAddress: required('DIGEST_TO_EMAIL'),
      subject: `StackBid inbox — ${processedCount} new message(s) triaged`,
      content: `<div style="font-family:sans-serif;max-width:640px;">
        <p>Drafts have been created in the hello@stackbid.app Drafts folder for review. Summary below:</p>
        ${html}
      </div>`,
    });
  }

  console.log(`Done. Processed ${processedCount} message(s) in ${Date.now() - startedAt}ms.`);
}

main().catch(err => {
  console.error('email-agent fatal error:', err);
  process.exit(1);
});

module.exports = { classifyAndDraft, stripHtml, escapeHtml };
