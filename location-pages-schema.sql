-- Таблиця для programmatic SEO сторінок "скільки коштує [робота] в [місті]".
-- Той самий патерн, що і seo_articles для /blog — контент генерується один
-- раз (script нижче), зберігається тут, сервер віддає швидко без повторних
-- викликів Anthropic на кожен перегляд сторінки.
create table if not exists location_pages (
  id bigint generated always as identity primary key,
  project_type_slug text not null,      -- напр. 'roof-replacement'
  city_slug text not null,               -- напр. 'charlotte-nc'
  city_name text not null,               -- напр. 'Charlotte, NC'
  title text not null,
  meta_description text not null,
  price_low integer,
  price_high integer,
  content_html text not null,            -- унікальний контент, не шаблон зі
                                          -- заміненими змінними (вимога
                                          -- programmatic-seo skill)
  faq_json jsonb,
  status text not null default 'draft',  -- 'draft' до ручної перевірки Ігорем,
                                          -- 'published' коли готово йти в indexation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_type_slug, city_slug)
);

alter table location_pages enable row level security;
-- anon може читати тільки опубліковані сторінки (для самого сайту), не
-- чернетки — той самий підхід, що і з seo_articles.
create policy "location_pages_public_read" on location_pages
  for select using (status = 'published');
