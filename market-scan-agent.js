/**
 * StackBid — Weekly Market Scan Agent
 *
 * Раз в неделю (Render Cron Job) ищет актуальные бесплатные рекламные
 * издания США по теме home improvement (Val-Pak, Money Mailer, местные
 * купонные буклеты, стойки в супермаркетах и т.п. — тот же жанр, что
 * бумажный Home Improvement Guide, просто не привязано к одному
 * конкретному изданию/формату) и собирает реальные паттерны: какие
 * категории услуг рекламируют, какие офферы/скидки в ходу, какие
 * trust-сигналы используют (бейджи, годы в бизнесе, гарантии).
 *
 * ВАЖНО: результаты НЕ применяются на сайт автоматически — пишутся в
 * market_scan_log для ручного разбора в следующей сессии. Автономная
 * правка публичного текста лендинга без проверки — тот же риск, что
 * уже ловили сегодня (выдуманные отзывы, несуществующий закон о ценах);
 * агент только исследует и собирает, решение — при разборе вместе.
 *
 * Требуемые переменные окружения (Render):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const SYSTEM_PROMPT = `You are a market research agent for StackBid, a US construction materials/labor cost estimator. Your job: find CURRENT, REAL free-distribution home-improvement advertising publications in the US — weekly/monthly coupon books, direct-mail flyers, supermarket rack publications (e.g. Val-Pak, Money Mailer, local "Home Improvement Guide"-style magazines, Val-U-Pak, SuperCoups) — and extract real patterns from them.

For each search, look for:
- What service categories they advertise most (roofing, siding, decks, masonry, windows, etc.)
- What kinds of offers/discounts are common right now (dollar-off, percent-off, financing terms, senior/veteran discounts)
- What trust signals contractors use (years in business, BBB rating, manufacturer certifications, license display, review counts)
- Any notable messaging patterns (urgency, QR code CTAs, phone-first vs QR-first)

Rules:
- Only report things you can find real evidence for via search — never invent a publication, a company, or a specific offer.
- Cite the source (publication name, or the specific search result) for every finding.
- If a search turns up nothing useful, say so — do not pad findings with guesses.
- This is market research, not content to publish — be factual and specific, not promotional.

Return your findings as a JSON array, each item: { "category": string, "pattern": string, "source": string, "evidence": string }
Return ONLY the JSON array, no other text.`;

async function callClaudeWithSearch(userPrompt) {
  const messages = [{ role: 'user', content: userPrompt }];
  let finalText = '';

  for (let turn = 0; turn < 6; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });
    const data = await res.json();
    if (data.type === 'error') throw new Error(data.error?.message || 'Claude API error');

    const toolUses = (data.content || []).filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use');
    const textBlocks = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    finalText = textBlocks || finalText;

    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      break; // Claude закончила — web_search обрабатывается сервером Anthropic автоматически
    }
    messages.push({ role: 'assistant', content: data.content });
    // web_search — server-side tool, Anthropic сам выполняет поиск и возвращает
    // результат в истории; просто продолжаем цикл, передавая content обратно.
    messages.push({ role: 'user', content: 'Continue.' });
  }
  return finalText;
}

async function logFindings(SUPABASE_URL, SUPABASE_KEY, findings) {
  await fetch(`${SUPABASE_URL}/rest/v1/market_scan_log`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ findings }),
  });
}

exports.handler = async () => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_KEY = required('SUPABASE_SERVICE_ROLE_KEY');

  const queries = [
    'this week\'s home improvement coupon flyer roofing siding deals current offers',
    'Val-Pak Money Mailer home improvement contractor coupons current',
    'local home improvement guide magazine current issue contractor advertising',
  ];

  const allFindings = [];
  for (const q of queries) {
    try {
      const text = await callClaudeWithSearch(
        `Search for: "${q}". Find real, current examples. Return findings as the JSON array described in your instructions.`
      );
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        allFindings.push(...parsed);
      }
    } catch (e) {
      console.error(`Search failed for "${q}":`, e.message);
    }
  }

  if (allFindings.length > 0) {
    await logFindings(SUPABASE_URL, SUPABASE_KEY, allFindings);
    console.log(`Logged ${allFindings.length} finding(s).`);
  } else {
    console.log('No findings this run.');
  }
};

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Позволяет запускать вручную: node market-scan-agent.js
if (require.main === module) {
  exports.handler().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
