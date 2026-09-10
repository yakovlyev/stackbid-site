/**
 * Shared generation logic for programmatic SEO location pages — used by
 * both location-pages-agent.js (manual CLI run) and
 * netlify/functions/trigger-location-pages.js (admin-button trigger from
 * admin-prices.html). Kept in one place so the two callers can never
 * drift into different prompts/city lists.
 */

const CITIES = [
  { slug: 'charlotte-nc', name: 'Charlotte, NC' },
  { slug: 'raleigh-nc', name: 'Raleigh, NC' },
  { slug: 'dallas-tx', name: 'Dallas, TX' },
  { slug: 'houston-tx', name: 'Houston, TX' },
  { slug: 'orlando-fl', name: 'Orlando, FL' },
  { slug: 'tampa-fl', name: 'Tampa, FL' },
  { slug: 'newark-nj', name: 'Newark, NJ' },
  { slug: 'baltimore-md', name: 'Baltimore, MD' },
];

const PROJECT_TYPES = [{ slug: 'roof-replacement', label: 'roof replacement', displayTitle: 'Roof Replacement Cost' }];

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SYSTEM_PROMPT = `You are the SEO content writer for StackBid (stackbid.app), an AI-powered construction cost estimator for US homeowners. You are writing a location-specific cost page for the "Locations" programmatic SEO pattern ("[service] cost in [city]").

Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Use the current year where relevant.

Your job: research REAL, CITY-SPECIFIC cost drivers for this project type in this specific city — local labor rates, climate-driven material choices (e.g. metal roofing more common in hot/hurricane-prone regions, different insulation needs in colder regions), local permit requirements, and typical price ranges — using the web search tool. The page must NOT be a generic template with the city name swapped in; it must contain genuine city-specific information a homeowner in that exact city would find useful and couldn't get from a generic national article.

Rules (same discipline as StackBid's blog articles - this has been violated before, take it seriously):
- Never fabricate statistics, sources, permit fees, or price figures. Every number must come from what you actually found in search.
- If you cite a named organization or source for a claim, you must have actually found that specific claim in search — otherwise state the fact plainly without a fake attribution, or omit it.
- Write in plain, homeowner-friendly English. No AI-sounding phrases ("in today's world", "when it comes to", "it's important to note").
- Structure: a direct-answer opening (state the typical price range for this city in the first 2-3 sentences), then 3-4 sections covering local cost drivers, then a short FAQ (3-4 Q&As).
- Exactly one natural mention of StackBid's free estimate tool as a way to get a project-specific number - link text: "get a free instant estimate", path: "https://stackbid.app/#tool". No other invented internal links.
- Target length: 600-900 words (shorter than the main blog articles — this is a focused location page, not a comprehensive guide).

Response format — your final message must contain NOTHING except a single JSON object, no preamble, no markdown fences:
{
  "title": string (include the city name and current year, e.g. "Roof Replacement Cost in Charlotte, NC (2026)"),
  "meta_description": string (155 characters or fewer),
  "price_low": number (typical low end of the range in USD, whole dollars, from what you found),
  "price_high": number (typical high end of the range in USD, whole dollars, from what you found),
  "content_html": string (the full page body as clean semantic HTML — use <h2>, <h3>, <p>, <ul> — no <html>/<body> wrapper, no inline styles, no <script>),
  "faq": [{"question": string, "answer": string}, ...],
  "sources": [string, ...] (URLs actually used from search)
}`;

async function generatePage(cityObj, typeObj) {
  const userMessage = `City: ${cityObj.name}\nProject type: ${typeObj.label}\n\nResearch this specific city's cost drivers for ${typeObj.label} and write the location page now.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    }),
  });
  if (!res.ok)
    throw new Error(`Anthropic API error for ${cityObj.slug}/${typeObj.slug}: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const rawText = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const page = extractJson(rawText);
  if (!page) throw new Error(`Could not parse JSON for ${cityObj.slug}/${typeObj.slug}. RAW: ${rawText.slice(0, 500)}`);
  return page;
}

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
    } catch {}
  }
  return null;
}

module.exports = { CITIES, PROJECT_TYPES, generatePage, extractJson };
