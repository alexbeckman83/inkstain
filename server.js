const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const WAITLIST_FILE = path.join(__dirname, 'waitlist.json');

// Init waitlist file if it doesn't exist
if (!fs.existsSync(WAITLIST_FILE)) {
  fs.writeFileSync(WAITLIST_FILE, JSON.stringify([], null, 2));
}

// MIME types
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.woff2':'font/woff2',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API: POST /api/waitlist ──
  if (pathname === '/api/waitlist' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);

        if (!email || !email.includes('@')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid email' }));
          return;
        }

        const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));

        // No duplicates
        if (list.find(e => e.email === email)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Already on the list' }));
          return;
        }

        list.push({
          email,
          date: new Date().toISOString(),
          source: req.headers.referer || 'direct'
        });

        fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));

        console.log(`✦ Waitlist: ${email} — ${list.length} total`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Welcome to Inkstain' }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server error' }));
      }
    });
    return;
  }

  // ── API: GET /api/waitlist (admin check) ──
  if (pathname === '/api/waitlist' && req.method === 'GET') {
    const key = parsed.query.key;
    if (key !== process.env.ADMIN_KEY) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }
    const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: list.length, emails: list }));
    return;
  }

  // ── STATIC FILES ──
  // /public/* files
  if (pathname.startsWith('/public/')) {
    const filePath = path.join(__dirname, pathname);
    serveStatic(res, filePath);
    return;
  }

  // Root → index.html
  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(__dirname, 'index.html'));
    return;
  }

  // Fallback → index.html (single page)
  serveStatic(res, path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`
  ✦ Inkstain is running
  ✦ http://localhost:${PORT}
  ✦ Waitlist: ${WAITLIST_FILE}
  `);
});
