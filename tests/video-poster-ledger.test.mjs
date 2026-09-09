import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import ledger from '../video-poster-ledger.js';

test('requestIdForDriveFile is stable and UUID-shaped', () => {
  const first = ledger.requestIdForDriveFile('drive-file-123');
  const second = ledger.requestIdForDriveFile('drive-file-123');

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('lookupUpload returns null when Upload-Post has no matching request', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 404,
    async json() { return { status: 'not_found' }; },
  });

  const result = await ledger.lookupUpload('request-1', 'api-key', fetchImpl);

  assert.equal(result, null);
});

test('lookupUpload returns an existing upload record', async () => {
  const record = { status: 'completed', request_id: 'request-1' };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() { return record; },
  });

  const result = await ledger.lookupUpload('request-1', 'api-key', fetchImpl);

  assert.deepEqual(result, record);
});

test('lookupUpload fails closed on authentication or provider errors', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    async json() { return { error: 'unauthorized' }; },
  });

  await assert.rejects(
    ledger.lookupUpload('request-1', 'api-key', fetchImpl),
    /401/,
  );
});

test('selectRecentDriveFiles excludes backlog and keeps all recent files oldest-first', () => {
  const now = Date.parse('2026-09-09T12:00:00Z');
  const files = [
    { id: 'old', createdTime: '2026-09-09T10:00:00Z' },
    { id: 'newer', createdTime: '2026-09-09T11:50:00Z' },
    { id: 'older-recent', createdTime: '2026-09-09T11:40:00Z' },
    { id: 'undated' },
  ];

  const selected = ledger.selectRecentDriveFiles(files, now, 30);

  assert.deepEqual(selected.map((file) => file.id), ['older-recent', 'newer']);
});

test('submissionIdentity gives one Drive file one retry-safe identity', () => {
  const identity = ledger.submissionIdentity('drive-file-123');

  assert.equal(identity.requestId, ledger.requestIdForDriveFile('drive-file-123'));
  assert.equal(identity.externalId, `stackbid:${identity.requestId}`);
  assert.equal(identity.idempotencyKey, identity.requestId);
});

test('findFirstUnsubmitted skips delivered files without starving the next file', async () => {
  const files = [{ id: 'already-delivered' }, { id: 'new-file' }];
  const lookedUp = [];
  const lookup = async (requestId) => {
    lookedUp.push(requestId);
    return lookedUp.length === 1 ? { status: 'completed' } : null;
  };

  const candidate = await ledger.findFirstUnsubmitted(files, lookup);

  assert.equal(candidate.file.id, 'new-file');
  assert.equal(lookedUp.length, 2);
});

test('video poster uses Upload-Post ledger without the missing Supabase table', () => {
  const source = readFileSync(new URL('../video-poster-agent.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /posted_videos|SUPABASE_SERVICE_ROLE_KEY|supabaseRequest/);
  assert.match(source, /lookupUpload/);
  assert.match(source, /selectRecentDriveFiles/);
  assert.match(source, /findFirstUnsubmitted/);
  assert.doesNotMatch(source, /MAX_VIDEOS_PER_RUN/);
  assert.match(source, /request_id/);
  assert.match(source, /Idempotency-Key/);
});