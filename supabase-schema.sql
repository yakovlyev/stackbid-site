-- StackBid Database Schema
-- Вставить целиком в Supabase SQL Editor → Run

-- 1. SUPPLIERS — оптовые поставщики по регионам США
create table if not exists suppliers (
  id          serial primary key,
  name        text not null,
  type        text not null check (type in ('wholesale','retail','local')),
  zip_codes   text[],
  states      text[],
  region      text,
  website     text,
  phone       text,
  active      boolean default true,
  created_at  timestamptz default now()
);

-- 2. CATEGORIES — категории материалов
create table if not exists categories (
  id          serial primary key,
  slug        text unique not null,
  name        text not null,
  icon        text,
  sort_order  int default 0
);

-- 3. MATERIALS — база материалов (топ-200 позиций)
create table if not exists materials (
  id              serial primary key,
  category_id     int references categories(id),
  name            text not null,
  name_short      text,
  sku_hd          text,
  sku_lowes       text,
  unit            text not null,
  specs           text,
  brand           text,
  active          boolean default true,
  created_at      timestamptz default now()
);

-- 4. PRICES — цены по поставщикам (обновляются еженедельно)
create table if not exists prices (
  id              serial primary key,
  material_id     int references materials(id),
  supplier_id     int references suppliers(id),
  price           numeric(10,2) not null,
  unit            text not null,
  region          text,
  state           text,
  zip_range       text,
  valid_from      date default current_date,
  valid_to        date,
  source          text check (source in ('manual','api','scrape')),
  updated_at      timestamptz default now()
);

-- 5. USERS — пользователи (из progressive gate)
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  first_name  text,
  role        text check (role in ('homeowner','contractor','investor','realtor','other')),
  zip         text,
  price_alerts boolean default true,
  created_at  timestamptz default now(),
  last_seen   timestamptz default now()
);

-- 6. ESTIMATES — сохранённые сметы
create table if not exists estimates (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references users(id),
  title         text,
  project_type  text,
  zip           text,
  description   text,
  total_retail  numeric(12,2),
  total_wholesale numeric(12,2),
  total_local   numeric(12,2),
  items         jsonb,
  shared_token  text unique default encode(gen_random_bytes(12),'hex'),
  created_at    timestamptz default now()
);

-- 7. INDEXES для быстрого поиска
create index if not exists idx_prices_material    on prices(material_id);
create index if not exists idx_prices_region      on prices(region);
create index if not exists idx_prices_state       on prices(state);
create index if not exists idx_materials_category on materials(category_id);
create index if not exists idx_estimates_user     on estimates(user_id);
create index if not exists idx_estimates_token    on estimates(shared_token);

-- 8. ROW LEVEL SECURITY
alter table users    enable row level security;
alter table estimates enable row level security;

-- Пользователь видит только свои данные
create policy "users_own" on users
  for all using (auth.uid()::text = id::text);

create policy "estimates_own" on estimates
  for all using (
    user_id in (select id from users where email = auth.email())
  );

-- Цены и материалы — публичные (read only)
create policy "prices_public" on prices
  for select using (true);

create policy "materials_public" on materials
  for select using (true);

create policy "categories_public" on categories
  for select using (true);

create policy "suppliers_public" on suppliers
  for select using (true);

alter table prices     enable row level security;
alter table materials  enable row level security;
alter table categories enable row level security;
alter table suppliers  enable row level security;

-- 9. SUPPLIERS данные
insert into suppliers (name, type, states, region, website) values
('Home Depot',          'retail',    array['ALL'], 'National', 'https://homedepot.com'),
('Lowes',               'retail',    array['ALL'], 'National', 'https://lowes.com'),
('84 Lumber',           'wholesale', array['ALL'], 'National', 'https://84lumber.com'),
('Builders FirstSource','wholesale', array['ALL'], 'National', 'https://buildersfirstsource.com'),
('Menards',             'wholesale', array['IL','WI','MN','IA','MO','KS','NE','SD','ND','MI','IN','OH'], 'Midwest', 'https://menards.com'),
('ABC Supply',          'wholesale', array['ALL'], 'National', 'https://abcsupply.com'),
('ProBuild',            'wholesale', array['ALL'], 'National', 'https://probuild.com'),
('Carter Lumber',       'wholesale', array['OH','PA','WV','KY','MI','IN'], 'Southeast', 'https://carterlumber.com')
on conflict do nothing;

-- 10. CATEGORIES данные
insert into categories (slug, name, icon, sort_order) values
('lumber',      'Framing Lumber',      '🪵', 1),
('sheathing',   'Sheathing & Panels',  '📋', 2),
('roofing',     'Roofing',             '🏠', 3),
('siding',      'Siding & Exterior',   '🏚️', 4),
('concrete',    'Concrete & Masonry',  '⬛', 5),
('insulation',  'Insulation',          '🌡️', 6),
('drywall',     'Drywall',             '🔲', 7),
('fasteners',   'Fasteners & Hardware','🔩', 8),
('windows',     'Windows & Doors',     '🪟', 9),
('electrical',  'Electrical Rough-in', '⚡', 10),
('plumbing',    'Plumbing Rough-in',   '🚿', 11),
('flooring',    'Flooring',            '🟫', 12)
on conflict do nothing;

select 'Schema created successfully! Tables: ' || count(*) from information_schema.tables
where table_schema = 'public';
