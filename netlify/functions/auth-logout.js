// Крок 6.2: безпечне завершення сесії — просто перезаписуємо cookie з
// Max-Age=0, тими самими атрибутами (Secure/HttpOnly/SameSite=Lax), щоб
// браузер її реально видалив. Ніякого server-side session store немає
// (сесія — це сам Supabase access_token у cookie), тому "вихід" — це
// саме видалення cookie, більше нічого інвалідувати не потрібно.
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://stackbid.app' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  return {
    statusCode: 200,
    headers: {
      ...headers,
      'Set-Cookie': [
        'sb_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
        'sb_refresh=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
      ],
    },
    body: JSON.stringify({ ok: true }),
  };
};
