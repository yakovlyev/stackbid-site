const test = require('node:test');
const assert = require('node:assert/strict');

const { handler } = require('./netlify/functions/estimate');

test('estimate proxy enforces the approved model and server token ceiling', async (t) => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'x';
  t.after(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  let forwarded;
  global.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: 'message', content: [{ type: 'text', text: 'ok' }] }),
    };
  };

  const response = await handler({
    httpMethod: 'POST',
    body: JSON.stringify({
      model: 'attacker-selected-expensive-model',
      max_tokens: 999999,
      messages: [{ role: 'user', content: 'estimate a deck' }],
    }),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(forwarded.model, 'claude-sonnet-4-6');
  assert.equal(forwarded.max_tokens, 4000);
});
