const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const UNSUB_SECRET = process.env.UNSUB_SECRET || '';
function unsubscribeToken(email) {
  return crypto.createHmac('sha256', UNSUB_SECRET).update(email.toLowerCase().trim()).digest('hex').slice(0, 32);
}
function unsubscribeUrl(email) {
  return `https://stackbid.app/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubscribeToken(email)}`;
}

const PORT = process.env.PORT || 3000;

// ============================================================
// SECURITY: Rate limiting — per IP per endpoint
// ============================================================
const rateMap = new Map();
const LIMITS = {
  estimate: { max: 10, window: 60000 },   // 10 AI requests/min
  permit:   { max: 10, window: 60000 },
  contact:  { max: 5,  window: 60000 },   // 5 contact form submissions/min
  default:  { max: 60, window: 60000 }    // 60 general requests/min
};

function checkRateLimit(ip, endpoint) {
  const key = `${ip}:${endpoint}`;
  const limit = LIMITS[endpoint] || LIMITS.default;
  const now = Date.now();
  const hits = (rateMap.get(key) || []).filter(t => now - t < limit.window);
  if (hits.length >= limit.max) return false;
  rateMap.set(key, [...hits, now]);
  return true;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateMap.entries()) {
    if (hits.every(t => now - t > 300000)) rateMap.delete(key);
  }
}, 300000);

// ============================================================
// SECURITY: Input sanitization
// ============================================================
function sanitizeString(str, maxLen = 1000) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[<>'"]/g, '').trim().slice(0, maxLen);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length < 254;
}

// ============================================================
// API HANDLERS
// ============================================================
const handlers = {
  estimate: require('./netlify/functions/estimate'),
  permit: require('./netlify/functions/permit'),
  prices: require('./netlify/functions/prices'),
  'save-estimate': require('./netlify/functions/save-estimate'),
  'email-pdf': require('./netlify/functions/email-pdf'),
  'check-access': require('./netlify/functions/check-access')
};

// Contact form handler
async function handleContact(req, res) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > 10000) { res.writeHead(413); res.end('{}'); } });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body);
      const name = sanitizeString(parsed.name, 100);
      const email = sanitizeString(parsed.email, 254);
      const message = sanitizeString(parsed.message, 2000);

      if (!name || !email || !message) { res.writeHead(400); res.end('{"error":"Missing fields"}'); return; }
      if (!validateEmail(email)) { res.writeHead(400); res.end('{"error":"Invalid email"}'); return; }

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
      const resendKey = process.env.RESEND_API_KEY;

      if (SUPABASE_URL && SUPABASE_KEY) {
        await fetch(`${SUPABASE_URL}/rest/v1/contact_messages`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ name, email, message, created_at: new Date().toISOString() })
        });
      }

      if (resendKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'StackBid <hello@stackbid.app>',
            to: ['hello@stackbid.app', 'yakovlyev62@gmail.com'],
            subject: 'New message from ' + name,
            html: '<p><b>From:</b> ' + name + ' (' + email + ')</p><p><b>Message:</b></p><p>' + message.replace(/\n/g,'<br>') + '</p>'
          })
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch(e) {
      console.error('Contact handler error:', e.message);
      res.writeHead(500); res.end('{}');
    }
  });
}

// Brevo contact proxy
async function handleBrevoContact(req, res) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', async () => {
    try {
      const { fname, email, role, alerts } = JSON.parse(body);
      if (!validateEmail(email || '')) { res.writeHead(400); res.end('{}'); return; }
      const brevoKey = process.env.BREVO_API_KEY;
      if (!brevoKey) { res.writeHead(400); res.end('{}'); return; }
      const r = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: sanitizeString(email, 254),
          attributes: { FIRSTNAME: sanitizeString(fname, 100), ROLE: sanitizeString(role, 50), PRICE_ALERTS: alerts },
          listIds: [2],
          updateEnabled: true
        })
      });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end('{}');
    } catch(e) { res.writeHead(500); res.end('{}'); }
  });
}

// Unsubscribe handler — CAN-SPAM compliance. Verifies a signed token so
// arbitrary people can't unsubscribe someone else's email, then marks
// unsubscribed=true. No login required — clicking the link is enough,
// as required by law (opt-out must be a one-click action).
async function handleUnsubscribe(query, res) {
  const email = (query.email || '').toLowerCase().trim();
  const token = query.token || '';

  const page = (title, message) => `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>${title} — StackBid</title>
    <style>body{font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#0C2340;}
    h1{font-size:22px;} p{color:#6B7A8D;}</style></head>
    <body><h1>${title}</h1><p>${message}</p></body></html>`;

  if (!email || !validateEmail(email) || !token || token !== unsubscribeToken(email)) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(page('Link not valid', 'This unsubscribe link is invalid or expired. Contact hello@stackbid.app if you keep getting emails you don\'t want.'));
    return;
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await supabase.from('users').update({ unsubscribed: true }).eq('email', email);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(page('You\'re unsubscribed', `${email} won't receive any more marketing emails from StackBid. Transactional emails about your account may still be sent.`));
  } catch (e) {
    console.error('Unsubscribe error:', e.message);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(page('Something went wrong', 'Please try again or contact hello@stackbid.app to be removed manually.'));
  }
}


const ALLOWED_ORIGINS = [
  'https://stackbid.app',
  'https://www.stackbid.app',
  'https://stackbid-app.onrender.com'
];

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Block suspicious paths
  const blocked = ['.php', '.asp', '.env', 'wp-admin', 'wp-login', '.git', 'xmlrpc', 'eval(', 'base64'];
  if (blocked.some(b => pathname.toLowerCase().includes(b))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // Security headers
  const origin = req.headers['origin'];
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : 'https://stackbid.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://www.googletagmanager.com https://www.google-analytics.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self' https://xbxknpsqecwahxzwsvpt.supabase.co https://api.anthropic.com https://api.resend.com https://api.brevo.com https://www.google.com https://www.google-analytics.com https://region1.google-analytics.com; " +
    "frame-ancestors 'none';"
  );

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Block oversized requests
  const contentLength = parseInt(req.headers['content-length'] || '0');
  if (contentLength > 10 * 1024 * 1024) { res.writeHead(413, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Request too large'})); return; }

  // Routes
  if (pathname === '/api/contact' && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (!checkRateLimit(ip, 'contact')) { res.writeHead(429); res.end('{"error":"Too many requests"}'); return; }
    return handleContact(req, res);
  }

  if (pathname === '/api/brevo-contact' && req.method === 'POST') {
    return handleBrevoContact(req, res);
  }

  if (pathname === '/unsubscribe' && req.method === 'GET') {
    return handleUnsubscribe(parsed.query, res);
  }

  const apiMatch = pathname.match(/^\/api\/(.+)$/);
  if (apiMatch) {
    const handler = handlers[apiMatch[1]];
    if (!handler) { res.writeHead(404); res.end('Not found'); return; }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (!checkRateLimit(ip, apiMatch[1])) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Please wait a minute.' }));
      return;
    }

    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const result = await handler.handler({
          httpMethod: req.method, body,
          headers: req.headers,
          queryStringParameters: parsed.query
        });
        res.writeHead(result.statusCode || 200, result.headers || {});
        res.end(result.body || '');
      } catch (e) {
        console.error('Handler error:', e.message);
        res.writeHead(500); res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
    return;
  }

  // Static files
  const MIME = {
    '.html': 'text/html; charset=UTF-8',
    '.js':   'application/javascript',
    '.svg':  'image/svg+xml',
    '.json': 'application/json',
    '.css':  'text/css',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.webp': 'image/webp',
    '.webmanifest': 'application/manifest+json',
    '.xml':  'application/xml; charset=UTF-8',
    '.txt':  'text/plain; charset=UTF-8'
  };

  let filePath;
  if (pathname === '/' || pathname === '') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    // Prevent path traversal
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    filePath = path.join(__dirname, safePath);
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/html; charset=UTF-8' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`StackBid running on port ${PORT}`));

// ============================================================
// FEEDBACK CRON — runs daily at 9am UTC
// ============================================================

async function sendFeedbackEmails() {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, estimate_date')
      .eq('feedback_sent', false)
      .lte('estimate_date', fiveDaysAgo.toISOString())
      .not('email', 'is', null);
    if (error) { console.error('Feedback cron error:', error); return; }
    for (const user of users) {
      try {
        await resend.emails.send({
          from: 'StackBid <hello@stackbid.app>',
          to: user.email,
          subject: 'How was your StackBid estimate?',
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#0C2340;">Hi ${user.name || 'there'}!</h2>
            <p>You used StackBid to estimate your construction project a few days ago.</p>
            <p>We'd love to hear how it went:</p>
            <a href="https://stackbid.app/feedback?uid=${user.id}" style="display:inline-block;background:#C9952A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Share Your Feedback</a>
            <p style="color:#6B7A8D;font-size:13px;">Thanks,<br>The StackBid Team</p>
          </div>`
        });
        await supabase.from('users').update({ feedback_sent: true }).eq('id', user.id);
      } catch (e) { console.error(`Feedback failed: ${user.email}`, e.message); }
    }
  } catch (e) { console.error('Feedback cron failed:', e.message); }
}

function scheduleDailyCron() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    sendFeedbackEmails();
    setInterval(sendFeedbackEmails, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`Feedback cron scheduled, next run in ${Math.round(delay/60000)} minutes`);
}

scheduleDailyCron();

// ============================================================
// EMAIL NURTURE CAMPAIGN — free estimate → Pro, runs daily at 10am UTC
// ============================================================
// Requires env var UNSUB_SECRET (any long random string) and a filled-in
// physical mailing address below (CAN_SPAM_ADDRESS) — legally required on
// every commercial email in the US. DO NOT enable this cron until both
// are set for real.
//
// Requires columns on `users` (see email-campaign-schema.sql):
//   unsubscribed, nurture1_sent, nurture2_sent, nurture3_sent
// Assumes existing columns: free_estimate_used, is_pro, estimate_date

const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS || '[ADDRESS NOT SET — do not send until this is filled in]';

function emailFooter(unsubUrl) {
  return `<hr style="border:none;border-top:1px solid #E5E9EF;margin:24px 0;">
    <p style="color:#9AA5B1;font-size:11px;line-height:1.5;">
      StackBid, ${CAN_SPAM_ADDRESS}<br>
      You're receiving this because you used StackBid's free estimate tool.
      <a href="${unsubUrl}" style="color:#9AA5B1;">Unsubscribe</a> from these emails anytime.
    </p>`;
}

const NURTURE_TEMPLATES = {
  1: {
    subject: 'Still planning your project?',
    html: (user, unsubUrl) => `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0C2340;">Hi ${user.name || 'there'},</h2>
      <p>A few days ago you got a free StackBid estimate. Just checking in — still moving forward with the project?</p>
      <p>If prices shift or your plans change, StackBid Pro lets you re-run estimates anytime, not just once — $9.99/month, cancel whenever.</p>
      <a href="https://stackbid.app/#pricing" style="display:inline-block;background:#C9952A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">See StackBid Pro</a>
      <p style="color:#6B7A8D;font-size:13px;">Thanks,<br>The StackBid Team</p>
      ${emailFooter(unsubUrl)}
    </div>`
  },
  2: {
    subject: 'Material prices don\'t hold still',
    html: (user, unsubUrl) => `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0C2340;">Hi ${user.name || 'there'},</h2>
      <p>Lumber, fixtures, appliances — prices move week to week. The estimate you got is a snapshot from that day.</p>
      <p>With StackBid Pro you can re-check pricing right before you buy or sign with a contractor, so you're negotiating with current numbers, not old ones.</p>
      <a href="https://stackbid.app/#pricing" style="display:inline-block;background:#C9952A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">$9.99/month, unlimited estimates</a>
      <p style="color:#6B7A8D;font-size:13px;">Thanks,<br>The StackBid Team</p>
      ${emailFooter(unsubUrl)}
    </div>`
  },
  3: {
    subject: 'Last note about your estimate',
    html: (user, unsubUrl) => `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#0C2340;">Hi ${user.name || 'there'},</h2>
      <p>This is the last email we'll send about upgrading — no pressure either way.</p>
      <p>If you ever need another estimate down the line, StackBid Pro is $9.99/month for unlimited use. If not, that's completely fine, and you can unsubscribe below.</p>
      <a href="https://stackbid.app/#pricing" style="display:inline-block;background:#C9952A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">See StackBid Pro</a>
      <p style="color:#6B7A8D;font-size:13px;">Thanks,<br>The StackBid Team</p>
      ${emailFooter(unsubUrl)}
    </div>`
  }
};

async function sendNurtureEmails() {
  if (!UNSUB_SECRET) {
    console.error('Nurture cron: UNSUB_SECRET not set, refusing to send (unsubscribe links would be broken).');
    return;
  }
  if (!process.env.CAN_SPAM_ADDRESS) {
    console.error('Nurture cron: CAN_SPAM_ADDRESS not set, refusing to send (US law requires a real physical address in marketing email).');
    return;
  }
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data: users, error } = await supabase
      .from('users')
      .select('id, name, email, estimate_date, nurture1_sent, nurture2_sent, nurture3_sent')
      .eq('free_estimate_used', true)
      .eq('is_pro', false)
      .eq('unsubscribed', false)
      .not('email', 'is', null)
      .not('estimate_date', 'is', null);
    if (error) { console.error('Nurture cron error:', error); return; }

    const now = Date.now();
    for (const user of users) {
      const daysSince = Math.floor((now - new Date(user.estimate_date).getTime()) / 86400000);
      let stage = null;
      if (daysSince >= 16 && !user.nurture3_sent) stage = 3;
      else if (daysSince >= 8 && !user.nurture2_sent) stage = 2;
      else if (daysSince >= 3 && !user.nurture1_sent) stage = 1;
      if (!stage) continue;

      const template = NURTURE_TEMPLATES[stage];
      const unsubUrl = unsubscribeUrl(user.email);
      try {
        await resend.emails.send({
          from: 'StackBid <hello@stackbid.app>',
          to: user.email,
          subject: template.subject,
          html: template.html(user, unsubUrl)
        });
        await supabase.from('users').update({ [`nurture${stage}_sent`]: true }).eq('id', user.id);
      } catch (e) {
        console.error(`Nurture stage ${stage} failed for ${user.email}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Nurture cron failed:', e.message);
  }
}

function scheduleNurtureCron() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(10, 0, 0, 0); // сдвинуто на час от feedback-cron, чтобы не пересекались
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(() => {
    sendNurtureEmails();
    setInterval(sendNurtureEmails, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`Nurture cron scheduled, next run in ${Math.round(delay/60000)} minutes`);
}

scheduleNurtureCron();


