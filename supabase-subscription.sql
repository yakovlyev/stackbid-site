-- StackBid — миграция: поля для модели "первая смета бесплатно, далее подписка"
-- Запустить в Supabase SQL Editor

alter table users add column if not exists free_estimate_used boolean default false;
alter table users add column if not exists is_pro boolean default false;
alter table users add column if not exists pro_since timestamptz;
alter table users add column if not exists stripe_customer_id text;
