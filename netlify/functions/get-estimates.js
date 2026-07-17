// Отдаёт историю смет пользователя по email — нужен для "Save your project
// history" (Pro perk), который до этого нигде не отображался ни на вебе,
// ни в мобильном приложении, хотя записи уже копились в таблице estimates.
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': 'https://stackbid.app', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid email' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

    const userR = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id,is_pro,first_name`,
      { headers }
    );
    const userRows = await userR.json();
    const user = userRows && userRows[0];
    if (!user) {
      return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_pro: false, estimates: [] }) };
    }

    const estR = await fetch(
      `${SUPABASE_URL}/rest/v1/estimates?user_id=eq.${user.id}&select=id,title,project_type,zip,total_retail,total_wholesale,total_local,created_at&order=created_at.desc&limit=20`,
      { headers }
    );
    const estimates = await estR.json();

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_pro: !!user.is_pro, first_name: user.first_name, estimates: estimates || [] })
    };
  } catch (err) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: err.message }) };
  }
};
