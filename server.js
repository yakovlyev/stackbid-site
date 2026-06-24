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

const MIME = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.css': 'text/css'
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
      const event = { httpMethod: req.method, body, headers: req.headers, queryStringParameters: parsed.query };
      try {
        const result = await handler.handler(event);
        res.writeHead(result.statusCode || 200, result.headers || {});
        res.end(result.body || '');
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
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
    res.writeHead(200, { 'Content-Type': MIME[ext] ||'text/html; charset=UTF-8'  });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`StackBid running on port ${PORT}`));
