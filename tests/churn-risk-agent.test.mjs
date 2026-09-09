import { test } from 'vitest';
import assert from 'node:assert/strict';

import agent from '../churn-risk-agent.js';

test('assessRisk returns null for inactive subscriptions (not our concern)', () => {
  assert.equal(agent.assessRisk({ subscription_active: false, leads_received: 0, leads_converted: 0 }, 0), null);
});

test('assessRisk flags paying_zero_leads when never received a lead', () => {
  const risk = agent.assessRisk({ subscription_active: true, leads_received: 0, leads_converted: 0 }, 0);
  assert.equal(risk.reason, 'paying_zero_leads');
});

test('assessRisk flags paying_zero_conversion at the threshold (3 leads, 0 converted)', () => {
  const risk = agent.assessRisk({ subscription_active: true, leads_received: 3, leads_converted: 0 }, 5);
  assert.equal(risk.reason, 'paying_zero_conversion');
});

test('assessRisk does NOT flag zero-conversion below the threshold (still early)', () => {
  const risk = agent.assessRisk({ subscription_active: true, leads_received: 2, leads_converted: 0 }, 2);
  assert.equal(risk, null);
});

test('assessRisk flags inactive_recent when no leads in the lookback window despite past leads', () => {
  const risk = agent.assessRisk({ subscription_active: true, leads_received: 10, leads_converted: 4 }, 0);
  assert.equal(risk.reason, 'inactive_recent');
});

test('assessRisk returns null for a healthy active contractor', () => {
  const risk = agent.assessRisk({ subscription_active: true, leads_received: 10, leads_converted: 4 }, 3);
  assert.equal(risk, null);
});

test('buildDigestHtml reports nothing-to-do when the list is empty', () => {
  const html = agent.buildDigestHtml([]);
  assert.match(html, /риска не найдено/);
});

test('buildDigestHtml escapes attacker-controlled company_name', () => {
  const html = agent.buildDigestHtml([
    { company_name: '<img src=x onerror=alert(1)>', subscription_tier: 'pro', reason: 'paying_zero_leads', detail: 'x' },
  ]);
  assert.ok(!html.includes('<img src=x onerror'));
  assert.match(html, /&lt;img/);
});
