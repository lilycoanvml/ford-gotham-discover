/*
 * ─── GATEWAY ────────────────────────────────────────────────────────────────
 *
 * Cloud Run gives us exactly one port, and the app needs two things on it:
 * Next.js for every page and API route, and a WebSocket endpoint at /api/live
 * that Next's App Router cannot serve (route handlers have no upgrade path).
 *
 * So this process owns the public port, runs Next as a child on an internal
 * one, and forwards to it — except for /api/live, which it answers itself.
 *
 * The alternative was a custom Next server booting the framework in-process via
 * required-server-files.json. That reaches into Next's standalone internals and
 * breaks on framework upgrades; this reaches into nothing. The cost is one
 * loopback hop for HTTP, which is noise next to the network.
 *
 * Not the file Next generates. The standalone build emits its own server.js at
 * the root of .next/standalone — this sits in front of that one.
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { attachLiveRelay } = require('./live/relay');

const PORT = Number(process.env.PORT) || 3000;
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT) || PORT + 1;
const DEV = process.env.NODE_ENV !== 'production';
const HOST = '127.0.0.1';

// Local dev reads .env; in production Cloud Run injects the environment and
// there is no file to read, so a missing dotenv is not an error.
if (DEV) {
  try {
    const fs = require('fs');
    for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim();
    }
  } catch { /* no .env — rely on the real environment */ }
}

// ─── the Next.js child ───────────────────────────────────────────────────────
// In production this is the server.js that `output: 'standalone'` generates at
// the root of .next/standalone, which the Dockerfile copies to /app.
const NEXT_ENTRY = path.join(__dirname, 'server.js');

if (!DEV && !fs.existsSync(NEXT_ENTRY)) {
  console.error(`[gateway] FATAL: ${NEXT_ENTRY} is missing. The standalone build did not land where expected.`);
  console.error('[gateway] /app contains:', fs.readdirSync(__dirname).join(' '));
  process.exit(1);
}

const child = DEV
  ? spawn('npx', ['next', 'dev', '--port', String(INTERNAL_PORT)], {
      stdio: 'inherit',
      env: { ...process.env, PORT: String(INTERNAL_PORT) },
    })
  : spawn(process.execPath, [NEXT_ENTRY], {
      stdio: 'inherit',
      cwd: __dirname,
      env: { ...process.env, PORT: String(INTERNAL_PORT), HOSTNAME: HOST },
    });

// Without this a failed spawn raises an unhandled 'error' and the reason is
// lost behind a generic crash.
child.on('error', (err) => {
  console.error('[gateway] failed to start next:', err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  console.error(`[gateway] next exited (code=${code} signal=${signal}) — shutting down`);
  process.exit(code === null ? 1 : code);
});

/*
 * Cloud Run's startup probe is a TCP connect to $PORT, and it starts routing
 * traffic the moment that succeeds. Binding the public port before Next is
 * listening therefore guarantees a window of ECONNREFUSED 502s on every cold
 * start — which, at min-instances=0, is the first visitor of every idle period.
 *
 * So the public port stays closed until the child accepts a connection. The
 * probe then means what it says, and Cloud Run holds traffic for us.
 */
let nextReady = false;

// If Next never comes up, bind anyway rather than letting the container fail to
// start: a served 502 carries the reason in the logs, whereas a container that
// never listens is reported by Cloud Run as a generic startup failure.
const LISTEN_ANYWAY_MS = 60000;

function listenOnce(why) {
  if (listenOnce.done) return;
  listenOnce.done = true;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[gateway] listening on :${PORT} → next on :${INTERNAL_PORT} (${DEV ? 'dev' : 'production'}, ${why})`);
  });
}

setTimeout(() => {
  if (!nextReady) {
    console.error(`[gateway] next never listened on :${INTERNAL_PORT} — opening :${PORT} anyway so the failure is visible`);
    listenOnce('degraded');
  }
}, LISTEN_ANYWAY_MS).unref();

(function waitForNext(attempt = 0) {
  const probe = net.connect(INTERNAL_PORT, HOST, () => {
    nextReady = true;
    probe.destroy();
    console.log(`[gateway] next is accepting connections on :${INTERNAL_PORT}`);
    listenOnce('ready');
  });
  probe.on('error', () => {
    probe.destroy();
    if (attempt === 40) console.error(`[gateway] next still not listening on :${INTERNAL_PORT} after 20s`);
    setTimeout(() => waitForNext(attempt + 1), 500).unref();
  });
})();

// Cloud Run sends SIGTERM on scale-down; take the child with us so the
// container actually stops instead of lingering until the grace period ends.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } process.exit(0); });
}

// ─── HTTP proxy ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const proxyReq = http.request(
    { host: HOST, port: INTERNAL_PORT, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', (err) => {
    // Next is still booting, or died. Either way there is no page to serve.
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(nextReady ? 'Upstream error' : 'Starting up');
    // Logged unconditionally: a silent 502 is the single most expensive thing
    // to debug on Cloud Run, where there is no shell to poke at.
    console.warn(`[gateway] proxy error for ${req.method} ${req.url}: ${err.message} (nextReady=${nextReady})`);
  });
  req.pipe(proxyReq);
});

/*
 * /api/live is ours. Every other upgrade — notably Next's dev HMR socket — has
 * to reach the child, so it is re-issued verbatim over a raw TCP connection and
 * the two sockets are pinned together.
 *
 * Registered before attachLiveRelay so this listener runs first; it returns
 * without touching /api/live, and the relay's own listener claims it.
 */
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (pathname === '/api/live') return;

  const upstream = net.connect(INTERNAL_PORT, HOST, () => {
    const headers = Object.entries(req.headers)
      .map(([k, v]) => (Array.isArray(v) ? v.map(x => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

attachLiveRelay(server, '/api/live');

// The port is opened by listenOnce() above, once Next is actually reachable.
