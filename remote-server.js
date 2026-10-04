'use strict';
// LAN hub: serves the viewer page over HTTP and relays WebSocket messages between
// the host window (the Electron renderer) and PIN-authenticated browser viewers.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_VIEWER_MSG = 64 * 1024;
const MAX_FAILS = 5;
const BLOCK_MS = 60 * 1000;

let srv = null;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${port}`);
  }
  return out;
}

const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

function start({ port, pin }) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.resolve({ ok: false, error: 'Invalid port' });
  if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) return Promise.resolve({ ok: false, error: 'PIN must be 4–8 digits' });

  if (srv && srv.port === port) {
    srv.pin = pin;
    return Promise.resolve({ ok: true, port, token: srv.token, urls: lanUrls(port) });
  }

  return stop().then(() => new Promise(resolve => {
    const s = { port, pin, token: crypto.randomBytes(24).toString('hex'), host: null, viewers: new Map(), fails: new Map(), seq: 0 };
    const page = fs.readFileSync(path.join(__dirname, 'remote.html'));

    s.server = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(page);
      } else {
        res.writeHead(404); res.end();
      }
    });
    s.wss = new WebSocketServer({ server: s.server, maxPayload: 16 * 1024 * 1024 });

    s.wss.on('connection', (ws, req) => {
      req.socket.setNoDelay(true);
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      const url = new URL(req.url, 'http://x');
      if (url.searchParams.get('role') === 'host') return onHost(s, ws, url.searchParams.get('token') || '');
      onViewer(s, ws, req);
    });

    s.ping = setInterval(() => {
      for (const ws of s.wss.clients) {
        if (!ws.alive) { ws.terminate(); continue; }
        ws.alive = false; ws.ping();
      }
    }, 15000);

    s.server.once('error', e => resolve({ ok: false, error: e.code === 'EADDRINUSE' ? `Port ${port} is in use` : e.message }));
    s.server.listen(port, '0.0.0.0', () => {
      s.server.on('error', () => {});
      srv = s;
      resolve({ ok: true, port, token: s.token, urls: lanUrls(port) });
    });
  }));
}

function onHost(s, ws, token) {
  if (!safeEq(token, s.token)) return ws.close(4001, 'bad token');
  if (s.host) s.host.close(4002, 'replaced');
  s.host = ws;
  for (const v of s.viewers.values()) if (v.authed) send(v.ws, { t: 'host', online: true });
  for (const [id, v] of s.viewers) if (v.authed) send(ws, { t: 'join', id });

  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    const { to, except, ...rest } = m;
    const out = JSON.stringify(rest);
    if (to) {
      const v = s.viewers.get(to);
      if (v && v.authed && v.ws.readyState === 1) v.ws.send(out);
    } else {
      for (const [id, v] of s.viewers) if (v.authed && id !== except && v.ws.readyState === 1) v.ws.send(out);
    }
  });
  ws.on('close', () => {
    if (s.host !== ws) return;
    s.host = null;
    for (const v of s.viewers.values()) if (v.authed) send(v.ws, { t: 'host', online: false });
  });
}

function onViewer(s, ws, req) {
  const origin = req.headers.origin;
  if (origin) {
    let h = null; try { h = new URL(origin).host; } catch {}
    if (h !== req.headers.host) return ws.close(4003, 'bad origin'); // blocks other websites from connecting
  }
  const ip = req.socket.remoteAddress;
  const v = { ws, authed: false, id: null };
  const timer = setTimeout(() => { if (!v.authed) ws.close(); }, 10000);

  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > MAX_VIEWER_MSG) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (!v.authed) {
      if (m.t !== 'login') return;
      const f = s.fails.get(ip) || { n: 0, until: 0 };
      if (Date.now() < f.until) return send(ws, { t: 'auth', ok: false, error: 'Too many attempts — wait a minute' });
      if (typeof m.pin === 'string' && safeEq(m.pin, s.pin)) {
        s.fails.delete(ip);
        v.authed = true; v.id = 'c' + (++s.seq);
        clearTimeout(timer);
        s.viewers.set(v.id, v);
        send(ws, { t: 'auth', ok: true, id: v.id, host: !!s.host });
        send(s.host, { t: 'join', id: v.id });
      } else {
        f.n++;
        if (f.n >= MAX_FAILS) { f.n = 0; f.until = Date.now() + BLOCK_MS; }
        s.fails.set(ip, f);
        send(ws, { t: 'auth', ok: false, error: 'Wrong PIN' });
      }
      return;
    }
    if (m.t === 'login') return;
    delete m.to; delete m.except;
    m.from = v.id;
    send(s.host, m);
  });
  ws.on('close', () => {
    clearTimeout(timer);
    if (v.authed) { s.viewers.delete(v.id); send(s.host, { t: 'leave', id: v.id }); }
  });
}

function stop() {
  const s = srv;
  srv = null;
  if (!s) return Promise.resolve();
  clearInterval(s.ping);
  for (const ws of s.wss.clients) ws.terminate();
  return new Promise(r => { s.wss.close(); s.server.close(() => r()); s.server.closeAllConnections(); });
}

module.exports = { start, stop };
