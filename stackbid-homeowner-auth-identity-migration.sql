-- Stackbid homeowner Auth identity prerequisite.
-- LOCAL RELEASE ARTIFACT ONLY. Do not apply without the separate BOSS
-- production gate, a read-only schema preflight, backup/rollback readiness,
-- legacy claim plan, staging verification, and controlled runtime read-back.

begin;
set local lock_timeout = '5s';

alter table public.users
  add column if not exists auth_user_id uuid;

-- ADD COLUMN IF NOT EXISTS alone cannot guarantee that a pre-existing column
-- has the required FK, so enforce the named constraint independently.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_auth_user_id_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_auth_user_id_fkey
      foreign key (auth_user_id)
      references auth.users (id)
      on delete set null;
  end if;
end
$$;

create unique index if not exists users_auth_user_id_uq
  on public.users (auth_user_id)
  where auth_user_id is not null;

comment on column public.users.auth_user_id is
  'Canonical Supabase Auth user id. Nullable until a verified claim binds a legacy homeowner row.';

commit;

-- Rollback plan (execute only through a separately approved controlled change,
-- in reverse dependency order):
-- alter table public.users drop constraint if exists users_auth_user_id_fkey;
-- drop index if exists public.users_auth_user_id_uq;
-- alter table public.users drop column if exists auth_user_id;
