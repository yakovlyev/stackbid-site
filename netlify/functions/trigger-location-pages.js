// Захищений тим самим ADMIN_SECRET, що і price-anomalies.js — Ігор
// натискає кнопку на admin-prices.html (той самий збережений localStorage
// ключ), сервер сам генерує сторінки, використовуючи вже налаштовані на
// цьому ж сервісі SUPABASE_SERVICE_ROLE_KEY і ANTHROPIC_API_KEY. Claude
// не потребує знати сам ADMIN_SECRET — просто чекає результату в таблиці.
const crypto = require('crypto');
const { CITIES, PROJECT_TYPES, generatePage } = require('../../location-pages-agent-lib');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://stackbid.app' };

  if (!ADMIN_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_SECRET not configured on server' }) };
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!safeEqual(bearerKey, ADMIN_SECRET)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'invalid admin key' }) };
  }

  // Відповідаємо ОДРАЗУ (як і решта фонових задач цієї ночі) — весь набір
  // 8 міст × web-search займе кілька хвилин, довше за типовий gateway
  // timeout. Прогрес видно прямо в таблиці location_pages по мірі появи
  // нових рядків.
  runInBackground();
  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({
      ok: true,
      status: 'started',
      note: 'Проверяй таблицу location_pages в Supabase через пару минут',
    }),
  };
};

async function runInBackground() {
  for (const type of PROJECT_TYPES) {
    for (const city of CITIES) {
      try {
        const existing = await sb(
          `location_pages?project_type_slug=eq.${type.slug}&city_slug=eq.${city.slug}&select=id`,
        );
        if (existing?.[0]) {
          console.log(`Пропущено (уже есть): ${type.slug}/${city.slug}`);
          continue;
        }
        console.log(`Генерирую: ${type.slug}/${city.slug}...`);
        const page = await generatePage(city, type);
        await sb('location_pages', {
          method: 'POST',
          body: JSON.stringify({
            project_type_slug: type.slug,
            city_slug: city.slug,
            city_name: city.name,
            title: page.title,
            meta_description: page.meta_description,
            price_low: page.price_low,
            price_high: page.price_high,
            content_html: page.content_html,
            faq_json: page.faq,
            status: 'draft',
          }),
        });
        console.log(`✓ ${type.slug}/${city.slug}`);
      } catch (e) {
        console.error(`✗ ${type.slug}/${city.slug}:`, e.message);
      }
    }
  }
  console.log('Location pages generation — все города обработаны.');
}
