// Test Hub — one main server that runs many small servers.
// Zero dependencies, bare Node.js only. Same code can later run on Render
// (Render gives it one $PORT; every app lives under /apps/<name>).
//
// App types (auto-detected from apps/<name>/):
//   static — has index.html, no server.js / package.json → served by the hub
//   node   — has server.js (or package.json with a main file) → child
//            process on its own localhost port, hub reverse-proxies to it
//
// Routes:
//   /                    dashboard (list apps, open, restart, logs, clone)
//   /health              {"ok":true,...}
//   /api/apps            JSON list of apps + status
//   /api/apps/:name/logs JSON lines of recent logs
//   POST /api/apps/:name/restart
//   POST /api/apps/:name/stop
//   POST /api/apps/clone  {"repo":"https://github.com/<owner>/<repo>"} (git clone)
//   /apps/:name/...      the app itself (proxy or static files)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HUB_PORT = parseInt(process.env.PORT || '8080', 10);
const APPS_DIR = path.join(__dirname, 'apps');
const BASE_PORT = 9100;
const MAX_LOG_LINES = 200;
const MAX_RESTARTS = 3; // per 60s window, then mark crashed (no infinite loop)

if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

const apps = new Map(); // name -> app object
let hubStart = Date.now();

function log(app, line) {
  const text = '[' + new Date().toISOString().slice(11, 19) + '] ' + line;
  if (app) {
    app.logs.push(text);
    if (app.logs.length > MAX_LOG_LINES) app.logs.shift();
  }
  console.log(app ? '[' + app.name + '] ' + line : line);
}

// ---------- env handling ----------
// Precedence for a Node child (PORT always wins — the hub assigns it):
//   1. hub process env — local: hub .env / shell; Render: dashboard env vars
//   2. prefixed hub vars: <APPNAME>_<KEY> reaches that app only as <KEY>
//      e.g. DEMO_NODE_API_KEY=... arrives in demo-node as API_KEY
//   3. the app's own apps/<name>/.env file (highest, except PORT)
// Env VALUES are never logged, never returned by any API, and .env files
// are never served as static files — only key NAMES are shown.
function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function loadHubEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  try {
    const vars = parseDotEnv(fs.readFileSync(p, 'utf8'));
    for (const [k, v] of Object.entries(vars)) if (!(k in process.env)) process.env[k] = v;
  } catch (e) { console.log('hub .env could not be read: ' + e.message); }
}
loadHubEnv();

function appEnv(app) {
  const env = { ...process.env };
  const prefix = app.name.toUpperCase().replace(/-/g, '_') + '_';
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(prefix)) env[k.slice(prefix.length)] = v;
  }
  const dotEnvPath = path.join(app.dir, '.env');
  if (fs.existsSync(dotEnvPath)) {
    try { Object.assign(env, parseDotEnv(fs.readFileSync(dotEnvPath, 'utf8'))); }
    catch (e) { log(app, '.env could not be read: ' + e.message); }
  }
  env.PORT = String(app.port);
  return env;
}

function scanRequiredEnv(app) {
  const found = new Set();
  const re = /process\.env\.([A-Za-z0-9_]+)|process\.env\[['"]([A-Za-z0-9_]+)['"]\]/g;
  let files = [];
  try { files = fs.readdirSync(app.dir).filter((f) => f.endsWith('.js')); } catch (e) {}
  for (const f of files) {
    try {
      const src = fs.readFileSync(path.join(app.dir, f), 'utf8');
      let m; while ((m = re.exec(src))) found.add(m[1] || m[2]);
    } catch (e) {}
  }
  found.delete('PORT');
  return [...found].sort();
}

function envSummary(app) {
  if (app.type !== 'node') return { required: [], present: [], missing: [] };
  const env = appEnv(app);
  const required = scanRequiredEnv(app);
  const present = required.filter((k) => env[k] !== undefined && env[k] !== '');
  return { required, present, missing: required.filter((k) => !present.includes(k)) };
}

function isValidName(name) {
  return /^[a-z0-9][a-z0-9-]{0,30}$/.test(name);
}

function detectType(dir) {
  if (fs.existsSync(path.join(dir, 'server.js'))) return 'node';
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (j.main || (j.scripts && j.scripts.start)) return 'node';
    } catch (e) { /* broken package.json -> treat as static/empty */ }
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'static';
  return 'empty';
}

function entryFile(app) {
  if (fs.existsSync(path.join(app.dir, 'server.js'))) return 'server.js';
  const pkgPath = path.join(app.dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (j.main && fs.existsSync(path.join(app.dir, j.main))) return j.main;
    } catch (e) {}
    if (fs.existsSync(path.join(app.dir, 'index.js'))) return 'index.js';
  }
  return null;
}

function scanApps() {
  const names = fs.readdirSync(APPS_DIR).filter((n) => {
    try { return fs.statSync(path.join(APPS_DIR, n)).isDirectory(); } catch (e) { return false; }
  }).sort();
  const seen = new Set();
  names.forEach((name, i) => {
    if (!isValidName(name)) return;
    seen.add(name);
    const dir = path.join(APPS_DIR, name);
    const type = detectType(dir);
    const existing = apps.get(name);
    if (existing) {
      existing.type = type;
      existing.port = BASE_PORT + 1 + i;
      existing.dir = dir;
    } else {
      apps.set(name, {
        name, dir, type, port: BASE_PORT + 1 + i,
        status: type === 'node' ? 'stopped' : type,
        child: null, logs: [], restarts: [], lastStart: null, error: null,
      });
    }
  });
  for (const name of [...apps.keys()]) {
    if (!seen.has(name)) {
      const a = apps.get(name);
      if (a.child) { try { a.child.kill(); } catch (e) {} }
      apps.delete(name);
    }
  }
  return [...apps.values()];
}

function needsInstall(app) {
  const pkgPath = path.join(app.dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(j.dependencies || {}).length + Object.keys(j.devDependencies || {}).length;
    return deps > 0 && !fs.existsSync(path.join(app.dir, 'node_modules'));
  } catch (e) { return false; }
}

function startNodeApp(app) {
  if (app.type !== 'node') return;
  if (app.child) return;
  const entry = entryFile(app);
  if (!entry) { app.status = 'error'; app.error = 'No server.js / main file found'; return; }

  const run = () => {
    app.status = 'starting';
    const summary = envSummary(app);
    const child = spawn('node', [entry], {
      cwd: app.dir,
      env: appEnv(app),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.child = child;
    app.lastStart = new Date().toISOString();
    log(app, 'started: node ' + entry + ' on port ' + app.port
      + ' | env: ' + (summary.present.join(', ') || 'none')
      + (summary.missing.length ? ' | MISSING: ' + summary.missing.join(', ') : ''));
    child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(app, l)));
    child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(app, '[err] ' + l)));
    child.on('exit', (code) => {
      if (app.child !== child) return; // stale exit from a previous child — ignore
      app.child = null;
      if (app.status === 'stopping') { app.status = 'stopped'; log(app, 'stopped'); return; }
      app.status = 'crashed';
      log(app, 'exited with code ' + code);
      const now = Date.now();
      app.restarts = app.restarts.filter((t) => now - t < 60000);
      if (app.restarts.length < MAX_RESTARTS) {
        app.restarts.push(now);
        log(app, 'auto-restarting in 2s...');
        setTimeout(() => { if (apps.has(app.name)) startNodeApp(app); }, 2000);
      } else {
        app.error = 'Crashed repeatedly — check logs, fix the app, then Restart';
        log(app, 'too many restarts, giving up until manual Restart');
      }
    });
    // Give the child a moment, then mark running if still alive.
    setTimeout(() => { if (app.child === child && app.status === 'starting') app.status = 'running'; }, 800);
  };

  if (needsInstall(app)) {
    app.status = 'installing';
    log(app, 'running npm install (first run, dependencies found)...');
    const inst = spawn('npm', ['install', '--no-audit', '--no-fund'], { cwd: app.dir, stdio: ['ignore', 'pipe', 'pipe'] });
    inst.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(app, l)));
    inst.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(app, '[npm] ' + l)));
    inst.on('exit', (code) => {
      if (code === 0) { log(app, 'npm install done'); run(); }
      else { app.status = 'error'; app.error = 'npm install failed (code ' + code + ') — see logs'; }
    });
  } else {
    run();
  }
}

function stopNodeApp(app) {
  if (!app.child) { app.status = 'stopped'; return; }
  const child = app.child;
  app.status = 'stopping';
  try { child.kill('SIGTERM'); } catch (e) {}
  setTimeout(() => { if (app.child === child) { try { child.kill('SIGKILL'); } catch (e) {} } }, 3000);
}

function startAllNodeApps() {
  for (const app of apps.values()) if (app.type === 'node') startNodeApp(app);
}

// ---------- static file serving ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

function serveStatic(app, urlPath, res) {
  let rel = decodeURIComponent(urlPath || '/').split('?')[0];
  if (rel === '/' || rel === '') rel = '/index.html';
  // Never serve dotfiles (.env, .git, ...) — env files must stay private.
  if (rel.split('/').some((p) => p.startsWith('.') && p !== '.' && p !== '..')) {
    return sendText(res, 404, 'Not found');
  }
  const safe = path.normalize(path.join(app.dir, rel));
  if (!safe.startsWith(app.dir)) return sendText(res, 403, 'Forbidden');
  fs.stat(safe, (err, st) => {
    if (err || !st.isFile()) {
      // SPA-style fallback: if the app has index.html, serve it for unknown paths
      const idx = path.join(app.dir, 'index.html');
      if (fs.existsSync(idx) && !rel.startsWith('/api/')) {
        return fs.readFile(idx, (e2, data) => {
          if (e2) return sendText(res, 404, 'Not found');
          res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(data);
        });
      }
      return sendText(res, 404, 'Not found: ' + rel);
    }
    fs.readFile(safe, (e2, data) => {
      if (e2) return sendText(res, 500, 'Read error');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

// ---------- reverse proxy ----------
function proxyToApp(app, req, res, strippedPath) {
  if (!app.child || (app.status !== 'running' && app.status !== 'starting')) {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(downPage(app));
  }
  const targetPath = strippedPath || '/';
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const headers = { ...req.headers, host: '127.0.0.1:' + app.port };
  delete headers['connection'];
  const proxy = http.request({
    hostname: '127.0.0.1', port: app.port, method: req.method,
    path: targetPath + qs, headers,
  }, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  proxy.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(downPage(app));
  });
  req.pipe(proxy);
}

function downPage(app) {
  return '<!doctype html><html><head><title>' + app.name + ' is down</title><style>body{font-family:system-ui;background:#12131b;color:#e6e9f5;display:grid;place-items:center;min-height:100vh;margin:0}div{text-align:center;padding:32px}h1{color:#f59e0b}a{color:#8b7cf6}</style></head><body><div><h1>' + app.name + ' is not running</h1><p>' + (app.error || 'The app process is stopped or crashed.') + '</p><p><a href="/">Back to Test Hub</a> — open Logs there and press Restart.</p></div></body></html>';
}

// ---------- helpers ----------
function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(text);
}
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
function publicApp(a) {
  return {
    name: a.name, type: a.type, port: a.type === 'node' ? a.port : null,
    status: a.status, url: '/apps/' + a.name + '/',
 lastStart: a.lastStart,
    error: a.error, logs: a.logs.length, env: envSummary(a),
  };
}

// ---------- dashboard ----------
function dashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test Hub</title><style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:#0f1017;color:#e6e9f5}
header{padding:28px 24px 8px;max-width:960px;margin:0 auto}h1{margin:0;font-size:28px}h1 span{color:#8b7cf6}
p.sub{color:#9aa0b5;margin:8px 0 0}main{max-width:960px;margin:0 auto;padding:16px 24px 48px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-top:20px}
.card{background:#181a26;border:1px solid #262938;border-radius:14px;padding:18px}
.card h2{margin:0 0 4px;font-size:18px}.tag{font-size:12px;color:#9aa0b5;text-transform:uppercase;letter-spacing:.08em}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.running,.static{background:#22c55e}.starting,.installing{background:#f59e0b}.stopped,.crashed,.error{background:#ef4444}
.row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
button,a.btn{border:1px solid #3a3e55;background:#232636;color:#e6e9f5;border-radius:8px;padding:8px 12px;cursor:pointer;text-decoration:none;font-size:14px}
button.primary,a.btn.primary{background:#8b7cf6;border-color:#8b7cf6;color:#fff}
pre.logs{background:#0b0c12;border:1px solid #262938;border-radius:8px;padding:10px;max-height:220px;overflow:auto;font-size:12px;white-space:pre-wrap;margin-top:12px;display:none}
form.clone{background:#181a26;border:1px solid #262938;border-radius:14px;padding:18px;margin-top:24px}
input{width:100%;padding:10px;border-radius:8px;border:1px solid #3a3e55;background:#0b0c12;color:#e6e9f5;margin:6px 0 10px}
code{background:#232636;padding:2px 6px;border-radius:6px;font-size:13px}
footer{color:#9aa0b5;font-size:13px;margin-top:28px;line-height:1.7}
</style></head><body><header><h1>Test <span>Hub</span></h1>
<p class="sub">One main server, many small servers. Drop a folder in <code>apps/</code> or clone a GitHub repo — it appears here.</p></header>
<main><div class="grid" id="grid"><p style="color:#9aa0b5">Loading apps…</p></div>
<form class="clone" id="cloneForm"><h2 style="margin:0 0 4px;font-size:18px">Add from GitHub</h2>
<p style="color:#9aa0b5;margin:0 0 8px;font-size:14px">Paste a public repo URL. It is cloned into <code>apps/</code> and auto-detected (static or Node).</p>
<input id="repo" placeholder="https://github.com/owner/repo" required>
<button class="primary" type="submit">Clone &amp; add</button> <span id="cloneMsg" style="color:#9aa0b5"></span></form>
<footer>How apps are detected: <code>index.html</code> only → static, served by the hub. <code>server.js</code> (or <code>package.json</code> main) → Node child process on its own port, hub reverse-proxies <code>/apps/&lt;name&gt;/</code> to it. A Node app reads its port from <code>process.env.PORT</code> — never hard-code a port. Static apps need no process at all.<br>Note: this hub runs on this machine only (<code>localhost:${HUB_PORT}</code>). To open it from your phone, deploy this same folder to Render — it already reads <code>$PORT</code>.</footer>
</main><script>
async function load(){
  const g=document.getElementById('grid');
  try{
  const r=await fetch('/api/apps'); if(!r.ok) throw new Error('HTTP '+r.status); const d=await r.json();
  if(!d.apps.length){g.innerHTML='<p style="color:#9aa0b5">No apps yet. Add one below, or drop a folder into <code>apps/</code> and refresh.</p>';return;}
  g.innerHTML=d.apps.map(a=>'<div class="card"><div class="tag">'+a.type+' · '+(a.port?'port '+a.port:'no process')+'</div><h2>'+a.name+'</h2><div><span class="dot '+a.status+'"></span>'+a.status+(a.error?' — '+a.error:'')+'</div>'+(a.env&&a.env.required.length?'<div style="color:#9aa0b5;font-size:13px;margin-top:4px">Env: '+(a.env.present.join(', ')||'none')+(a.env.missing.length?' · <span style="color:#f59e0b">missing: '+a.env.missing.join(', ')+'</span>':'')+'</div>':'')+'<div class="row"><a class="btn primary" href="'+a.url+'" target="_blank">Open</a>'+(a.type==='node'?'<button data-app="'+a.name+'" data-action="restart">Restart</button><button data-app="'+a.name+'" data-action="stop">Stop</button>':'')+'<button data-app="'+a.name+'" data-action="logs">Logs</button></div><pre class="logs" id="logs-'+a.name+'"></pre></div>').join('');
  }catch(e){ g.innerHTML='<p style="color:#f59e0b">Could not load apps: '+e.message+'. <button onclick="load()">Retry</button></p>'; }
}
async function act(name,action){await fetch('/api/apps/'+name+'/'+action,{method:'POST'});setTimeout(load,1200);}
async function logs(name){const el=document.getElementById('logs-'+name);const r=await fetch('/api/apps/'+name+'/logs');const d=await r.json();el.style.display='block';el.textContent=d.lines.join('\\n')||'(no logs yet)';}
document.getElementById('cloneForm').addEventListener('submit',async e=>{e.preventDefault();const m=document.getElementById('cloneMsg');m.textContent='Cloning…';const r=await fetch('/api/apps/clone',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repo:document.getElementById('repo').value})});const d=await r.json();m.textContent=d.ok?('Added: '+d.app.name):('Error: '+(d.error||'failed'));if(d.ok)load();});
document.getElementById('grid').addEventListener('click',e=>{const b=e.target.closest('button[data-action]');if(!b)return;if(b.dataset.action==='logs')logs(b.dataset.app);else act(b.dataset.app,b.dataset.action);});
load();setInterval(load,10000);
</script></body></html>`;
}

// ---------- server ----------
scanApps();
startAllNodeApps();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;

  if (pathname === '/health') return sendJson(res, 200, { ok: true, hub: 'test-hub', apps: apps.size, uptimeSec: Math.floor((Date.now() - hubStart) / 1000) });
  if (pathname === '/') return sendText(res, 200, dashboardHtml(), 'text/html; charset=utf-8');
  if (pathname === '/api/apps' && req.method === 'GET') {
    scanApps();
    return sendJson(res, 200, { apps: [...apps.values()].map(publicApp) });
  }
  if (pathname === '/api/apps/clone' && req.method === 'POST') {
    const body = await readBody(req);
    const repo = String(body.repo || '').trim();
    const m = repo.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(\.git)?\/?$/);
    if (!m) return sendJson(res, 400, { ok: false, error: 'Use a GitHub repo URL like https://github.com/owner/repo' });
    const name = m[2].toLowerCase();
    if (!isValidName(name)) return sendJson(res, 400, { ok: false, error: 'Repo name is not a valid app name' });
    const dest = path.join(APPS_DIR, name);
    if (fs.existsSync(dest)) return sendJson(res, 409, { ok: false, error: 'App "' + name + '" already exists' });
    const child = spawn('git', ['clone', '--depth', '1', repo, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      if (code !== 0) return sendJson(res, 500, { ok: false, error: 'git clone failed: ' + err.slice(-300) });
      scanApps();
      const app = apps.get(name);
      if (app && app.type === 'node') startNodeApp(app);
      sendJson(res, 200, { ok: true, app: publicApp(app) });
    });
    return;
  }

  const appMatch = pathname.match(/^\/(?:apps|api\/apps)\/([a-z0-9][a-z0-9-]{0,30})(?:\/(.*))?$/);
  if (appMatch) {
    const name = appMatch[1];
    const rest = appMatch[2];
    scanApps();
    const app = apps.get(name);
    if (!app) return sendJson(res, 404, { error: 'App not found: ' + name });
    if (pathname.startsWith('/api/apps/')) {
      if (rest === 'logs' && req.method === 'GET') return sendJson(res, 200, { name, lines: app.logs.slice(-100) });
      if (rest === 'restart' && req.method === 'POST') {
        if (app.type === 'node') {
          stopNodeApp(app);
          // Wait for the old child to actually exit before starting a new
          // one — starting early + the old stop-timer caused the new child
          // to be killed (restart bug, fixed 2026-11-05).
          const t0 = Date.now();
          const wait = setInterval(() => {
            if (!app.child || Date.now() - t0 > 5000) {
              clearInterval(wait);
              app.status = 'stopped'; app.error = null; app.restarts = [];
              startNodeApp(app);
            }
          }, 200);
        }
        scanApps(); return sendJson(res, 200, { ok: true, app: publicApp(app) });
      }
      if (rest === 'stop' && req.method === 'POST') { stopNodeApp(app); return sendJson(res, 200, { ok: true }); }
      return sendJson(res, 404, { error: 'Unknown action' });
    }
    // /apps/<name>/...
    if (app.type === 'static') return serveStatic(app, '/' + (rest || ''), res);
    if (app.type === 'node') return proxyToApp(app, req, res, '/' + (rest || ''));
    return sendText(res, 404, 'App "' + name + '" has no index.html or server.js yet');
  }

  sendText(res, 404, 'Not found — go to / for the Test Hub dashboard');
});

server.listen(HUB_PORT, '0.0.0.0', () => {
  console.log('Test Hub listening on http://localhost:' + HUB_PORT);
  console.log('Apps: ' + ([...apps.values()].map((a) => a.name + '(' + a.type + ')').join(', ') || '(none yet)'));
});

function shutdown() {
  console.log('\nShutting down hub, stopping child apps...');
  for (const app of apps.values()) if (app.child) { try { app.child.kill('SIGTERM'); } catch (e) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
