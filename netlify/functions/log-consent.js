// Proof-of-consent лог: фиксирует момент явного согласия на recurring
// billing (email, IP, user-agent, точный текст согласия, версия текста,
// время). Нужен как доказательная база на случай спора/жалобы/chargeback —
// FTC и штатовские auto-renewal законы (California, Colorado, New York)
// ожидают, что продавец сможет показать, что именно видел и на что
// согласился пользователь.
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email, consent_text, consent_version } = JSON.parse(event.body || '{}');
    if (!email || !consent_text) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const ip = (event.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || event.headers?.['x-real-ip'] || null;
    const userAgent = event.headers?.['user-agent'] || null;

    await fetch(`${SUPABASE_URL}/rest/v1/consent_log`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        ip,
        user_agent: userAgent,
        consent_text,
        consent_version: consent_version || null
      })
    });

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ logged: true }) };
  } catch (err) {
    // Логирование никогда не должно ронять чекаут пользователю
    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ logged: false, error: err.message }) };
  }
};
