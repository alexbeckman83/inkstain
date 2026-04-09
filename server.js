const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const WAITLIST_FILE = path.join(__dirname, 'waitlist.json');
const STATS_FILE = path.join(__dirname, 'stats.json');
const CERTS_FILE = path.join(__dirname, 'certificates.json');
const PUBLISHERS_FILE = path.join(__dirname, 'publishers.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SCHOOLS_FILE = path.join(__dirname, 'schools.json');
const UPLOAD_DIR = path.join(os.tmpdir(), 'inkstain-uploads');

if (!fs.existsSync(WAITLIST_FILE)) fs.writeFileSync(WAITLIST_FILE, '[]');
if (!fs.existsSync(STATS_FILE)) fs.writeFileSync(STATS_FILE, JSON.stringify({ certificates: 3, hours: 12 }));
if (!fs.existsSync(CERTS_FILE)) fs.writeFileSync(CERTS_FILE, '[]');
if (!fs.existsSync(PUBLISHERS_FILE)) fs.writeFileSync(PUBLISHERS_FILE, '[]');
if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '[]');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log(`[email] No API key — would have sent to ${to}: ${subject}`);
    return { ok: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Inkstain <hello@inkstain.ai>',
        to,
        subject,
        html
      })
    });
    const data = await res.json();
    if (!res.ok) console.error('[email] Resend error:', data);
    else console.log(`✦ Email sent to ${to}: ${subject}`);
    return { ok: res.ok };
  } catch(err) {
    console.error('[email] Send failed:', err);
    return { ok: false };
  }
}

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg',
  '.ico':'image/x-icon','.pdf':'application/pdf','.json':'application/json',
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
        if (!email || !email.includes('@')) { res.writeHead(400); res.end(JSON.stringify({error:'Invalid email'})); return; }
        const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
        if (!list.find(e => e.email === email)) {
          list.push({ email, date: new Date().toISOString() });
          fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));
          console.log(`✦ Waitlist: ${email} (${list.length} total)`);
        }
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      } catch { res.writeHead(500); res.end('{}'); }
    });
    return;
  }

  // GET /api/waitlist
  if (pathname === '/api/waitlist' && req.method === 'GET') {
    if (parsed.query.key !== process.env.ADMIN_KEY) { res.writeHead(401); res.end('Unauthorized'); return; }
    const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ count: list.length, emails: list }));
    return;
  }

  // GET /api/stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
    const stats = JSON.parse(fs.readFileSync(STATS_FILE));
    const uniqueAuthors = new Set(list.map(e => e.email)).size;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({
      manuscripts: uniqueAuthors,
      certificates: stats.certificates,
      hours: stats.hours,
      waitlist: list.length
    }));
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
        const note = (parts.note || '').toString().trim();
        const trailJson = parts.trail ? parts.trail.toString() : null;
        const file = parts.file;

        if (!author || !title) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Author name and manuscript title are required'}));
          return;
        }

        // Need at least a file or a trail
        if (!file && !trailJson) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Please upload a manuscript document or import your Trail — or both'}));
          return;
        }

        const tempId = crypto.randomBytes(8).toString('hex');
        let docxPath = 'none';
        let trailPath = 'none';

        // Save docx if provided
        if (file) {
          if (!file.filename.match(/\.(docx|doc)$/i)) {
            res.writeHead(400, {'Content-Type':'application/json'});
            res.end(JSON.stringify({error:'Please upload a .docx Word document'}));
            return;
          }
          docxPath = path.join(UPLOAD_DIR, `${tempId}.docx`);
          fs.writeFileSync(docxPath, file.data);
        }

        // Save trail JSON if provided
        if (trailJson) {
          trailPath = path.join(UPLOAD_DIR, `${tempId}_trail.json`);
          fs.writeFileSync(trailPath, trailJson);
        }

        const proc = spawn('python3', [
          path.join(__dirname, 'certificate.py'),
          docxPath, author, title, disclosure, trailPath, note
        ]);

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => stdout += d.toString());
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', code => {
          try { if (docxPath !== 'none') fs.unlinkSync(docxPath); } catch {}
          try { if (trailPath !== 'none') fs.unlinkSync(trailPath); } catch {}

          if (code !== 0) {
            console.error('Cert error:', stderr);
            res.writeHead(500, {'Content-Type':'application/json'});
            res.end(JSON.stringify({error:'Could not generate certificate. Please check your files and try again.'}));
            return;
          }

          // Find output file
          const outPath = path.join(UPLOAD_DIR, `${tempId}_trail_certificate.pdf`);
          const altPath = path.join(process.cwd(), `${title.replace(/\s+/g,'_')}_trail_certificate.pdf`);
          const finalPath = fs.existsSync(outPath) ? outPath : altPath;

          if (!fs.existsSync(finalPath)) {
            res.writeHead(500, {'Content-Type':'application/json'});
            res.end(JSON.stringify({error:'Certificate generation failed'}));
            return;
          }

          const pdf = fs.readFileSync(finalPath);
          try { fs.unlinkSync(finalPath); } catch {}

          const safe = title.replace(/[^a-z0-9]/gi,'-').toLowerCase();
          res.writeHead(200, {
            'Content-Type':'application/pdf',
            'Content-Disposition':`attachment; filename="inkstain-trail-${safe}.pdf"`,
            'Content-Length': pdf.length
          });
          res.end(pdf);
          try {
            const stats = JSON.parse(fs.readFileSync(STATS_FILE));
            stats.certificates = (stats.certificates || 0) + 1;
            fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
          } catch {}
          // Store certificate hash for verification
          const hashMatch = stdout.match(/INKSTAIN_HASH:([a-f0-9]+)/);
          const certHash = hashMatch ? hashMatch[1] : null;
          if (certHash) {
            try {
              const certs = JSON.parse(fs.readFileSync(CERTS_FILE));
              certs.push({
                hash: certHash,
                author,
                title,
                disclosure,
                generated_at: new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'}),
                trail_summary: trailJson ? (() => { try { return JSON.parse(trailJson); } catch(e) { return {}; } })() : {},
                author_note: note || ''
              });
              fs.writeFileSync(CERTS_FILE, JSON.stringify(certs, null, 2));
            } catch(e) { console.error('Cert storage error:', e); }
          }
          console.log(`✦ Certificate: "${title}" by ${author} [${disclosure}]${trailJson ? ' +Trail' : ''}${note ? ' +Note' : ''}`);
        });

        proc.on('error', err => {
          console.error('Process error:', err);
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Server error'}));
        });

      } catch(err) {
        console.error('Trail error:', err);
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Something went wrong. Please try again.'}));
      }
    });
    return;
  }

  // GET /api/verify
  if (pathname === '/api/verify' && req.method === 'GET') {
    const hash = parsed.query.hash || '';
    const certs = JSON.parse(fs.readFileSync(CERTS_FILE));
    const cert = certs.find(c => c.hash === hash || c.hash.startsWith(hash));
    if (cert) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ verified: true, ...cert }));
    } else {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ verified: false, reason: 'Certificate not found.' }));
    }
    return;
  }

  // POST /api/sendlink
  if (pathname === '/api/sendlink' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email } = JSON.parse(body);
        if (!email || !email.includes('@')) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Invalid email'}));
          return;
        }
        const list = JSON.parse(fs.readFileSync(WAITLIST_FILE));
        if (!list.find(e => e.email === email)) {
          list.push({email, date: new Date().toISOString(), source: 'mobile_sendlink'});
          fs.writeFileSync(WAITLIST_FILE, JSON.stringify(list, null, 2));
        }
        console.log(`✦ Mobile send-link: ${email}`);
        sendEmail(email, 'Your Inkstain download link', `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#f5f2eb;margin:0;padding:40px 20px;font-family:Georgia,serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:#1B2A3B;padding:32px;text-align:center;margin-bottom:32px;">
      <span style="font-size:28px;font-weight:700;color:#f5f2eb;letter-spacing:-.5px;">Ink<span style="color:#c8956b;">stain</span></span>
    </div>
    <h1 style="font-size:28px;color:#1B2A3B;margin-bottom:8px;">Your download link.</h1>
    <p style="font-size:17px;color:rgba(27,42,59,.6);margin-bottom:32px;">Open this on your Mac or Windows computer to install Inkstain Trail.</p>
    <div style="margin-bottom:24px;">
      <a href="https://github.com/alexbeckman83/inkstain/releases/download/v1.1.0/Inkstain-Trail-Mac.zip"
         style="display:inline-block;background:#1B2A3B;color:#f5f2eb;padding:14px 28px;text-decoration:none;font-size:16px;margin-right:12px;margin-bottom:12px;">
        ↓ Download for Mac
      </a>
      <a href="https://github.com/alexbeckman83/inkstain/releases/download/v1.1.0/Inkstain-Trail-Windows.zip"
         style="display:inline-block;background:transparent;border:1px solid #1B2A3B;color:#1B2A3B;padding:14px 28px;text-decoration:none;font-size:16px;margin-bottom:12px;">
        ↓ Download for Windows
      </a>
    </div>
    <p style="font-size:14px;color:rgba(27,42,59,.4);text-align:center;font-style:italic;">
      Free for authors. Always. · <a href="https://inkstain.ai" style="color:#c8956b;text-decoration:none;">inkstain.ai</a>
    </p>
    <p style="font-size:13px;color:rgba(27,42,59,.3);text-align:center;margin-top:32px;font-style:italic;">The written word will prevail.</p>
  </div>
</body>
</html>
`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok: true}));
      } catch(err) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Server error'}));
      }
    });
    return;
  }

  // GET /api/schools
  if (pathname === '/api/schools' && req.method === 'GET') {
    const schools = fs.readFileSync(SCHOOLS_FILE, 'utf8');
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(schools);
    return;
  }

  // POST /api/accounts
  if (pathname === '/api/accounts' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, email, password, type, genre, school } = JSON.parse(body);
        if (!name || !email || !password) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Name, email and password are required'}));
          return;
        }
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE));
        if (accounts.find(a => a.email === email)) {
          res.writeHead(400, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'An account with this email already exists'}));
          return;
        }
        accounts.push({
          id: crypto.randomBytes(8).toString('hex'),
          name, email,
          password_hash: crypto.createHash('sha256').update(password).digest('hex'),
          type: type || 'author',
          genre: genre || '',
          school: school || '',
          created_at: new Date().toISOString()
        });
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
        console.log(`✦ New account: ${email} [${type}]${school ? ' @ ' + school : ''}`);
        // Send welcome email
        sendEmail(email, 'Welcome to Inkstain — your Trail starts now', `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#f5f2eb;margin:0;padding:40px 20px;font-family:Georgia,serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:#1B2A3B;padding:32px;text-align:center;margin-bottom:32px;">
      <span style="font-size:28px;font-weight:700;color:#f5f2eb;letter-spacing:-.5px;">Ink<span style="color:#c8956b;">stain</span></span>
    </div>
    <h1 style="font-size:28px;color:#1B2A3B;margin-bottom:8px;">Welcome, ${name}.</h1>
    <p style="font-size:17px;color:rgba(27,42,59,.6);margin-bottom:32px;">Your account is created. Your Trail starts the moment you open the app.</p>
    <div style="margin-bottom:24px;">
      <a href="https://github.com/alexbeckman83/inkstain/releases/download/v1.1.0/Inkstain-Trail-Mac.zip"
         style="display:inline-block;background:#1B2A3B;color:#f5f2eb;padding:14px 28px;text-decoration:none;font-size:16px;margin-right:12px;margin-bottom:12px;">
        ↓ Download for Mac
      </a>
      <a href="https://github.com/alexbeckman83/inkstain/releases/download/v1.1.0/Inkstain-Trail-Windows.zip"
         style="display:inline-block;background:transparent;border:1px solid #1B2A3B;color:#1B2A3B;padding:14px 28px;text-decoration:none;font-size:16px;margin-bottom:12px;">
        ↓ Download for Windows
      </a>
    </div>
    <div style="background:#ece8dc;padding:24px;margin-bottom:32px;">
      <p style="font-size:15px;color:#1B2A3B;margin:0 0 8px;font-weight:bold;">What to do next:</p>
      <p style="font-size:15px;color:rgba(27,42,59,.7);margin:0 0 6px;">1. Download and open the app — it lives in your menubar</p>
      <p style="font-size:15px;color:rgba(27,42,59,.7);margin:0 0 6px;">2. Set your manuscript title in the app</p>
      <p style="font-size:15px;color:rgba(27,42,59,.7);margin:0;">3. Write. Your Trail records automatically.</p>
    </div>
    <p style="font-size:14px;color:rgba(27,42,59,.4);text-align:center;font-style:italic;">
      When you're ready — <a href="https://inkstain.ai/trail" style="color:#c8956b;text-decoration:none;">generate your certificate at inkstain.ai/trail</a>
    </p>
    <p style="font-size:13px;color:rgba(27,42,59,.3);text-align:center;margin-top:32px;font-style:italic;">The written word will prevail.</p>
  </div>
</body>
</html>
`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok: true}));
      } catch(err) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Server error'}));
      }
    });
    return;
  }

  // POST /api/signin
  if (pathname === '/api/signin' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { email, password } = JSON.parse(body);
        const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE));
        const account = accounts.find(a => a.email === email);
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        if (!account || account.password_hash !== passwordHash) {
          res.writeHead(401, {'Content-Type':'application/json'});
          res.end(JSON.stringify({error:'Invalid email or password'}));
          return;
        }
        const token = crypto.randomBytes(32).toString('hex');
        account.session_token = token;
        account.session_expires = Date.now() + (30 * 24 * 60 * 60 * 1000);
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
        const { password_hash, ...safeUser } = account;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok: true, token, user: safeUser}));
      } catch(err) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({error:'Server error'}));
      }
    });
    return;
  }

  // GET /api/account
  if (pathname === '/api/account' && req.method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '');
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE));
    const account = accounts.find(a => a.session_token === token && a.session_expires > Date.now());
    if (!account) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Unauthorized'}));
      return;
    }
    const certs = JSON.parse(fs.readFileSync(CERTS_FILE));
    const userCerts = certs.filter(c => c.author && account.name &&
      c.author.toLowerCase() === account.name.toLowerCase());
    const { password_hash, session_token, ...safeUser } = account;
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({...safeUser, certificates: userCerts}));
    return;
  }

  // Join / Sign-in / Account pages
  if (pathname === '/join' || pathname === '/join.html') {
    serveStatic(res, path.join(__dirname, 'join.html')); return;
  }
  if (pathname === '/signin' || pathname === '/signin.html') {
    serveStatic(res, path.join(__dirname, 'signin.html')); return;
  }
  if (pathname === '/account' || pathname === '/account.html') {
    serveStatic(res, path.join(__dirname, 'account.html')); return;
  }

  // Publisher pages
  if (pathname === '/publishers') { serveStatic(res, path.join(__dirname, 'publishers.html')); return; }
  if (pathname === '/publishers/signup') { serveStatic(res, path.join(__dirname, 'publishers-signup.html')); return; }
  if (pathname === '/publishers/dashboard') { serveStatic(res, path.join(__dirname, 'publishers-dashboard.html')); return; }

  // Helper: resolve publisher from Bearer token
  function pubFromToken(authHeader) {
    const token = (authHeader || '').replace('Bearer ', '').trim();
    if (!token) return null;
    const pubs = JSON.parse(fs.readFileSync(PUBLISHERS_FILE));
    return pubs.find(p => p.token === token) || null;
  }

  // POST /api/publishers/signup
  if (pathname === '/api/publishers/signup' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { org, type, name, role, email, password } = JSON.parse(body);
        if (!org || !name || !email || !password) { res.writeHead(400); res.end(JSON.stringify({error:'Missing fields'})); return; }
        const pubs = JSON.parse(fs.readFileSync(PUBLISHERS_FILE));
        if (pubs.find(p => p.email === email)) { res.writeHead(400); res.end(JSON.stringify({error:'Account already exists'})); return; }
        const token = crypto.randomBytes(24).toString('hex');
        const pub = {
          id: crypto.randomBytes(8).toString('hex'),
          org, type: type||'other', name, role: role||'', email, token,
          password: crypto.createHash('sha256').update(password).digest('hex'),
          policy: { requires_trail: 'preferred', disclosure_level: 'summary', accepts_ai: 'case-by-case' },
          contributors: [],
          created_at: new Date().toISOString()
        };
        pubs.push(pub);
        fs.writeFileSync(PUBLISHERS_FILE, JSON.stringify(pubs, null, 2));
        const { password: _pw, token: _tk, ...safe } = pub;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, token, publisher:safe}));
        console.log('✦ Publisher signup: ' + org + ' (' + email + ')');
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:'Server error'})); }
    });
    return;
  }

  // GET /api/publishers/dashboard
  if (pathname === '/api/publishers/dashboard' && req.method === 'GET') {
    try {
      const pub = pubFromToken(req.headers['authorization']);
      if (!pub) { res.writeHead(401); res.end(JSON.stringify({error:'Unauthorized'})); return; }
      const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE));
      const certs = JSON.parse(fs.readFileSync(CERTS_FILE));
      const contributors = accounts.filter(a => a.invite_code === pub.id).map(a => ({
        name: a.name, email: a.email, joined_at: a.created_at,
        last_certificate_date: certs.find(c => c.author_email === a.email)?.generated_at || null
      }));
      const pubCerts = certs.filter(c => contributors.find(ct => ct.email === c.author_email));
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok: true,
        org: pub.org,
        invite_code: pub.id,
        policy: pub.policy || {},
        contributors,
        certificates: pubCerts
      }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:'Server error'})); }
    return;
  }

  // POST /api/publishers/invite  (send email invite to contributor)
  if (pathname === '/api/publishers/invite' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const pub = pubFromToken(req.headers['authorization']);
        if (!pub) { res.writeHead(401); res.end(JSON.stringify({error:'Unauthorized'})); return; }
        const { email } = JSON.parse(body);
        if (!email) { res.writeHead(400); res.end(JSON.stringify({error:'Missing email'})); return; }
        const inviteLink = `https://inkstain.ai/join?publisher=${pub.id}`;
        await sendEmail(email, `${pub.org} invites you to Inkstain`, `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#f5f2eb;margin:0;padding:40px 20px;font-family:Georgia,serif;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="background:#1B2A3B;padding:32px;text-align:center;margin-bottom:32px;">
      <span style="font-size:28px;font-weight:700;color:#f5f2eb;letter-spacing:-.5px;">Ink<span style="color:#c8956b;">stain</span></span>
    </div>
    <h1 style="font-size:24px;color:#1B2A3B;margin-bottom:8px;">${pub.org} has invited you to Inkstain.</h1>
    <p style="font-size:17px;color:rgba(27,42,59,.6);margin-bottom:32px;">Create your free account to generate Trail certificates for your submissions.</p>
    <a href="${inviteLink}" style="display:inline-block;background:#1B2A3B;color:#f5f2eb;padding:14px 28px;text-decoration:none;font-size:16px;margin-bottom:24px;">
      Create your account →
    </a>
    <p style="font-size:13px;color:rgba(27,42,59,.3);text-align:center;margin-top:32px;font-style:italic;">The written word will prevail.</p>
  </div>
</body></html>`);
        console.log(`✦ Publisher invite sent: ${pub.org} → ${email}`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:'Server error'})); }
    });
    return;
  }

  // POST /api/publishers/policy
  if (pathname === '/api/publishers/policy' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const pub = pubFromToken(req.headers['authorization']);
        if (!pub) { res.writeHead(401); res.end(JSON.stringify({error:'Unauthorized'})); return; }
        const { requires_trail, disclosure_level, accepts_ai } = JSON.parse(body);
        const pubs = JSON.parse(fs.readFileSync(PUBLISHERS_FILE));
        const idx = pubs.findIndex(p => p.id === pub.id);
        if (idx === -1) { res.writeHead(404); res.end(JSON.stringify({error:'Not found'})); return; }
        pubs[idx].policy = { requires_trail, disclosure_level, accepts_ai };
        fs.writeFileSync(PUBLISHERS_FILE, JSON.stringify(pubs, null, 2));
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error:'Server error'})); }
    });
    return;
  }

  // Static files
  if (pathname.startsWith('/public/')) { serveStatic(res, path.join(__dirname, pathname)); return; }
  if (pathname === '/trail' || pathname === '/trail.html') { serveStatic(res, path.join(__dirname, 'trail.html')); return; }
  if (pathname === '/verify' || pathname === '/verify.html') { serveStatic(res, path.join(__dirname, 'verify.html')); return; }
  if (pathname === '/' || pathname === '/index.html') { serveStatic(res, path.join(__dirname, 'index.html')); return; }
  serveStatic(res, path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
  console.log(`\n  ✦ Inkstain on port ${PORT}\n  ✦ /trail — certificate generator\n  ✦ /api/waitlist — waitlist\n`);
});
