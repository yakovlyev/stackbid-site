const { resolveIdentity, parseAccessToken, REASONS } = require('./_auth-identity');

const ALLOWED_ORIGIN = 'https://stackbid.app';
const TIMEOUT_MS = 5000;
const MAX_LEADS = 100;
const MAX_STRING = 500;
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const INTEGER_ID_RE = /^[1-9][0-9]{0,18}$/;
const CONTRACTOR_FIELDS = [
  'id',
  'company_name',
  'subscription_tier',
  'subscription_active',
  'leads_received',
  'leads_converted',
  'rating',
  'review_count',
  'license_verified',
];
const LEAD_FIELDS = ['id', 'project_type', 'zip_code', 'budget_range', 'status', 'created_at', 'contacted_at'];
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

function normalizeId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  return UUID_RE.test(value) || INTEGER_ID_RE.test(value) ? value : null;
}

async function fetchArray(url, anonKey, accessToken) {
  let upstream;
  try {
    upstream = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
  } catch {
    return null;
  }
  if (!upstream.ok) return null;
  try {
    const payload = await upstream.json();
    return Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function boundedString(value) {
  return typeof value === 'string' ? value.slice(0, MAX_STRING) : null;
}

function boundedNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sanitizeContractor(row, id) {
  return {
    id,
    company_name: boundedString(row.company_name),
    subscription_tier: boundedString(row.subscription_tier),
    subscription_active: row.subscription_active === true,
    leads_received: boundedNumber(row.leads_received),
    leads_converted: boundedNumber(row.leads_converted),
    rating: boundedNumber(row.rating),
    review_count: boundedNumber(row.review_count),
    license_verified: row.license_verified === true,
  };
}

function sanitizeLead(row) {
  if (!row || typeof row !== 'object') return null;
  const id = normalizeId(row.id);
  if (id === null) return null;
  return {
    id,
    project_type: boundedString(row.project_type),
    zip_code: boundedString(row.zip_code),
    budget_range: boundedString(row.budget_range),
    status: boundedString(row.status),
    created_at: boundedString(row.created_at),
    contacted_at: boundedString(row.contacted_at),
  };
}

exports.handler = async (event = {}) => {
  if (process.env.STACKBID_CONTRACTOR_AUTH_ROLLOUT !== 'enabled') {
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
  let parsed;
  try {
    identity = await resolveIdentity(event);
    const headers = event.headers || {};
    parsed = parseAccessToken(headers.cookie || headers.Cookie);
  } catch {
    return json(503, { error: 'Service unavailable' });
  }

  if (!identity || typeof identity !== 'object' || (identity.ok !== true && identity.ok !== false)) {
    return json(503, { error: 'Service unavailable' });
  }
  if (!identity.ok) {
    const unauthorized =
      identity.reason === REASONS.NO_TOKEN ||
      identity.reason === REASONS.MALFORMED ||
      identity.reason === REASONS.UNAUTHORIZED;
    return unauthorized ? json(401, { error: 'Unauthorized' }) : json(503, { error: 'Service unavailable' });
  }
  if (typeof identity.authUserId !== 'string' || !UUID_RE.test(identity.authUserId)) {
    return json(503, { error: 'Service unavailable' });
  }
  if (parsed?.status !== 'ok') return json(503, { error: 'Service unavailable' });

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (typeof url !== 'string' || typeof anonKey !== 'string' || !url || !anonKey) {
    return json(503, { error: 'Service unavailable' });
  }

  const baseUrl = url.replace(/\/+$/, '');
  const contractors = await fetchArray(
    `${baseUrl}/rest/v1/contractors?auth_user_id=eq.${encodeURIComponent(identity.authUserId)}&select=${CONTRACTOR_FIELDS.join(',')}&limit=2`,
    anonKey,
    parsed.token,
  );
  if (!contractors) return json(503, { error: 'Service unavailable' });
  if (contractors.length === 0) return json(403, { error: 'Forbidden' });
  if (contractors.length !== 1 || !contractors[0] || typeof contractors[0] !== 'object') {
    return json(503, { error: 'Service unavailable' });
  }

  const contractorId = normalizeId(contractors[0].id);
  if (contractorId === null) return json(503, { error: 'Service unavailable' });
  const leads = await fetchArray(
    `${baseUrl}/rest/v1/contractor_leads?contractor_id=eq.${encodeURIComponent(String(contractorId))}&select=${LEAD_FIELDS.join(',')}&order=created_at.desc&limit=${MAX_LEADS}`,
    anonKey,
    parsed.token,
  );
  if (!leads) return json(503, { error: 'Service unavailable' });

  return json(200, {
    found: true,
    contractor: sanitizeContractor(contractors[0], contractorId),
    leads: leads.slice(0, MAX_LEADS).map(sanitizeLead).filter(Boolean),
  });
};
