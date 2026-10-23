# StackBid — контекст проекта для Claude Code

Этот файл — справочник для Claude при работе с этим репозиторием. Читай его в начале каждой сессии.

## Что за проект

**StackBid** (stackbid.app) — AI-powered оценщик оптовых цен на строительные материалы для американских домовладельцев (homeowners). Основатель — Игорь (Ukraine-based, общается по-русски), сын Максим (US-based, handles US/IP-зависимые задачи), плюс исполнитель (женщина, занимается загрузкой файлов/операционкой).

**Модель продукта:** три ценовые колонки — retail (Home Depot/Lowe's) / wholesale estimate (~25% дешевле) / local supplier by ZIP. Бесплатно для homeowners. Монетизация: контракторы Pro ($49-149/мес за лиды) + партнёрские комиссии (Impact.com).

**Долгосрочная цель:** ContentFabrica — полный AI-агентный контент-конвейер (Strategy → Production → SEO → Multichannel → Multilingual → Analytics → Monetization → Funnels). Всё должно строиться "агент-ready" с самого начала — API вместо ручных UI-флоу, чтобы не переписывать потом.

## Технологический стек

- **Backend:** Node.js (`server.js`) на Render
- **DB:** Supabase (project `xbxknpsqecwahxzwsvpt`) — таблицы: suppliers, categories, materials (64 позиции), prices (81+), users, estimates, price_update_log
- **Email:** Resend (домен stackbid.app полностью верифицирован — MX, DKIM, SPF)
- **AI:** Anthropic API (сметы + price-agent)
- **Repo:** `yakovlyev/stackbid-site` на GitHub
- **Деплой:** через Render (не Netlify — там были проблемы с build credits; netlify/functions/ есть в репо, но не используется)
- **Важно:** `.yarnrc` с `--ignore-engines true` обязателен для Render-сборки (supabase/functions-js требует Node ≥22, Render дефолтил на Node 20)

## Текущий статус (на 23.10.2026)

Подробный статус по запускам, агентам и блокерам ведётся в памяти проекта и в репозитории `hermes-artifact-handoff` (review/). Здесь только то, что нужно знать при правке кода.

### Работает
- Лендинг `index.html` (EN) и `es.html` (ES): canonical + hreflang, JSON-LD (SoftwareApplication, Organization с sameAs, FAQPage), `llms.txt`, `sitemap.xml`, `robots.txt`; блог `/blog` рендерится из `server.js`.
- Freemium: первая смета бесплатно, далее подписка Homeowner Pro $9.99/мес (Stripe live ждёт LLC). Contractor Pro $49, Handyman $29, 30 дней бесплатно.
- GA4 `G-FRXYX65KWN`: события estimate_started / estimate_unlocked / estimate_gate_skipped и (с 23.10) делегированные клики по CTA, формам, экспорту, подписке, mailto и внешним ссылкам — один скрипт перед `</body>` в обеих страницах.
- Агенты на Render (cron): price, seo, market-scan, community-content, analytics, email (пауза автоответов с 14.10), video-poster (приостановлен), location-pages. Node 24 указан в `package.json`.
- Контактный email: `hello@stackbid.app`. Соцсети: Instagram stackbid1, TikTok stackbid, YouTube @stackbid, X StackBid1, Reddit u/StackBid, Threads, Pinterest, Facebook.

### Открытые пункты
- Google Search Console: подтверждение сайта (meta-тег) ещё не добавлен.
- Cookie-баннер/согласие: макет на утверждении у Игоря.
- LLC → Stripe live и верификация WhatsApp; Apple Developer; Render платный план для stackbid-app (сейчас free, засыпает); USPS PO Box для рассылки; адрес для GBP/Houzz.
- Страницы по локациям: первая партия через кнопку в `admin-prices.html` после утверждения образца.

## Инструменты разработки (добавлено 07.07.2026)

- **biome** — линтинг + форматирование (`npm run lint`, `npm run lint:fix`). Конфиг: `biome.json`
- **vitest** — тесты (`npm test`). Первый реальный тест: `price-agent.test.js` — покрывает `evaluatePriceChange()` (детект аномалий цен), 7 тестов
- **Dependabot** — авто-PR на уязвимости в зависимостях, конфиг `.github/dependabot.yml`, еженедельно
- **Важно:** `price-agent.js` теперь экспортирует `evaluatePriceChange` через `module.exports`, а вызов `main()` обёрнут в `if (require.main === module)` — это специально, чтобы `require()` файла в тестах не запускал реальный агент (баг, который сразу поймали и починили при первой установке vitest)
- **Осознанно НЕ установлено сейчас** (см. обсуждение с Игорем 07.07.2026): TypeScript/tsc (требует миграции всего кода), husky/lint-staged (git-хуки не сработают при пуше через GitHub API, актуально станет при переходе на Claude Code с локальным git), gitleaks (Go-бинарник/Action, не npm-пакет — та же проблема со scope `workflow`, что и раньше), pino (требует переписать все `console.log`, делать постепенно), semgrep/fast-check/playwright/clinic.js/semantic-release (ситуативные, не нужны на этом этапе проекта)

## Соглашения и важные детали

- **Официальный контактный email:** `hello@stackbid.app` (Zoho Mail alias на yakovlyev@stackbid.app, настроено 07.07.2026). Использовать везде в коде/контенте — НЕ `stackbid.hello@gmail.com` или `stackbid.app@gmail.com` (старые адреса, полностью выведены из употребления 07.07.2026).

- **GitHub API workflow-ограничение:** нельзя пушить файлы в `.github/workflows/` через API токеном без явного scope `workflow` (текущий токен имеет только `repo`) — поэтому автоматизация price-agent сделана через Render Cron (render.yaml), а не GitHub Actions
- **Все GitHub API PUT-запросы** требуют свежий SHA файла перед каждым коммитом
- **Копирайт:** никогда не хардкодить цены-заглушки — цены либо из Supabase (fallback), либо из AI-агента (приоритет). Коммит `ee0ea2e` зафиксировал это поведение
- **Игорь работает много с телефона** и общается голосовым вводом на русском — транскрипция иногда даёт мусор в сообщениях, если что-то не имеет смысла, лучше переспросить, а не гадать
- **Стиль коммуникации:** прямой, без лишней преамбулы, по существу; Игорь ценит автономность и предпочитает, чтобы Claude сам принимал решения там, где это разумно, а не переспрашивал по мелочам

## Где искать дальнейший контекст

Если нужны детали, не покрытые здесь — спроси Игоря напрямую про конкретный аспект (Make.com сценарий, ценообразование, GEO-стратегию, анимационный сериал StackBid и т.д.) — часть решений принималась в разговоре и не всегда отражена в коде дословно.
