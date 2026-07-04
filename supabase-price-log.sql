-- StackBid — таблица логирования еженедельного обновления цен агентом
-- Запустить в Supabase SQL Editor отдельно (DDL)

create table if not exists price_update_log (
  id              serial primary key,
  material_id     int references materials(id),
  old_price       numeric(10,2),
  new_price       numeric(10,2),
  percent_change  numeric(6,2),
  flagged_anomaly boolean default false,
  source_note     text,
  run_id          text,
  created_at      timestamptz default now()
);

create index if not exists idx_price_log_material on price_update_log(material_id);
create index if not exists idx_price_log_created on price_update_log(created_at);
