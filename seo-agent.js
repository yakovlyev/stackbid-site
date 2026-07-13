/**
 * StackBid — SEO Content Agent
 *
 * Раз в несколько дней (Render Cron Job) берёт одну тему из seo_topics,
 * просит Anthropic API исследовать её через web search и написать статью,
 * сохраняет результат как ЧЕРНОВИК в seo_articles — НЕ публикует сама.
 * Дублирующее уведомление уходит на DIGEST_TO_EMAIL через тот же Zoho Mail
 * API, что использует email-agent.js.
 *
 * Требуемые переменные окружения (Render):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REFRESH_TOKEN
 *   ZOHO_ACCOUNT_ID
 *   DIGEST_TO_EMAIL           (stackbid.hello@gmail.com)
 *
 * Требуемые таблицы в Supabase (см. seo-agent-schema.sql):
 *   seo_topics, seo_articles
 */

const MAX_RUNTIME_MS = 5 * 60 * 1000; // тот же жёсткий потолок, что у price-agent/email-agent
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

// ---------- Supabase REST (тот же паттерн, что в email-agent.js) ----------

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

async function getNextTopic() {
  const rows = await supabaseFetch(
    `seo_topics?status=eq.pending&order=priority.desc,created_at.asc&limit=1`
  );
  return rows && rows.length ? rows[0] : null;
}

async function markTopic(id, status) {
  await supabaseFetch(`seo_topics?id=eq.${id}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: JSON.stringify({ status, processed_at: new Date().toISOString() }),
  });
}

async function saveDraft(topic, article) {
  const wordCount = (article.content_markdown || '').split(/\s+/).filter(Boolean).length;
  const rows = await supabaseFetch('seo_articles', {
    method: 'POST',
    body: JSON.stringify({
      topic_id: topic.id,
      title: article.title,
      slug: article.slug,
      meta_description: article.meta_description,
      target_keyword: topic.keyword,
      content_markdown: article.content_markdown,
      faq_json: article.faq || [],
      internal_links: article.internal_links || [],
      sources: article.sources || [],
      word_count: wordCount,
      status: 'draft',
    }),
  });
  return rows[0];
}

// ---------- Zoho Mail API (идентично email-agent.js) ----------

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

async function sendMail(accessToken, accountId, { toAddress, subject, content }) {
  return zohoFetch(accessToken, `accounts/${accountId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ fromAddress: FROM_ADDRESS, toAddress, subject, content }),
  });
}

async function sendDigest(article) {
  try {
    const accessToken = await getZohoAccessToken();
    const accountId = required('ZOHO_ACCOUNT_ID');
    await sendMail(accessToken, accountId, {
      toAddress: required('DIGEST_TO_EMAIL'),
      subject: `[SEO Agent] Новый черновик: ${article.title}`,
      content:
        `Новая статья готова к проверке.<br><br>` +
        `Заголовок: ${article.title}<br>` +
        `Ключевое слово: ${article.target_keyword}<br>` +
        `Слов: ${article.word_count}<br><br>` +
        `Проверить и опубликовать: таблица seo_articles в Supabase, запись со статусом "draft".`,
    });
  } catch (err) {
    console.error('Не удалось отправить дайджест:', err.message);
  }
}

// ---------- Anthropic — исследование + написание статьи ----------

const SYSTEM_PROMPT = `You are the SEO content writer for StackBid (stackbid.app), an AI-powered construction materials cost estimator for US homeowners. Homeowners come to StackBid to get an instant estimate of what a home improvement project should cost, using real material and labor pricing, so they can plan budgets and negotiate with contractors from an informed position. The site's tone is practical and homeowner-friendly, plain English, never salesy or filled with jargon.

Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Write and date the article as current for this point in time — use the current year in the title and body where a year is relevant (e.g. "2026 Cost Guide", not last year). Your web search results will often include pages written in an earlier year with stale pricing; note that explicitly if a source looks outdated, and prefer the most recent data you can find.

Your role is to research a given keyword and write a complete, genuinely useful SEO article that a homeowner searching that phrase would actually want to read, while naturally supporting StackBid's positioning as the tool that gives an instant, accurate cost estimate.

Your goal for each article is to rank well for the target keyword by being the most helpful, accurate, and current answer to the searcher's real question, and to convert a meaningful share of readers into StackBid users through one clear, non-pushy call to action.

Instructions:
- Use the web search tool to check current pricing ranges, recent trends, and what top-ranking competitor content already covers, so the article is accurate and not redundant with what's already out there.
- Write in plain, homeowner-friendly English: short paragraphs, concrete numbers, no filler, no corporate tone, no AI-sounding phrases like "in today's world", "when it comes to", or "it's important to note".
- Structure: a direct-answer opening (answer the core question in the first 2-3 sentences), then supporting sections with real H2 headers, then a short FAQ section (3-5 Q&As) suitable for FAQPage schema.
- Include exactly one natural mention of StackBid as a way to get an instant estimate for the reader's specific project — not a hard sell, not repeated elsewhere.
- Suggest 2-4 internal links to relevant StackBid pages as anchor text plus a plausible URL path (e.g. /estimator, /projects/kitchen-remodel).
- Never fabricate statistics, sources, or figures. Any number you state should come from what you actually found in search, not be invented.
- Target length is 1200-1800 words, unless the topic genuinely does not support that length.

Decision logic:
- If the keyword is too broad or ambiguous to write one focused article, narrow it to the most likely searcher intent rather than trying to cover everything.
- If your research surfaces information that differs from any notes provided with the topic, follow the evidence you found, not the note.

Response format — read this carefully, it is checked by an automated parser:
Your final message must contain NOTHING except a single JSON object. No preamble like "Now I have enough data" or "Let me compile the article", no closing remarks, no markdown code fences around it — just the raw JSON object, starting with { and ending with }.
Do not use <cite> tags, citation markup, or any XML-like tags inside content_markdown — write plain Markdown prose only. If you want to reference where a fact came from, that's what the sources array is for, not inline markup.

{
  "title": string,
  "slug": string (lowercase-with-hyphens),
  "meta_description": string (155 characters or fewer),
  "content_markdown": string (the full article body in plain Markdown, no citation tags),
  "faq": [{"question": string, "answer": string}, ...],
  "internal_links": [{"anchor": string, "path": string}, ...],
  "sources": [string, ...] (URLs you actually used from search)
}`;

async function generateArticle(topic) {
  const userMessage = `Target keyword: "${topic.keyword}"${topic.notes ? `\nNotes/angle: ${topic.notes}` : ''}\n\nResearch this and write the article now.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
  const rawText = textBlocks.join('\n');

  const article = extractJson(rawText);
  if (!article) {
    throw new Error(`Не удалось распарсить JSON-ответ модели.\n\nRAW:\n${rawText.slice(0, 2000)}`);
  }

  // Защита от <cite index="...">...</cite> и подобной разметки, если модель
  // всё же добавила её вопреки инструкции — вырезаем теги, оставляем текст.
  if (typeof article.content_markdown === 'string') {
    article.content_markdown = stripCiteTags(article.content_markdown);
  }

  return article;
}

// Пытается достать JSON тремя способами по очереди: прямой parse, из
// ```json ... ``` блока, и как запасной вариант — от первой { до последней }.
function extractJson(rawText) {
  const attempts = [
    rawText.trim(),
    (rawText.match(/```json\s*([\s\S]*?)```/i) || [])[1],
    (() => {
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      return start !== -1 && end !== -1 && end > start ? rawText.slice(start, end + 1) : null;
    })(),
  ].filter(Boolean);

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // пробуем следующий вариант
    }
  }
  return null;
}

function stripCiteTags(text) {
  return text
    .replace(/<cite[^>]*>/gi, '')
    .replace(/<\/cite>/gi, '')
    .trim();
}

// ---------- Запуск ----------

async function run() {
  console.log('SEO Content Agent: старт');

  const topic = await getNextTopic();
  if (!topic) {
    console.log('Нет тем со статусом pending в seo_topics. Нечего делать.');
    return;
  }

  console.log('Взята тема:', topic.keyword);
  await markTopic(topic.id, 'processing');

  if (timeLeft() < 30 * 1000) {
    console.log('Слишком мало времени осталось, возвращаю тему в очередь.');
    await markTopic(topic.id, 'pending');
    return;
  }

  try {
    const article = await generateArticle(topic);
    const saved = await saveDraft(topic, article);
    await markTopic(topic.id, 'done');
    await sendDigest(saved);
    console.log('Готово. Черновик сохранён:', saved.title);
  } catch (err) {
    console.error('Ошибка при обработке темы:', err.message);
    await markTopic(topic.id, 'pending');
    throw err;
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
