-- Потрібна для review-request-agent.js, щоб не слати запит на відгук
-- одному й тому ж домовласнику щодня. Один nullable стовпець, не нова
-- таблиця — мінімальна зміна схеми, але все одно потребує запуску в
-- продакшн Supabase, тому чекає на дозвіл (той самий гейт, що і всі
-- зміни схеми цієї ночі).
alter table contractor_leads
  add column if not exists review_requested_at timestamptz;
