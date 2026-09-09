-- Таблиця для логування обмінів з Nika (asssistant.js) — потрібна
-- Ника-Ревізору (nika-reviewer.js) для перевірки на вигадані ціни,
-- обіцянки гарантій, пропущені уточнюючі питання і т.п.
--
-- ВАЖЛИВО: не містить email/PII користувача — тільки текст питання,
-- відповіді, ZIP (не адреса) і мову. RLS вимкнено для anon/authenticated
-- повністю (тільки service_role пише і читає) — таблиця не призначена
-- для публічного або клієнтського доступу.
create table if not exists nika_conversations (
  id bigint generated always as identity primary key,
  question text,
  response text,
  zip text,
  lang text default 'en',
  voice boolean default false,
  reviewed_at timestamptz,
  review_flags jsonb,
  created_at timestamptz not null default now()
);

alter table nika_conversations enable row level security;
-- Жодних policy для anon/authenticated не додаємо навмисно — за
-- замовчуванням це deny-all, доступ лишається тільки в service_role
-- (яким ходять assistant.js і nika-reviewer.js), як і задумано.
