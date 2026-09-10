-- Крок 1 з майбутньої заміни email-only авторизації контракторів на
-- справжній Supabase Auth (magic link). Це ЄДИНИЙ безпечний перший
-- шматок — сама колонка нічим не користується, поки не написана логіка
-- логіну/прив'язки. Повністю зворотно: DROP COLUMN contractors.auth_user_id
-- прибирає її без жодних наслідків, бо ніхто ще її не читає й не пише.
alter table contractors
  add column if not exists auth_user_id uuid null references auth.users(id);

create unique index if not exists contractors_auth_user_id_uq
  on contractors(auth_user_id)
  where auth_user_id is not null;
