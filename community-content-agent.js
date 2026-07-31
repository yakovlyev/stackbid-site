/**
 * StackBid — Community Content Agent
 *
 * Раз в день (Render Cron Job) собирает реальные сигналы (агрегаты из
 * estimates, находки price-agent, находки market-scan-agent), и для каждого
 * активного community_profiles пишет ОДИН черновик текста под голос именно
 * этого сообщества — сохраняет в community_content_queue со статусом
 * 'draft'. НИКОГДА никуда не постит и не публикует сама.
 *
 * Почему draft-only жёстко, без опции "включить автопостинг" (в отличие от
 * email-agent, который автономен по прямому решению Игоря): большинство
 * Reddit-сабов и Facebook-групп банят аккаунты за бот-поведение и явную
 * рекламу — automated posting здесь рискует репутацией домена и аккаунтов,
 * а не только "лишним шагом". Постит вживую человек, из своего аккаунта,
 * после ревью очереди.
 *
 * Требуемые переменные окружения (Render):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN / ZOHO_ACCOUNT_ID
 *   DIGEST_TO_EMAIL
 *
 * Требуемые таблицы (см. community-content-schema.sql):
 *   community_profiles, community_content_queue
 */

const MAX_RUNTIME_MS = 5 * 60 * 1000;
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

// ---------- Supabase REST (тот же паттерн, что в seo-agent.js) ----------

async function supabaseFetch(path, options = {}) {
  const url = `${required('SUPABASE_URL')}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
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

// ---------- Собираем РЕАЛЬНЫЕ сигналы (никаких придуманных цифр) ----------

async function gatherSignals() {
  const signals = [];

  // 1. Агрегат за последние 7 дней из реальных estimates — самый честный
  // источник, потому что это данные наших собственных пользователей.
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const recent = await supabaseFetch(
    `estimates?select=project_type,zip,total_retail,total_local&created_at=gte.${since}&limit=200`
  );
  if (recent && recent.length >= 5) {
    const counts = {};
    for (const r of recent) {
      counts[r.project_type] = (counts[r.project_type] || 0) + 1;
    }
    const topType = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topType) {
      signals.push({
        source: 'estimates_aggregate',
        summary: `За последние 7 дней самый частый тип проекта в реальных сметах StackBid: "${topType[0]}" (${topType[1]} из ${recent.length} смет). Использовать как честный, ненавязчивый повод для темы — НЕ как маркетинговую статистику "все ремонтируют X", а как личное наблюдение/вопрос к сообществу.`,
      });
    }
  }

  // 2. Последние находки market-scan-agent (см. market-scan-agent.js) —
  // используем как повод для темы, а не как рекламу конкретного издания.
  const scans = await supabaseFetch(`market_scan_log?select=*&order=created_at.desc&limit=3`).catch(() => null);
  if (scans && scans.length) {
    signals.push({
      source: 'market_scan',
      summary: `Недавние market-scan находки (для контекста темы, не для прямого упоминания): ${scans.map((s) => s.summary || s.title || JSON.stringify(s)).join(' | ')}`,
    });
  }

  return signals;
}

// ---------- Генерация одного черновика под конкретное community ----------

const SYSTEM_PROMPT = `Ты пишешь ОДИН короткий текстовый пост/комментарий для конкретного онлайн-сообщества от имени человека (владельца StackBid), не бренда.

ЖЁСТКИЕ ПРАВИЛА:
- Никогда не выдумывай статистику, отзывы, цифры — используй только переданный реальный сигнал.
- Никогда не пиши в рекламном тоне. Это должно читаться как настоящий человек, а не как маркетинг.
- Упоминай StackBid не более одного раза и только если это органично для контекста поста — не в каждом черновике это обязательно.
- Следуй tone_notes и posting_rules именно этого сообщества буквально.
- Никаких превосходных степеней ("лучший", "№1"), никаких упоминаний реальных сторонних компаний в негативном или сравнительном ключе.
- Длина: 2-5 предложений, если это Reddit-комментарий; до 8 предложений для Facebook-групп.

Верни ТОЛЬКО сам текст поста, без преамбулы, без кавычек, без markdown-заголовков.`;

async function generateDraft(community, signal) {
  const segmentContext = community.segment === 'pro_recruitment'
    ? 'Эта аудитория — сами хендимены/контракторы, не домовладельцы. ЦЕЛЬ — узнаваемость, но с конкретным крючком: у StackBid лид достаётся ОДНОМУ подрядчику, а не продаётся сразу нескольким конкурентам, и цена фиксированная в месяц, а не за каждый лид отдельно — это реальное отличие от типичных лид-платформ, о которых у мастеров обычно плохой опыт. Плюс тот же доступ к оптовым/локальным ценам на материалы, что видит клиент. НЕ называть конкурентов по имени — просто "в отличие от типичных лид-сервисов, где один запрос продают нескольким подрядчикам". Дружелюбно, без давления, но с этим конкретным фактом, не абстрактно.'
    : 'Эта аудитория — домовладельцы. Тема про экономию/понимание стоимости их собственного проекта.';

  const userMessage = `Сообщество: ${community.name} (${community.platform})
Сегмент аудитории: ${community.segment || 'homeowner_demand'} — ${segmentContext}
Тон/стиль: ${community.tone_notes || 'нет заметок'}
Правила размещения: ${community.posting_rules || 'нет заметок'}

Реальный сигнал для темы: ${signal.summary}

Напиши один черновик поста.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': required('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return text;
}

// ---------- Email-дайджест (переиспользуем Zoho-механизм email-agent.js) ----------

async function sendDigest(draftsCreated) {
  if (!draftsCreated.length) return;
  const digestToEmail = process.env.DIGEST_TO_EMAIL;
  if (!digestToEmail) return; // не настроено — просто пропускаем, не падаем

  const listHtml = draftsCreated
    .map((d) => `<li><b>${d.communityName}</b>: ${d.draftText.slice(0, 200)}${d.draftText.length > 200 ? '…' : ''}</li>`)
    .join('');

  // Переиспользуем тот же паттерн Zoho Mail API, что в email-agent.js —
  // намеренно не дублирую здесь OAuth-обмен токена, он там уже реализован
  // как отдельная переиспользуемая функция; см. email-agent.js sendViaZoho().
  console.log(`Digest would be sent to ${digestToEmail}: ${draftsCreated.length} new drafts.`);
  console.log(listHtml);
  // TODO: подключить реальный вызов sendViaZoho() из email-agent.js когда
  // будем разворачивать этого агента на Render — сейчас оставлено явным
  // логом, чтобы не дублировать функцию вслепую без общего модуля.
}

// ---------- Main ----------

async function run() {
  console.log('Community Content Agent — старт');

  const communities = await supabaseFetch(`community_profiles?select=*&active=eq.true`);
  if (!communities || !communities.length) {
    console.log('Нет активных community_profiles — нечего генерировать.');
    return;
  }

  const signals = await gatherSignals();
  if (!signals.length) {
    console.log('Нет свежих реальных сигналов за этот запуск — черновики не генерируются (лучше пропустить день, чем выдумать повод).');
    return;
  }

  const draftsCreated = [];

  for (const community of communities) {
    if (timeLeft() < 15000) {
      console.log('Приближаемся к лимиту времени, останавливаемся раньше.');
      break;
    }
    // Берём самый релевантный сигнал (пока — первый; можно усложнить позже)
    const signal = signals[0];
    try {
      const draftText = await generateDraft(community, signal);
      if (!draftText) continue;

      await supabaseFetch('community_content_queue', {
        method: 'POST',
        body: JSON.stringify({
          community_id: community.id,
          signal_source: signal.source,
          signal_summary: signal.summary,
          draft_text: draftText,
          status: 'draft',
        }),
      });

      draftsCreated.push({ communityName: community.name, draftText });
      console.log(`Черновик создан для ${community.name}`);
    } catch (err) {
      console.error(`Ошибка генерации для ${community.name}:`, err.message);
    }
  }

  await sendDigest(draftsCreated);
  console.log(`Готово. Создано черновиков: ${draftsCreated.length}`);
}

run().catch((err) => {
  console.error('Community Content Agent упал:', err);
  process.exit(1);
});
