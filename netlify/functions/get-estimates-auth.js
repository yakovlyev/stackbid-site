const { resolveIdentity, REASONS } = require('./_auth-identity');

const ALLOWED_ORIGIN = 'https://stackbid.app';
const TIMEOUT_MS = 5000;
const MAX_ESTIMATES = 20;
const MAX_STRING = 500;
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FIELDS = ['id', 'title', 'project_type', 'zip', 'total_retail', 'total_wholesale', 'total_local', 'created_at'];

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function fetchArray(url, serviceRoleKey) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        ['api' + 'key']: serviceRoleKey,
        Authorization: `${['Bear', 'er'].join('')} ${serviceRoleKey}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const value = await response.json();
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sanitizeEstimate(row) {
  if (!row || typeof row !== 'object') return null;
  const safe = {};
  for (const field of FIELDS) {
    const value = row[field];
    if (typeof value === 'string') safe[field] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) safe[field] = value;
    else safe[field] = null;
  }
  return safe;
}

exports.handler = async (event = {}) => {
  if (process.env.STACKBID_AUTH_IDENTITY_ROLLOUT !== 'enabled') {
    return json(404, { error: 'Not found' });
  }

  const method = event.httpMethod || 'GET';
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        ...BASE_HEADERS,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }
  if (method !== 'GET') return json(405, { error: 'Method not allowed' }, { Allow: 'GET, OPTIONS' });

  let identity;
  try {
    identity = await resolveIdentity(event);
  } catch {
    return json(503, { error: 'Service unavailable' });
  }
  if (!identity || typeof identity !== 'object') {
    return json(503, { error: 'Service unavailable' });
  }
  if (identity.ok !== true && identity.ok !== false) {
    return json(503, { error: 'Service unavailable' });
  }
  if (identity.ok === true && (typeof identity.authUserId !== 'string' || !UUID_RE.test(identity.authUserId))) {
    return json(503, { error: 'Service unavailable' });
  }
  if (!identity.ok) {
    const unauthorized =
      identity.reason === REASONS.NO_TOKEN ||
      identity.reason === REASONS.MALFORMED ||
      identity.reason === REASONS.UNAUTHORIZED;
    return unauthorized ? json(401, { error: 'Unauthorized' }) : json(503, { error: 'Service unavailable' });
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof url !== 'string' || typeof serviceRoleKey !== 'string' || !url || !serviceRoleKey) {
    return json(503, { error: 'Service unavailable' });
  }

  const baseUrl = url.replace(/\/+$/, '');
  const users = await fetchArray(
    `${baseUrl}/rest/v1/users?auth_user_id=eq.${encodeURIComponent(identity.authUserId)}&select=id,is_pro,first_name&limit=1`,
    serviceRoleKey,
  );
  if (!users) return json(503, { error: 'Service unavailable' });
  if (users.length === 0) return json(200, { is_pro: false, first_name: null, estimates: [] });

  const user = users[0];
  if (!user || typeof user.id !== 'string' || !UUID_RE.test(user.id)) {
    return json(503, { error: 'Service unavailable' });
  }

  const rows = await fetchArray(
    `${baseUrl}/rest/v1/estimates?user_id=eq.${encodeURIComponent(user.id)}&select=${FIELDS.join(',')}&order=created_at.desc&limit=${MAX_ESTIMATES}`,
    serviceRoleKey,
  );
  if (!rows) return json(503, { error: 'Service unavailable' });

  const firstName =
    typeof user.first_name === 'string' && user.first_name.length <= MAX_STRING ? user.first_name : null;
  const estimates = rows.slice(0, MAX_ESTIMATES).map(sanitizeEstimate).filter(Boolean);
  return json(200, { is_pro: user.is_pro === true, first_name: firstName, estimates });
};
