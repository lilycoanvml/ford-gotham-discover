/*
 * ─── PASSCODE GATE ──────────────────────────────────────────────────────────
 *
 * A prototype on a public Cloud Run URL is one guessed hostname away from an
 * audience it was never written for. Cloud Run's own auth (IAM / --no-allow-
 * unauthenticated) is the stronger control, but it demands a Google identity
 * and a signed request — no use for a link handed to a client on a phone.
 *
 * So: one shared passcode, checked here in the gateway, in front of everything.
 * Not a login. It keeps the URL from being self-serve, nothing more.
 *
 * Placed in the gateway rather than Next middleware because the gateway is the
 * only thing both the pages AND the /api/live WebSocket pass through. Middleware
 * would leave the socket wide open.
 *
 * Unset APP_PASSCODE disables the gate entirely, so local dev stays frictionless
 * and a missing secret in production fails open loudly (logged at boot) rather
 * than locking everyone out of a demo ten minutes before it starts.
 */
const crypto = require('crypto');

const PASSCODE = (process.env.APP_PASSCODE || '').trim();
const COOKIE = 'gotham_pass';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days — a demo link should outlive the meeting
const GATE_PATH = '/__gate';

const enabled = PASSCODE.length > 0;

// The cookie carries a hash, not the passcode: a value copied out of devtools is
// no more useful than the passcode itself, but it never sits in plaintext in the
// jar, and it means the comparison below is over fixed-length input.
const TOKEN = enabled
  ? crypto.createHash('sha256').update(`gotham-gate:${PASSCODE}`).digest('hex')
  : '';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!enabled) return true;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return Boolean(token) && safeEqual(token, TOKEN);
}

/*
 * Brute force throttle. In-memory and therefore per-instance — with
 * max-instances=10 an attacker gets ten times the budget, which is still far
 * below what it takes to walk a passcode space. The point is to make a script
 * slow, not to be a security boundary.
 */
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILS = 10;

function clientKey(req) {
  // Cloud Run puts the real client first in X-Forwarded-For.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function throttled(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(key); return false; }
  return rec.count >= MAX_FAILS;
}

function recordFail(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) attempts.set(key, { first: now, count: 1 });
  else rec.count += 1;
  // Unbounded growth is the only way this map hurts anything; a lazy sweep on
  // write is cheaper than an interval that keeps the instance from idling down.
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (now - v.first > WINDOW_MS) attempts.delete(k);
  }
}

// Only same-origin paths come back as redirect targets — `next=https://evil…`
// would otherwise turn the gate into an open redirect.
function safeNext(raw) {
  if (!raw) return '/';
  let v;
  try { v = decodeURIComponent(raw); } catch { return '/'; }
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/';
  if (v.startsWith(GATE_PATH)) return '/';
  return v;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function page({ error, next }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Discover Your Next You</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@300;400;500;600&family=Space+Mono:wght@400&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(120% 90% at 50% 0%, #101736 0%, #0A0A0F 62%);
    color: #F5F6FA;
    font-family: Archivo, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 24px;
  }
  main { width: 100%; max-width: 380px; text-align: center; }
  .mark {
    font-family: 'Space Mono', ui-monospace, monospace;
    font-size: 11px; letter-spacing: .28em; text-transform: uppercase;
    color: #066FEF; margin-bottom: 28px;
  }
  h1 { font-size: 26px; font-weight: 500; letter-spacing: -.01em; margin: 0 0 8px; }
  p.sub { margin: 0 0 32px; font-size: 14px; font-weight: 300; color: rgba(245,246,250,.55); }
  form { display: flex; flex-direction: column; gap: 12px; }
  input {
    width: 100%; padding: 15px 16px; font: inherit; font-size: 16px;
    text-align: center; letter-spacing: .16em;
    color: #F5F6FA; background: rgba(255,255,255,.05);
    border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
    outline: none; transition: border-color .18s, background .18s;
  }
  input::placeholder { letter-spacing: .06em; color: rgba(245,246,250,.3); }
  input:focus { border-color: #066FEF; background: rgba(6,111,239,.08); }
  button {
    width: 100%; padding: 15px 16px; font: inherit; font-size: 15px; font-weight: 500;
    color: #fff; background: #066FEF; border: 0; border-radius: 10px;
    cursor: pointer; transition: background .18s;
  }
  button:hover { background: #0A80FF; }
  .error {
    margin: 18px 0 0; font-size: 13px; font-weight: 400;
    color: #F2B705; min-height: 18px;
  }
  @media (prefers-reduced-motion: no-preference) {
    main { animation: rise .5s ease-out both; }
    @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
  }
</style>
</head>
<body>
<main>
  <div class="mark">Ford</div>
  <h1>Discover Your Next You</h1>
  <p class="sub">This prototype is private. Enter the passcode to continue.</p>
  <form method="POST" action="${GATE_PATH}">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <input type="password" name="passcode" placeholder="Passcode" autofocus autocomplete="current-password"
           autocapitalize="off" autocorrect="off" spellcheck="false" required>
    <button type="submit">Continue</button>
  </form>
  <p class="error">${error ? escapeHtml(error) : ''}</p>
</main>
</body>
</html>`;
}

function sendPage(res, status, opts) {
  const body = page(opts);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { data = data.slice(0, limit); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

/*
 * Returns true when it has handled the request and the caller must not proxy.
 * Returns false to let the request through to Next.
 */
async function handleHttp(req, res) {
  if (!enabled) return false;

  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { pathname = req.url || '/'; }

  const isGate = pathname === GATE_PATH;

  if (!isGate) {
    if (isAuthed(req)) return false;
    // An XHR or a WebSocket-adjacent fetch behind a stale cookie should get a
    // status it can act on, not a login page parsed as JSON.
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'passcode required' }));
      return true;
    }
    sendPage(res, 401, { next: req.url || '/' });
    return true;
  }

  if (req.method === 'GET') {
    const next = safeNext(new URL(req.url, 'http://localhost').searchParams.get('next'));
    if (isAuthed(req)) {
      res.writeHead(302, { Location: next, 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    sendPage(res, 200, { next });
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST', 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const key = clientKey(req);
  if (throttled(key)) {
    sendPage(res, 429, { next: '/', error: 'Too many attempts. Try again in a few minutes.' });
    return true;
  }

  const form = new URLSearchParams(await readBody(req));
  const next = safeNext(form.get('next'));

  if (!safeEqual(form.get('passcode') || '', PASSCODE)) {
    recordFail(key);
    console.warn(`[gate] failed attempt from ${key}`);
    sendPage(res, 401, { next, error: 'That passcode is not right.' });
    return true;
  }

  attempts.delete(key);
  // Secure is conditional: Cloud Run always terminates TLS and sets the header,
  // but on plain-http localhost a Secure cookie is silently dropped and the
  // gate would loop forever.
  const https = req.headers['x-forwarded-proto'] === 'https';
  res.writeHead(302, {
    Location: next,
    'Cache-Control': 'no-store',
    'Set-Cookie': `${COOKIE}=${TOKEN}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`,
  });
  res.end();
  return true;
}

// The socket has no page to redirect to, so an unauthorised upgrade is simply
// refused. The client sees a connection that closes immediately.
function allowUpgrade(req, socket) {
  if (isAuthed(req)) return true;
  console.warn(`[gate] refused websocket upgrade from ${clientKey(req)}`);
  try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch { /* already gone */ }
  socket.destroy();
  return false;
}

module.exports = { enabled, handleHttp, allowUpgrade, GATE_PATH };
