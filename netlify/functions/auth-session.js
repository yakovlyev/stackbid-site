// GET /api/auth-session — validates the HttpOnly sb_access_token cookie via
// the shared identity helper (_auth-identity.js) and returns only
// {authenticated:true}. Read-only: never returns the token, email, user id, or
// any upstream error body. Missing/malformed cookie short-circuits to 401
// without upstream work.
const { resolveIdentity, REASONS } = require('./_auth-identity');

const ALLOWED_ORIGIN = 'https://stackbid.app';

const BASE = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
};

function json(statusCode, authenticated, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...BASE, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ authenticated }),
  };
}

exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...BASE,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (method !== 'GET') return json(405, false, { Allow: 'GET, OPTIONS' });

  const identity = await resolveIdentity(event);
  if (!identity.ok) {
    if (
      identity.reason === REASONS.NO_TOKEN ||
      identity.reason === REASONS.MALFORMED ||
      identity.reason === REASONS.UNAUTHORIZED
    ) {
      return json(401, false);
    }
    // MISCONFIGURED / INVALID / UNAVAILABLE all fail closed to service-unavailable.
    return json(503, false);
  }

  return json(200, true);
};
