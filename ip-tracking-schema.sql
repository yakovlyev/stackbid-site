-- Отслеживание шаринга доступа (Pro/бесплатной сметы) по IP.
-- Применить через SQL Editor в Supabase.

create table if not exists access_log (
  id bigint generated always as identity primary key,
  email text not null,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists access_log_email_idx on access_log(email);
create index if not exists access_log_created_idx on access_log(created_at);

alter table users add column if not exists suspicious_sharing boolean default false;
alter table users add column if not exists suspicious_sharing_flagged_at timestamptz;

-- access_log — сырой лог: email + IP при каждой проверке доступа.
-- suspicious_sharing — мягкий флаг (НЕ блокирует доступ сам по себе):
-- выставляется автоматически, когда один email за последние 30 дней
-- засветился с более чем 3 разных IP. Ничего не отзывает и не банит —
-- просто отмечает аккаунт для ручного просмотра владельцем продукта.
-- Полноценная верификация email (magic-link/OTP), которая закрыла бы
-- проблему целиком, сознательно отложена — см. заметку в памяти Claude.
