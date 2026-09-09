import { test } from 'vitest';
import assert from 'node:assert/strict';

import agent from '../review-request-agent.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-09T00:00:00Z');

test('isReadyForReviewRequest requires status=won', () => {
  const lead = { status: 'contacted', contacted_at: new Date(NOW - 20 * DAY).toISOString(), review_requested_at: null };
  assert.equal(agent.isReadyForReviewRequest(lead, NOW), false);
});

test('isReadyForReviewRequest skips leads already requested', () => {
  const lead = { status: 'won', contacted_at: new Date(NOW - 20 * DAY).toISOString(), review_requested_at: '2026-09-01T00:00:00Z' };
  assert.equal(agent.isReadyForReviewRequest(lead, NOW), false);
});

test('isReadyForReviewRequest skips leads with no contacted_at at all', () => {
  const lead = { status: 'won', contacted_at: null, review_requested_at: null };
  assert.equal(agent.isReadyForReviewRequest(lead, NOW), false);
});

test('isReadyForReviewRequest rejects too early (under 14 days)', () => {
  const lead = { status: 'won', contacted_at: new Date(NOW - 5 * DAY).toISOString(), review_requested_at: null };
  assert.equal(agent.isReadyForReviewRequest(lead, NOW), false);
});

test('isReadyForReviewRequest rejects too late (over 28 days)', () => {
  const lead = { status: 'won', contacted_at: new Date(NOW - 40 * DAY).toISOString(), review_requested_at: null };
  assert.equal(agent.isReadyForReviewRequest(lead, NOW), false);
});

test('isReadyForReviewRequest accepts the sweet spot (14-28 days)', () => {
  const lead = { status: 'won', contacted_at: new Date(NOW - 20 * DAY).toISOString(), review_requested_at: null };
  assert.equal(agent.isReadyForReviewRequest(lead, NOW), true);
});

test('isReadyForReviewRequest accepts the exact boundaries', () => {
  const early = { status: 'won', contacted_at: new Date(NOW - agent.MIN_DAYS_AFTER_WON * DAY).toISOString(), review_requested_at: null };
  const late = { status: 'won', contacted_at: new Date(NOW - agent.MAX_DAYS_AFTER_WON * DAY).toISOString(), review_requested_at: null };
  assert.equal(agent.isReadyForReviewRequest(early, NOW), true);
  assert.equal(agent.isReadyForReviewRequest(late, NOW), true);
});

test('buildReviewRequestEmail personalizes greeting when a first name is known', () => {
  const { subject, html } = agent.buildReviewRequestEmail('Maria');
  assert.match(html, /Hi Maria/);
  assert.ok(subject.length > 0);
});

test('buildReviewRequestEmail falls back to a generic greeting without a name', () => {
  const { html } = agent.buildReviewRequestEmail(null);
  assert.match(html, /Hi there/);
});
