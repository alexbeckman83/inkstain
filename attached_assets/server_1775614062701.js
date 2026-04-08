const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const WAITLIST_FILE = path.join(__dirname, 'waitlist.json');
const UPLOAD_DIR = path.join(os.tmpdir(), 'inkstain-uploads');

if (!fs.existsSync(WAITLIST_FILE)) fs.writeFileSync(WAITLIST_FILE, '[]');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.json': 'application/json',
};

function parseMultipart(body, boundary) {
  const parts = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < body.length) {
    const boundaryPos = body.indexOf(boundaryBuf, pos);
    if (boundaryPos === -1) break;
    pos = boundaryPos + boundaryBuf.length;
    if (body[pos] === 13 && body[pos+1] === 10) pos += 2;
    else if (body[pos] === 45 && body[pos+1] === 45) break;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headerStr = body.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;
    const nextBoundary = body.indexOf(boundaryBuf, pos);
    const contentEnd = nextBoundary === -1 ? body.length : nextBoundary - 2;
    const content = body.slice(pos, contentEnd);
    pos = nextBoundary === -1 ? body.length : nextBoundary;
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    if (nameMatch) {
      parts[nameMatch[1]] = filenameMatch
        ? { filename: filenameMatch[1], data: content }
        : content.toString();
    }
  }
  return parts;
}

function serveStatic(res, filePath) {
  const mime = MIME[path.extname(filePath)] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/waitlist
  if (pathname === '/api/waitlist' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        if (!email || !email.includes('@')) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Invalid email'})); return;
        }
        const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
        if (!list.find(e => e.email === email)) {
          list.push({email, date: new Date().toISOString()});
          fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));
          console.log(`✦ Waitlist: ${email} (${list.length} total)`);
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      } catch { res.writeHead(500); res.end('{}'); }
    });
    return;
  }

  // GET /api/waitlist (admin)
  if (pathname === '/api/waitlist' && req.method === 'GET') {
    if (parsed.query.key !== process.env.ADMIN_KEY) { res.writeHead(401); res.end('Unauthorized'); return; }
    const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({count: list.length, emails: list}));
    return;
  }

  // POST /api/trail — certificate generator
  if (pathname === '/api/trail' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const ct = req.headers['content-type'] || '';
        const bm = ct.match(/boundary=(.+)$/);
        if (!bm) { res.writeHead(400); res.end(JSON.stringify({error:'Bad request'})); return; }
        const parts = parseMultipart(body, bm[1]);
        const author = (parts.author || '').toString().trim();
        const title = (parts.title || '').toString().trim();
        const disclosure = (parts.disclosure || 'summary').toString().trim();
        const file = parts.file;
        if (!author || !title || !file) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Missing required fields'})); return;
        }
        if (!file.filename.match(/\.(docx|doc)$/i)) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Please upload a .docx Word document'})); return;
        }
        const tempId = crypto.randomBytes(8).toString('hex');
        const tempPath = path.join(UPLOAD_DIR, `${tempId}.docx`);
        const certPath = path.join(UPLOAD_DIR, `${tempId}_trail_certificate.pdf`);
        fs.writeFileSync(tempPath, file.data);
        const proc = spawn('python3', [path.join(__dirname, 'certificate.py'), tempPath, author, title, disclosure]);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', code => {
          try { fs.unlinkSync(tempPath); } catch {}
          if (code !== 0) {
            console.error('Cert error:', stderr);
            res.writeHead(500, {'Content-Type':'application/json'});
            res.end(JSON.stringify({error:'Could not read document. Please ensure it is a valid .docx file.'}));
            return;
          }
          if (!fs.existsSync(certPath)) {
            res.writeHead(500, {'Content-Type':'application/json'});
            res.end(JSON.stringify({error:'Certificate generation failed'})); return;
          }
          const pdf = fs.readFileSync(certPath);
          try { fs.unlinkSync(certPath); } catch {}
          const safe = title.replace(/[^a-z0-9]/gi,'-').toLowerCase();
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="inkstain-trail-${safe}.pdf"`,
            'Content-Length': pdf.length
          });
          res.end(pdf);
          console.log(`✦ Certificate: "${title}" by ${author} [${disclosure}]`);
        });
        proc.on('error', err => {
          console.error('Process error:', err);
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Server error — python3 may not be installed'}));
        });
      } catch(err) {
        console.error('Trail error:', err);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Something went wrong. Please try again.'}));
      }
    });
    return;
  }

  // Static
  if (pathname.startsWith('/public/')) { serveStatic(res, path.join(__dirname, pathname)); return; }
  if (pathname === '/trail' || pathname === '/trail.html') { serveStatic(res, path.join(__dirname, 'trail.html')); return; }
  if (pathname === '/' || pathname === '/index.html') { serveStatic(res, path.join(__dirname, 'index.html')); return; }
  serveStatic(res, path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n  ✦ Inkstain on port ${PORT}\n  ✦ /trail — certificate generator\n  ✦ /api/waitlist — waitlist\n`);
});
