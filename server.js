const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const handlers = {
  estimate: require('./netlify/functions/estimate'),
  permit: require('./netlify/functions/permit'),
  prices: require('./netlify/functions/prices'),
  'save-estimate': require('./netlify/functions/save-estimate')
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const apiMatch = pathname.match(/^\/api\/(.+)$/);
  if (apiMatch) {
    const handler = handlers[apiMatch[1]];
    if (!handler) { res.writeHead(404); res.end('Not found'); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const result = await handler.handler({ httpMethod: req.method, body, headers: req.headers, queryStringParameters: parsed.query });
        res.writeHead(result.statusCode || 200, result.headers || {});
        res.end(result.body || '');
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  const MIME = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.css': 'text/css',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };

  let filePath;
  if (pathname === '/' || pathname === '') {
    filePath = path.join(__dirname, 'index.html');
  } else {
    filePath = path.join(__dirname, pathname);
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
    const contentType = MIME[ext] || 'text/html; charset=UTF-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`StackBid running on port ${PORT}`));

// Feedback cron — runs daily at 9am UTC
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

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
    console.log(`Feedback cron: ${users.length} emails to send`);

    for (const user of users) {
      try {
        await resend.emails.send({
          from: 'StackBid <hello@stackbid.app>',
          to: user.email,
          subject: 'How was your StackBid estimate?',
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#0C2340;">Hi ${user.name || 'there'}!</h2>
            <p>You used StackBid to estimate your construction project a few days ago.</p>
            <p>We'd love to hear how it went — takes just 30 seconds:</p>
            <a href="https://stackbid.app/feedback?uid=${user.id}" style="display:inline-block;background:#C9952A;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0;">Share Your Feedback</a>
            <p style="color:#6B7A8D;font-size:13px;">Thanks for using StackBid!<br>The StackBid Team</p>
          </div>`
        });
        await supabase.from('users').update({ feedback_sent: true }).eq('id', user.id);
        console.log(`Feedback sent to ${user.email}`);
      } catch (e) { console.error(`Failed: ${user.email}`, e.message); }
    }
  } catch (e) { console.error('Feedback cron failed:', e.message); }
}

// Run every day at 9am UTC
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
