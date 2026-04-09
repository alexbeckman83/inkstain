const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const SCHOOLS_FILE = path.join(__dirname, 'schools.json');
const UPLOAD_DIR = path.join(os.tmpdir(), 'inkstain-uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Database ──────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      password_hash TEXT,
      type TEXT,
      genre TEXT,
      school TEXT,
      invite_code TEXT,
      publisher_id TEXT,
      session_token TEXT,
      session_expires BIGINT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS publishers (
      id TEXT PRIMARY KEY,
      org TEXT,
      pub_type TEXT,
      name TEXT,
      role TEXT,
      email TEXT UNIQUE,
      password_hash TEXT,
      policy JSONB DEFAULT '{}',
      session_token TEXT,
      session_expires BIGINT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS certificates (
      id SERIAL PRIMARY KEY,
      hash TEXT UNIQUE,
      author TEXT,
      title TEXT,
      disclosure TEXT,
      generated_at TEXT,
      trail_summary JSONB DEFAULT '{}',
      author_note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email TEXT,
      source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✦ Database ready');
}
initDB().catch(console.error);

// ── Email ─────────────────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log(`[email] No API key — would have sent to ${to}: ${subject}`);
    return { ok: true };
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Inkstain <hello@inkstain.ai>', to, subject, html })
    });
    const data = await r.json();
    if (!r.ok) console.error('[email] Resend error:', data);
    else console.log(`✦ Email sent to ${to}: ${subject}`);
    return { ok: r.ok };
  } catch(err) {
    console.error('[email] Send failed:', err);
    return { ok: false };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function pubFromToken(authHeader) {
  const token = (authHeader || '').replace('Bearer ', '').trim();
  if (!token) return null;
  const r = await pool.query(
    'SELECT * FROM publishers WHERE session_token=$1 AND session_expires>$2',
    [token, Date.now()]
  );
  return r.rows[0] || null;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/waitlist
  if (pathname === '/api/waitlist' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body);
        if (!email || !email.includes('@')) { json(res, 400, {error:'Invalid email'}); return; }
        await pool.query(
          'INSERT INTO waitlist (email, source) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [email, 'website']
        );
        console.log(`✦ Waitlist: ${email}`);
        json(res, 200, {ok:true});
      } catch(e) { console.error(e); json(res, 500, {}); }
    });
    return;
  }

  // GET /api/waitlist (admin)
  if (pathname === '/api/waitlist' && req.method === 'GET') {
    if (parsed.query.key !== process.env.ADMIN_KEY) { res.writeHead(401); res.end('Unauthorized'); return; }
    (async () => {
      const result = await pool.query('SELECT * FROM waitlist ORDER BY created_at DESC');
      json(res, 200, { count: result.rows.length, emails: result.rows });
    })().catch(e => { console.error(e); json(res, 500, {}); });
    return;
  }

  // GET /api/stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    (async () => {
      const certs = await pool.query('SELECT COUNT(*) FROM certificates');
      const accts = await pool.query('SELECT COUNT(*) FROM accounts');
      json(res, 200, {
        certificates: parseInt(certs.rows[0].count),
        waitlist: parseInt(accts.rows[0].count),
        manuscripts: parseInt(accts.rows[0].count),
        hours: 12
      });
    })().catch(e => { console.error(e); json(res, 500, {}); });
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
        if (!bm) { json(res, 400, {error:'Bad request'}); return; }

        const parts = parseMultipart(body, bm[1]);
        const author = (parts.author || '').toString().trim();
        const title = (parts.title || '').toString().trim();
        const disclosure = (parts.disclosure || 'summary').toString().trim();
        const note = (parts.note || '').toString().trim();
        const trailJson = parts.trail ? parts.trail.toString() : null;
        const file = parts.file;

        if (!author || !title) {
          json(res, 400, {error:'Author name and manuscript title are required'});
          return;
        }
        if (!file && !trailJson) {
          json(res, 400, {error:'Please upload a manuscript document or import your Trail — or both'});
          return;
        }

        const tempId = crypto.randomBytes(8).toString('hex');
        let docxPath = 'none';
        let trailPath = 'none';

        if (file) {
          if (!file.filename.match(/\.(docx|doc)$/i)) {
            json(res, 400, {error:'Please upload a .docx Word document'});
            return;
          }
          docxPath = path.join(UPLOAD_DIR, `${tempId}.docx`);
          fs.writeFileSync(docxPath, file.data);
        }

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
            json(res, 500, {error:'Could not generate certificate. Please check your files and try again.'});
            return;
          }

          const outPath = path.join(UPLOAD_DIR, `${tempId}_trail_certificate.pdf`);
          const altPath = path.join(process.cwd(), `${title.replace(/\s+/g,'_')}_trail_certificate.pdf`);
          const finalPath = fs.existsSync(outPath) ? outPath : altPath;

          if (!fs.existsSync(finalPath)) {
            json(res, 500, {error:'Certificate generation failed'});
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

          // Store certificate hash for verification
          const hashMatch = stdout.match(/INKSTAIN_HASH:([a-f0-9]+)/);
          const certHash = hashMatch ? hashMatch[1] : null;
          if (certHash) {
            const generatedAt = new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'});
            let trailSummary = {};
            if (trailJson) { try { trailSummary = JSON.parse(trailJson); } catch(e) {} }
            pool.query(
              'INSERT INTO certificates (hash, author, title, disclosure, generated_at, trail_summary, author_note) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (hash) DO NOTHING',
              [certHash, author, title, disclosure, generatedAt, JSON.stringify(trailSummary), note||'']
            ).catch(e => console.error('Cert storage error:', e));
          }
          console.log(`✦ Certificate: "${title}" by ${author} [${disclosure}]${trailJson ? ' +Trail' : ''}${note ? ' +Note' : ''}`);
        });

        proc.on('error', err => {
          console.error('Process error:', err);
          json(res, 500, {error:'Server error'});
        });

      } catch(err) {
        console.error('Trail error:', err);
        json(res, 500, {error:'Something went wrong. Please try again.'});
      }
    });
    return;
  }

  // GET /api/verify
  if (pathname === '/api/verify' && req.method === 'GET') {
    const hash = parsed.query.hash || '';
    (async () => {
      const result = await pool.query(
        'SELECT * FROM certificates WHERE hash LIKE $1',
        [hash + '%']
      );
      const cert = result.rows[0];
      if (cert) {
        json(res, 200, { verified: true, ...cert });
      } else {
        json(res, 200, { verified: false, reason: 'Certificate not found.' });
      }
    })().catch(e => { console.error(e); json(res, 500, {verified:false}); });
    return;
  }

  // POST /api/sendlink
  if (pathname === '/api/sendlink' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { email } = JSON.parse(body);
        if (!email || !email.includes('@')) { json(res, 400, {error:'Invalid email'}); return; }
        await pool.query(
          'INSERT INTO waitlist (email, source) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [email, 'mobile_sendlink']
        );
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
        json(res, 200, {ok:true});
      } catch(err) { console.error(err); json(res, 500, {error:'Server error'}); }
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
    req.on('end', async () => {
      try {
        const { name, email, password, type, genre, school, invite_code } = JSON.parse(body);
        if (!name || !email || !password) {
          json(res, 400, {error:'Name, email and password are required'});
          return;
        }
        const existing = await pool.query('SELECT id FROM accounts WHERE email=$1', [email]);
        if (existing.rows.length > 0) {
          json(res, 400, {error:'An account with this email already exists'});
          return;
        }
        const id = crypto.randomBytes(8).toString('hex');
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        await pool.query(
          'INSERT INTO accounts (id, name, email, password_hash, type, genre, school, invite_code, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [id, name, email, passwordHash, type||'author', genre||'', school||'', invite_code||'', new Date().toISOString()]
        );
        console.log(`✦ New account: ${email} [${type}]${school ? ' @ ' + school : ''}`);
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
        json(res, 200, {ok:true});
      } catch(err) { console.error(err); json(res, 500, {error:'Server error'}); }
    });
    return;
  }

  // POST /api/signin
  if (pathname === '/api/signin' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { email, password } = JSON.parse(body);
        const result = await pool.query('SELECT * FROM accounts WHERE email=$1', [email]);
        const account = result.rows[0];
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        if (!account || account.password_hash !== passwordHash) {
          json(res, 401, {error:'Invalid email or password'});
          return;
        }
        const token = crypto.randomBytes(32).toString('hex');
        const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
        await pool.query(
          'UPDATE accounts SET session_token=$1, session_expires=$2 WHERE email=$3',
          [token, expires, email]
        );
        const { password_hash, ...safeUser } = account;
        json(res, 200, {ok:true, token, user: safeUser});
      } catch(err) { console.error(err); json(res, 500, {error:'Server error'}); }
    });
    return;
  }

  // GET /api/account
  if (pathname === '/api/account' && req.method === 'GET') {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    (async () => {
      const result = await pool.query(
        'SELECT * FROM accounts WHERE session_token=$1 AND session_expires>$2',
        [token, Date.now()]
      );
      const account = result.rows[0];
      if (!account) { json(res, 401, {error:'Unauthorized'}); return; }
      const certs = await pool.query(
        'SELECT * FROM certificates WHERE author ILIKE $1 ORDER BY created_at DESC',
        [account.name]
      );
      const { password_hash, session_token, ...safeUser } = account;
      json(res, 200, {...safeUser, certificates: certs.rows});
    })().catch(e => { console.error(e); json(res, 500, {error:'Server error'}); });
    return;
  }

  // ── Page routes ─────────────────────────────────────────────────────────────
  if (pathname === '/join' || pathname === '/join.html') {
    serveStatic(res, path.join(__dirname, 'join.html')); return;
  }
  if (pathname === '/signin' || pathname === '/signin.html') {
    serveStatic(res, path.join(__dirname, 'signin.html')); return;
  }
  if (pathname === '/account' || pathname === '/account.html') {
    serveStatic(res, path.join(__dirname, 'account.html')); return;
  }
  if (pathname === '/publishers') { serveStatic(res, path.join(__dirname, 'publishers.html')); return; }
  if (pathname === '/publishers/signup') { serveStatic(res, path.join(__dirname, 'publishers-signup.html')); return; }
  if (pathname === '/publishers/dashboard') { serveStatic(res, path.join(__dirname, 'publishers-dashboard.html')); return; }

  // ── Publisher API ────────────────────────────────────────────────────────────

  // POST /api/publishers/signup
  if (pathname === '/api/publishers/signup' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { org, type, name, role, email, password } = JSON.parse(body);
        if (!org || !name || !email || !password) { json(res, 400, {error:'Missing fields'}); return; }
        const existing = await pool.query('SELECT id FROM publishers WHERE email=$1', [email]);
        if (existing.rows.length > 0) { json(res, 400, {error:'Account already exists'}); return; }
        const id = crypto.randomBytes(8).toString('hex');
        const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
        const token = crypto.randomBytes(24).toString('hex');
        const expires = Date.now() + 30 * 24 * 60 * 60 * 1000;
        const defaultPolicy = JSON.stringify({ requires_trail: 'preferred', disclosure_level: 'summary', accepts_ai: 'case-by-case' });
        await pool.query(
          'INSERT INTO publishers (id, org, pub_type, name, role, email, password_hash, policy, session_token, session_expires, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [id, org, type||'other', name, role||'', email, passwordHash, defaultPolicy, token, expires, new Date().toISOString()]
        );
        console.log(`✦ Publisher signup: ${org} (${email})`);
        json(res, 200, {ok:true, token, publisher:{id, org, pub_type:type, name, role, email}});
      } catch(e) { console.error(e); json(res, 500, {error:'Server error'}); }
    });
    return;
  }

  // GET /api/publishers/dashboard
  if (pathname === '/api/publishers/dashboard' && req.method === 'GET') {
    (async () => {
      const pub = await pubFromToken(req.headers['authorization']);
      if (!pub) { json(res, 401, {error:'Unauthorized'}); return; }
      const authors = await pool.query('SELECT * FROM accounts WHERE invite_code=$1', [pub.id]);
      const certs = await pool.query('SELECT * FROM certificates ORDER BY created_at DESC LIMIT 50');
      const contributors = authors.rows.map(a => ({
        name: a.name, email: a.email, joined_at: a.created_at,
        last_certificate_date: certs.rows.find(c => c.author && a.name && c.author.toLowerCase() === a.name.toLowerCase())?.generated_at || null
      }));
      const pubCerts = certs.rows.filter(c => contributors.find(ct => ct.name && c.author && c.author.toLowerCase() === ct.name.toLowerCase()));
      json(res, 200, {
        ok: true,
        org: pub.org,
        invite_code: pub.id,
        policy: pub.policy || {},
        contributors,
        certificates: pubCerts
      });
    })().catch(e => { console.error(e); json(res, 500, {error:'Server error'}); });
    return;
  }

  // POST /api/publishers/invite
  if (pathname === '/api/publishers/invite' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const pub = await pubFromToken(req.headers['authorization']);
        if (!pub) { json(res, 401, {error:'Unauthorized'}); return; }
        const { email } = JSON.parse(body);
        if (!email) { json(res, 400, {error:'Missing email'}); return; }
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
        json(res, 200, {ok:true});
      } catch(e) { console.error(e); json(res, 500, {error:'Server error'}); }
    });
    return;
  }

  // POST /api/publishers/policy
  if (pathname === '/api/publishers/policy' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const pub = await pubFromToken(req.headers['authorization']);
        if (!pub) { json(res, 401, {error:'Unauthorized'}); return; }
        const { requires_trail, disclosure_level, accepts_ai } = JSON.parse(body);
        await pool.query(
          'UPDATE publishers SET policy=$1 WHERE id=$2',
          [JSON.stringify({ requires_trail, disclosure_level, accepts_ai }), pub.id]
        );
        json(res, 200, {ok:true});
      } catch(e) { console.error(e); json(res, 500, {error:'Server error'}); }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────────────────────────
  if (pathname.startsWith('/public/')) { serveStatic(res, path.join(__dirname, pathname)); return; }
  if (pathname === '/trail' || pathname === '/trail.html') { serveStatic(res, path.join(__dirname, 'trail.html')); return; }
  if (pathname === '/verify' || pathname === '/verify.html') { serveStatic(res, path.join(__dirname, 'verify.html')); return; }
  if (pathname === '/' || pathname === '/index.html') { serveStatic(res, path.join(__dirname, 'index.html')); return; }
  serveStatic(res, path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => console.log(`✦ Inkstain listening on port ${PORT}`));
