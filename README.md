# Test Hub — one main server, many small servers

Fresh build, local first. Zero dependencies, bare Node.js only.

## Run it

```sh
cd ~/workspace/test-hub
./start.sh
# or: node server.js
# or: PORT=8080 node server.js
```

Open: **http://localhost:8080**

## How it works

Every app lives in `apps/<name>/` and is auto-detected on every request:

| App folder contains | Type | How it runs |
|---|---|---|
| `index.html` only | static | Served directly by the hub, no process |
| `server.js` (or `package.json` with a main file) | node | Child process on its own localhost port (9101, 9102, …), hub reverse-proxies `/apps/<name>/` to it |

A Node app **must read its port from `process.env.PORT`** — never hard-code a port. See `apps/demo-node/server.js` for the pattern. If a Node app has dependencies and no `node_modules`, the hub runs `npm install` once on first start.

## Dashboard (`/`)

- Lists every app with type, port and status (running / starting / stopped / crashed / static)
- **Open** — opens `/apps/<name>/`
- **Restart / Stop** — Node apps only (crashed apps auto-restart up to 3 times in 60s, then wait for a manual Restart)
- **Logs** — last 100 lines of that app's output
- **Add from GitHub** — paste a public repo URL, the hub clones it into `apps/` and auto-detects it

## Add an app yourself

```sh
# Static site: just copy the folder in
cp -r ~/my-website ~/workspace/test-hub/apps/my-website

# Node app: folder with server.js that listens on process.env.PORT
cp -r ~/my-node-app ~/workspace/test-hub/apps/my-node-app
```

No restart of the hub needed — it rescans `apps/` on every request. Node apps start automatically when first detected.

## Environment variables

Every Node sub-server gets its env from 3 layers (later wins, `PORT` always wins — the hub assigns it, never set it yourself):

1. **Hub env** — local: `test-hub/.env` or shell vars; on Render: the hub service's dashboard Environment tab. Shared by all apps.
2. **Prefixed hub vars** — `<APPNAME>_<KEY>` reaches only that app as `<KEY>`. Example: hub var `DEMO_NODE_API_KEY=xyz` arrives in `demo-node` as `API_KEY=xyz`. This is the way to give secrets on Render, where there is no per-app dashboard.
3. **App `.env` file** — `apps/<name>/.env`, highest priority. Local testing ke liye best. **Never commit a real `.env`** — `.gitignore` already blocks `.env` and `apps/*/.env`. Commit a `.env.example` instead, with dummy values, so the next person knows what is needed.

The dashboard shows, per app, which env keys its code needs (it scans `process.env.X` in the app's `.js` files) and which are missing — **key names only, values are never shown, logged, or returned by the API**. Static serving never returns dotfiles, so a `.env` sitting in a static app folder cannot be downloaded via the hub.

Example — an app that needs an API key:

```sh
# apps/my-app/.env  (local only, gitignored)
API_KEY=xyz123
# or, as a hub var (works on Render too):
MY_APP_API_KEY=xyz123
```

Restart the app after changing its env (dashboard Restart button, or `POST /api/apps/<name>/restart`).

## API

- `GET /health` — `{"ok":true,"hub":"test-hub","apps":N,...}`
- `GET /api/apps` — list apps + status
- `GET /api/apps/<name>/logs` — recent log lines
- `POST /api/apps/<name>/restart` — restart a Node app
- `POST /api/apps/<name>/stop` — stop a Node app
- `POST /api/apps/clone` — `{"repo":"https://github.com/owner/repo"}`

## Demo apps included

- `demo-static` — static page at `/apps/demo-static/`
- `demo-node` — Node server at `/apps/demo-node/`, with `/api/time` and `/api/hello?name=Sam`

## Limits (by design, v1)

- Runs on this machine only (`localhost:8080`). Your phone cannot open `localhost` directly.
- One port per Node app, sequential from 9101. A crash in one app does not take the hub down, but a hub restart restarts all Node apps.
- No auth on the dashboard — this is a local test tool, not a public server. Do not expose it to the internet as-is.
- No WebSocket proxying yet, and no database apps — static + Node HTTP only for now.

## Next step: public URL

This same folder is Render-ready: it already reads `$PORT` and needs no build step (`npm start` → `node server.js`). Deploying it to Render gives the public URL you wanted (`https://<service>.onrender.com/apps/<name>/`), with the same free-tier caveats (750 instance-hours/month, ~15 min idle spin-down).
