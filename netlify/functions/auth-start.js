// Крок 2 у заміні email-only авторизації контракторів на Supabase Auth.
// НАМІРЕНО мінімальний: тільки просить Supabase надіслати magic link.
// Жодної прив'язки до contractors, жодної сесії, жодного callback ще
// немає — це окремі майбутні change-set'и. Rate limit — автоматично
// через загальний механізм server.js (по імені хендлера 'auth-start').
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 254;
}

// Одна й та сама відповідь незалежно від того, чи існує такий email у
// Supabase Auth чи в contractors — інакше відповідь сама стає способом
// перевірити чиюсь реєстрацію (account enumeration), саме те, проти чого
// прямо застерігає архітектурний документ.
const GENERIC_RESPONSE = { message: 'If that email is registered, a login link has been sent.' };

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://stackbid.app' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Service temporarily unavailable' }) };
  }

  let email;
  try {
    ({ email } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }
  email = String(email || '')
    .trim()
    .toLowerCase();
  if (!validateEmail(email)) {
    // Формат явно невалідний — тут можна відповісти чесно, це не витік
    // інформації про конкретний акаунт, просто "ти не так email ввів".
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address' }) };
  }

  try {
    await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        create_user: false, // не створюємо нового Auth-користувача просто з запиту логіну — тільки реальні контрактори мають цим користуватись; сам "claim" існуючого запису — окремий майбутній крок
        options: { emailRedirectTo: 'https://stackbid.app/contractor-login-callback.html' },
      }),
    });
  } catch (e) {
    console.error('auth-start: Supabase OTP call failed:', e.message);
    // Навіть при внутрішній помилці повертаємо ту саму загальну відповідь —
    // не показуємо зовнішньому виклику деталі збою.
  }

  return { statusCode: 200, headers, body: JSON.stringify(GENERIC_RESPONSE) };
};
