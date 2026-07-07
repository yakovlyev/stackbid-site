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

## Текущий статус (на 06.07.2026)

### Готово и работает
- Лендинг (`index.html`) с FAQ-секцией (8 вопросов) + FAQPage JSON-LD schema (GEO) + `llms.txt` в корне
- Make.com сценарий (ID 5571686, "Integration Google Drive, YouTube") — Google Drive (watch folder "StackBid Videos" на stackbid.app@gmail.com) → Google Drive (download) → YouTube (upload) → Facebook Pages (upload a video, ИСПРАВЛЕНО с текстового поста) → HTTP module (X через Buffer API, т.к. нативный X-коннектор в Make устарел с мая 2025)
- Instagram @stackbid1 успешно привязан к Facebook Page StackBid (Connected assets подтверждено)
- `price-agent.js` — Node-скрипт, использует Anthropic API + web_search, раз в неделю обновляет цены материалов, валидирует аномалии >30% (не применяет автоматически, логирует), пишет в Supabase
- `render.yaml` обновлён — добавлен Cron Job сервис `stackbid-price-agent` (расписание "0 9 * * 1", каждый понедельник)
- `supabase-price-log.sql` — SQL для таблицы `price_update_log`

### В процессе / известные проблемы
- **Make.com сценарий:** после пересборки модуля Facebook Pages (удалили/пересоздали для смены действия с "Create a Post" на "Upload a Video") возникла ошибка "references inaccessible module" — связи между модулями 8 (Google Drive Download) → 9 (YouTube) и 12 (Facebook Pages) нужно пересоздать вручную (открыть поле Data в каждом модуле, заново выбрать переменную из выпадающего списка, не оставлять как есть)
- **price-agent.js активация** — ждёт 2 ручных шага от Игоря: (1) выполнить `supabase-price-log.sql` в Supabase SQL Editor, (2) добавить 5 env vars в Render Dashboard для сервиса `stackbid-price-agent`: `ANTHROPIC_API_KEY` (новый ключ с console.anthropic.com), `SUPABASE_URL` (https://xbxknpsqecwahxzwsvpt.supabase.co), `SUPABASE_SERVICE_ROLE_KEY` (НЕ anon key), `RESEND_API_KEY`, `ALERT_EMAIL`
- **Impact.com Marketplace** — заявка (StackBid Materials, ID 7454757) отклонена официально 05.07.2026 (недостаточно трафика). Решение: не переподавать сейчас, ждать 1-1.5 месяца роста контента/трафика
- **Монетизация homeowners** — решение принято: НЕ делать обязательную подписку на входе. Freemium: первая смета бесплатно (крючок для вирусности/GEO), Pro $9.99/мес для сохранения истории/price alerts/приоритетного матчинга с контракторами/расширенного PDF. Основная монетизация — не подписка homeowners, а контракторы Pro + affiliate

## Соглашения и важные детали

- **GitHub API workflow-ограничение:** нельзя пушить файлы в `.github/workflows/` через API токеном без явного scope `workflow` (текущий токен имеет только `repo`) — поэтому автоматизация price-agent сделана через Render Cron (render.yaml), а не GitHub Actions
- **Все GitHub API PUT-запросы** требуют свежий SHA файла перед каждым коммитом
- **Копирайт:** никогда не хардкодить цены-заглушки — цены либо из Supabase (fallback), либо из AI-агента (приоритет). Коммит `ee0ea2e` зафиксировал это поведение
- **Игорь работает много с телефона** и общается голосовым вводом на русском — транскрипция иногда даёт мусор в сообщениях, если что-то не имеет смысла, лучше переспросить, а не гадать
- **Стиль коммуникации:** прямой, без лишней преамбулы, по существу; Игорь ценит автономность и предпочитает, чтобы Claude сам принимал решения там, где это разумно, а не переспрашивал по мелочам

## Где искать дальнейший контекст

Если нужны детали, не покрытые здесь — спроси Игоря напрямую про конкретный аспект (Make.com сценарий, ценообразование, GEO-стратегию, анимационный сериал StackBid и т.д.) — часть решений принималась в разговоре и не всегда отражена в коде дословно.
