exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://stackbid.app',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };

  try {
    const { name, email, message } = JSON.parse(event.body || '{}');
    if (!name || !email || !message) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY;

    // 1. Save to Supabase
    await fetch(`${SUPABASE_URL}/rest/v1/contact_messages`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ name, email, message, created_at: new Date().toISOString() })
    });

    // 2. Send notification via Resend
    if (RESEND_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'StackBid <onboarding@resend.dev>',
          to: ['stackbid.app@gmail.com'],
          subject: `New message from ${name}`,
          html: `<h2>New contact form message</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Message:</strong></p>
            <p>${message}</p>`
        })
      });
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};
