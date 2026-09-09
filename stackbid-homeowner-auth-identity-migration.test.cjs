const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sql = fs.readFileSync(new URL('./stackbid-homeowner-auth-identity-migration.sql', `file://${__dirname}/`), 'utf8');

test('migration is transactional and bounded by a local lock timeout', () => {
  assert.match(sql, /begin\s*;/i);
  assert.match(sql, /set\s+local\s+lock_timeout\s*=\s*'5s'/i);
  assert.match(sql, /commit\s*;/i);
});

test('adds only nullable public.users.auth_user_id uuid', () => {
  assert.match(sql, /alter table public\.users\s+add column if not exists auth_user_id uuid/i);
  assert.doesNotMatch(sql, /auth_user_id\s+uuid\s+not null/i);
  assert.doesNotMatch(sql, /public\.contractors/i);
});

test('idempotently enforces auth.users foreign key with ON DELETE SET NULL', () => {
  assert.match(sql, /pg_constraint/i);
  assert.match(sql, /users_auth_user_id_fkey/i);
  assert.match(sql, /references auth\.users\s*\(id\)\s*on delete set null/i);
});

test('uses a partial unique index for linked identities', () => {
  assert.match(sql, /create unique index if not exists users_auth_user_id_uq/i);
  assert.match(sql, /on public\.users\s*\(auth_user_id\)\s*where auth_user_id is not null/i);
});

test('does not mutate or auto-bind legacy data', () => {
  assert.doesNotMatch(sql, /\bupdate\s+public\.users/i);
  assert.doesNotMatch(sql, /\binsert\s+into/i);
});

test('contains explicit reverse-order rollback commands', () => {
  assert.match(sql, /rollback plan/i);
  assert.match(sql, /drop constraint if exists users_auth_user_id_fkey/i);
  assert.match(sql, /drop index if exists public\.users_auth_user_id_uq/i);
  assert.match(sql, /drop column if exists auth_user_id/i);
});
