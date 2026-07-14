-- Stripe Pro subscription — дополнения к таблице users
-- Применить через SQL Editor в Supabase (тот же проект StackBid)

alter table users add column if not exists stripe_customer_id text;
alter table users add column if not exists stripe_subscription_id text;
alter table users add column if not exists pro_since timestamptz;

-- stripe_customer_id / stripe_subscription_id — нужны, чтобы webhook мог
-- находить пользователя по событиям Stripe (Customer Portal, отмена подписки
-- и т.д.) и чтобы не создавать нового Stripe Customer на каждый чек-аут.
-- is_pro и pro_since уже существуют в таблице (использовались check-access.js
-- и раньше как ручные/тестовые поля) — теперь их будет выставлять webhook
-- автоматически по реальным событиям оплаты.
