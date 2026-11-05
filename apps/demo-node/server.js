// Demo Node app — proves the hub can run a real server process.
// The hub starts this with PORT=<assigned port> and reverse-proxies
// /apps/demo-node/ to it. Never hard-code a port here.
// Env demo: DEMO_GREETING comes from apps/demo-node/.env (or from a
// DEMO_NODE_DEMO_GREETING hub var). See .env.example.
const http = require('http');
const port = process.env.PORT || 9102;
const greeting = process.env.DEMO_GREETING || 'Hello';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><html><head><title>Demo Node — Test Hub</title><style>body{margin:0;font-family:system-ui,sans-serif;background:#0f1017;color:#e6e9f5;display:grid;place-items:center;min-height:100vh}div{text-align:center;padding:32px}h1{color:#22c55e}a{color:#8b7cf6}</style></head><body><div><h1>${greeting} — Demo Node works!</h1><p>This is a <b>Node</b> app — a real server process on port ${port}, proxied by the hub.</p><p>Try <a href="./api/time">./api/time</a> and <a href="./api/hello?name=Sam">./api/hello?name=Sam</a></p><p><a href="/">← Back to Test Hub</a></p></div></body></html>`);
  }
  if (req.url.startsWith('/api/time')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, app: 'demo-node', port, time: new Date().toISOString(), greeting, apiKeySet: Boolean(process.env.API_KEY), demoEnvKeys: Object.keys(process.env).filter((k) => k.startsWith('DEMO_')).sort() }));
  }
  if (req.url.startsWith('/api/hello')) {
    const name = new URL(req.url, 'http://localhost').searchParams.get('name') || 'friend';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: greeting + ', ' + name + ' — from demo-node via the Test Hub!' }));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

server.listen(port, '127.0.0.1', () => console.log('demo-node listening on ' + port));
