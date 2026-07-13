-- SEO Content Agent — таблицы Supabase
-- Применить через SQL Editor в Supabase (тот же проект, что у StackBid)

-- Очередь тем/ключевых слов. Игорь/Максим добавляют сюда строки вручную
-- (или через будущий простой интерфейс), агент сам их разбирает по одной.
create table if not exists seo_topics (
  id uuid primary key default gen_random_uuid(),
  keyword text not null,              -- целевой запрос, напр. "cost to replace roof"
  notes text,                          -- необязательный контекст/угол подачи
  priority int default 0,              -- чем выше, тем раньше возьмёт агент
  status text default 'pending',       -- pending | processing | done | skipped
  created_at timestamptz default now(),
  processed_at timestamptz
);

-- Сгенерированные статьи — ВСЕГДА черновики, публикация вручную.
create table if not exists seo_articles (
  id uuid primary key default gen_random_uuid(),
  topic_id uuid references seo_topics(id),
  title text,
  slug text,
  meta_description text,
  target_keyword text,
  content_markdown text,
  faq_json jsonb,                      -- массив {question, answer} для FAQPage schema
  internal_links jsonb,                -- массив {anchor, url} — ссылки на разделы StackBid
  sources jsonb,                       -- массив URL, использованных при research (для проверки)
  word_count int,
  status text default 'draft',         -- draft | approved | published | rejected
  created_at timestamptz default now()
);

create index if not exists idx_seo_topics_status on seo_topics(status);
create index if not exists idx_seo_articles_status on seo_articles(status);
