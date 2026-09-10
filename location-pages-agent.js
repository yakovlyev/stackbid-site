/**
 * StackBid — Location Pages Generator (Programmatic SEO), CLI version.
 *
 * Одноразовий CLI-скрипт (не крон) — та сама логіка, що і в
 * netlify/functions/trigger-location-pages.js (кнопка на admin-prices.html),
 * винесена в location-pages-agent-lib.js, щоб не дублювати.
 *
 * Потрібні змінні оточення: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */

const { CITIES, PROJECT_TYPES, generatePage, extractJson } = require('./location-pages-agent-lib');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${required('SUPABASE_URL')}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function run() {
  console.log('Location Pages Generator — старт');
  let created = 0;
  for (const type of PROJECT_TYPES) {
    for (const city of CITIES) {
      const existing = await supabaseFetch(
        `location_pages?project_type_slug=eq.${type.slug}&city_slug=eq.${city.slug}&select=id`,
      );
      if (existing?.[0]) {
        console.log(`Пропущено (уже есть): ${type.slug}/${city.slug}`);
        continue;
      }
      console.log(`Генерирую: ${type.slug}/${city.slug}...`);
      const page = await generatePage(city, type);
      await supabaseFetch('location_pages', {
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
      created += 1;
      console.log(
        `✓ ${type.slug}/${city.slug} — $${page.price_low}-${page.price_high}, ${page.sources?.length || 0} источников`,
      );
    }
  }
  console.log(`Готово. Создано ${created} новых страниц (статус draft, ждут проверки в Supabase перед публикацией).`);
}

module.exports = { CITIES, PROJECT_TYPES, extractJson };

if (require.main === module) {
  run().catch((err) => {
    console.error('Location Pages Generator впав:', err);
    process.exit(1);
  });
}
