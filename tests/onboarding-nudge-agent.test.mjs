import { test } from 'vitest';
import assert from 'node:assert/strict';

import agent from '../onboarding-nudge-agent.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-09T00:00:00Z');

test('isInNudgeWindow skips already-active subscriptions', () => {
  const c = { subscription_active: true, created_at: new Date(NOW - 3 * DAY).toISOString() };
  assert.equal(agent.isInNudgeWindow(c, NOW), false);
});

test('isInNudgeWindow skips contractors with no created_at', () => {
  const c = { subscription_active: false, created_at: null };
  assert.equal(agent.isInNudgeWindow(c, NOW), false);
});

test('isInNudgeWindow rejects too early (under 3 days)', () => {
  const c = { subscription_active: false, created_at: new Date(NOW - 1 * DAY).toISOString() };
  assert.equal(agent.isInNudgeWindow(c, NOW), false);
});

test('isInNudgeWindow rejects too late (well past the window)', () => {
  const c = { subscription_active: false, created_at: new Date(NOW - 10 * DAY).toISOString() };
  assert.equal(agent.isInNudgeWindow(c, NOW), false);
});

test('isInNudgeWindow accepts right at the 3-day mark', () => {
  const c = { subscription_active: false, created_at: new Date(NOW - agent.NUDGE_AFTER_DAYS * DAY).toISOString() };
  assert.equal(agent.isInNudgeWindow(c, NOW), true);
});

test('buildNudgeEmail personalizes with company name when known', () => {
  const { subject, html } = agent.buildNudgeEmail('Acme Roofing');
  assert.match(html, /Hi Acme Roofing team/);
  assert.ok(subject.length > 0);
});

test('buildNudgeEmail falls back to a generic greeting without a company name', () => {
  const { html } = agent.buildNudgeEmail(null);
  assert.match(html, /^<p>Hi,/);
});
