'use strict';

// ---------- config ----------
const PENS = [
  { name: 'Red marker',  color: '#ff3b30', width: 6,  alpha: 1,   cap: 'round' },
  { name: 'Highlighter', color: '#ffe600', width: 30, alpha: 0.4, cap: 'butt' },
  { name: 'White chalk', color: '#ffffff', width: 5,  alpha: 0.95, cap: 'round' },
  { name: 'Neon cyan',   color: '#00e5ff', width: 5,  alpha: 1,   cap: 'round', glow: 18 },
  { name: 'Green pen',   color: '#34c759', width: 4,  alpha: 1,   cap: 'round' },
  { name: 'Blue brush',  color: '#0a84ff', width: 16, alpha: 0.9, cap: 'round' },
  { name: 'Black pen',   color: '#000000', width: 5,  alpha: 1,   cap: 'round' },
  { name: 'Custom',      color: '#ff00ff', width: 5,  alpha: 1,   cap: 'round', custom: true },
  { name: 'Eraser',      color: '#9a9a9a', width: 30, alpha: 1,   cap: 'round', eraser: true },
];
const CUSTOM = PENS.findIndex(p => p.custom);
const ERASER = PENS.findIndex(p => p.eraser);

const ACTIONS = [
  { id: 'clear',      label: 'Clear drawing',  note: 60, run: () => clearInk() },
  { id: 'toggleHide', label: 'Hide / show',    note: 61, run: () => setHidden(!hidden) },
  { id: 'hide',       label: 'Hide only',      note: null, run: () => setHidden(true) },
  { id: 'show',       label: 'Show only',      note: null, run: () => setHidden(false) },
  { id: 'nextPen',    label: 'Next pen',       note: 62, run: () => setPen(penIndex + 1) },
  { id: 'prevPen',    label: 'Previous pen',   note: 63, run: () => setPen(penIndex - 1) },
  { id: 'undo',       label: 'Undo stroke',    note: 70, run: () => undo() },
  ...PENS.map((p, i) => ({ id: 'pen' + i, label: 'Pen ' + (i + 1) + ': ' + p.name, note: i < 6 ? 64 + i : null, run: () => setPen(i) })),
];

// ---------- state ----------
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sd.' + k, JSON.stringify(v)); } catch {} },
};

let penIndex = store.get('pen', 0);
let sizeMul = store.get('size', 1);
PENS[CUSTOM].color = store.get('customColor', PENS[CUSTOM].color);
let notify = store.get('notify', true);
let hidden = false;
let strokes = [];
let strokeSeq = 0;
const active = new Map(); // pointerId -> stroke
let lastTap = null;
let midiMap = store.get('midiMap', null) || Object.fromEntries(ACTIONS.map(a => [a.id, a.note]));
let learning = null;

// ---------- canvas ----------
const committed = $('committed'), live = $('live');
const cctx = committed.getContext('2d'), lctx = live.getContext('2d');
let dpr = 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  for (const c of [committed, live]) {
    c.width = Math.round(innerWidth * dpr);
    c.height = Math.round(innerHeight * dpr);
  }
  redrawCommitted();
  rmtSend({ t: 'view', w: innerWidth, h: innerHeight });
}
addEventListener('resize', resize);

function drawStroke(ctx, s, preview) {
  const p = s.pts;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = s.cap; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  ctx.globalAlpha = s.alpha; ctx.lineWidth = s.width;
  if (s.erase) {
    if (preview) { ctx.strokeStyle = ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.35; }
    else ctx.globalCompositeOperation = 'destination-out';
  }
  if (s.glow) { ctx.shadowColor = s.color; ctx.shadowBlur = s.glow; }
  if (p.length === 1) {
    ctx.beginPath(); ctx.arc(p[0].x, p[0].y, s.width / 2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length - 1; i++) {
      ctx.quadraticCurveTo(p[i].x, p[i].y, (p[i].x + p[i + 1].x) / 2, (p[i].y + p[i + 1].y) / 2);
    }
    ctx.lineTo(p[p.length - 1].x, p[p.length - 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

// erasing happens live: each new segment is cut out of the committed canvas immediately
function eraseSegment(s, a, b) {
  cctx.save();
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.globalCompositeOperation = 'destination-out';
  cctx.lineCap = cctx.lineJoin = 'round';
  cctx.lineWidth = s.width; cctx.fillStyle = cctx.strokeStyle = '#000';
  cctx.beginPath();
  if (b) { cctx.moveTo(a.x, a.y); cctx.lineTo(b.x, b.y); cctx.stroke(); }
  else { cctx.arc(a.x, a.y, s.width / 2, 0, Math.PI * 2); cctx.fill(); }
  cctx.restore();
}

function redrawCommitted() {
  cctx.clearRect(0, 0, committed.width, committed.height);
  for (const s of strokes) drawStroke(cctx, s);
}

let rafPending = false;
function scheduleLive() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    lctx.clearRect(0, 0, live.width, live.height);
    for (const s of active.values()) drawStroke(lctx, s, true);
  });
}

// ---------- drawing input ----------
committed.parentElement.addEventListener('pointerdown', e => {
  if (e.button > 0 && e.pointerType === 'mouse') return;
  const now = performance.now();
  if (lastTap && lastTap.n >= 2 && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    lastTap = null;
    clearInk();
    return;
  }
  if (hidden) setHidden(false);
  const pen = PENS[penIndex];
  const s = {
    color: pen.color, width: pen.width * sizeMul, alpha: pen.alpha, cap: pen.cap, glow: pen.glow || 0, erase: !!pen.eraser,
    pts: [{ x: e.clientX, y: e.clientY }], t0: now, len: 0, id: 'h' + (++strokeSeq),
  };
  active.set(e.pointerId, s);
  rmtSend({ t: 'ss', ...rmtStrokeHead(s), p: rmtFlat(s.pts) });
  if (s.erase) eraseSegment(s, s.pts[0]);
  e.currentTarget.setPointerCapture(e.pointerId);
  scheduleLive();
});

committed.parentElement.addEventListener('pointermove', e => {
  const s = active.get(e.pointerId);
  if (!s) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const from = s.pts.length;
  for (const ev of (events.length ? events : [e])) {
    const last = s.pts[s.pts.length - 1];
    const d = Math.hypot(ev.clientX - last.x, ev.clientY - last.y);
    if (d < 1) continue;
    s.len += d;
    const pt = { x: ev.clientX, y: ev.clientY };
    s.pts.push(pt);
    if (s.erase) eraseSegment(s, last, pt);
  }
  if (s.pts.length > from) rmtSend({ t: 'sp', id: s.id, p: rmtFlat(s.pts.slice(from)) });
  if (!s.erase) scheduleLive();
});

function endStroke(e) {
  const s = active.get(e.pointerId);
  if (!s) return;
  active.delete(e.pointerId);
  const now = performance.now();
  if (e.type === 'pointerup' && s.len < 10 && now - s.t0 < 250) {
    const chained = lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
    lastTap = { t: now, x: e.clientX, y: e.clientY, n: chained ? lastTap.n + 1 : 1 };
  } else lastTap = null;
  strokes.push(s);
  if (!s.erase) drawStroke(cctx, s);
  scheduleLive();
  rmtSend({ t: 'se', id: s.id });
}
for (const t of ['pointerup', 'pointercancel']) committed.parentElement.addEventListener(t, endStroke);
committed.parentElement.addEventListener('contextmenu', e => e.preventDefault());

// ---------- commands ----------
function clearInk() {
  strokes = [];
  active.clear();
  cctx.clearRect(0, 0, committed.width, committed.height);
  lctx.clearRect(0, 0, live.width, live.height);
  rmtSend({ t: 'clear' });
  toast('Cleared');
}
function undo() {
  const s = strokes.pop();
  redrawCommitted();
  if (s) rmtSend({ t: 'undo', id: s.id });
  toast('Undo');
}
function setHidden(h) {
  hidden = h;
  $('ink').classList.toggle('hidden', h);
  rmtSend({ t: 'hidden', v: h });
  toast(h ? 'Drawing hidden' : 'Drawing shown');
}
function setPen(i) {
  penIndex = (i + PENS.length) % PENS.length;
  store.set('pen', penIndex);
  renderPens();
  toast('Pen: ' + PENS[penIndex].name);
}

let toastTimer;
function toast(msg) {
  if (!notify) return;
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1200);
}

function runAction(id) {
  const a = ACTIONS.find(a => a.id === id);
  if (a) a.run();
}

// ---------- UI ----------
const ERASER_SVG = '<svg viewBox="0 0 24 24" width="SZ" height="SZ" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">'
  + '<path d="M16.2 3.8a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L10 18H5.5L3.8 16.3a2 2 0 0 1 0-2.8z"/>'
  + '<path d="M8.5 7.5l8 8M10 18h10"/></svg>';
function eraserIcon(size) {
  const span = document.createElement('span');
  span.className = 'eraserIcon';
  span.innerHTML = ERASER_SVG.replaceAll('SZ', size);
  return span;
}

function renderPens() {
  const box = $('pens');
  box.innerHTML = '';
  PENS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = i === penIndex ? 'active' : '';
    let bar;
    if (p.eraser) bar = eraserIcon(22);
    else {
      bar = document.createElement('i');
      bar.style.background = p.color;
      bar.style.opacity = p.alpha;
      bar.style.height = Math.max(3, Math.min(p.width, 16)) + 'px';
      if (p.glow) bar.style.boxShadow = `0 0 8px ${p.color}`;
    }
    b.append(bar, document.createTextNode(p.name));
    b.onclick = () => setPen(i);
    box.append(b);
  });
  renderQuickPens();
  $('customColor').value = PENS[CUSTOM].color;
}

function setCustomColor(c) {
  PENS[CUSTOM].color = c;
  store.set('customColor', c);
  if (penIndex !== CUSTOM) setPen(CUSTOM); else renderPens();
}
$('customColor').oninput = e => setCustomColor(e.target.value);

// created once so it isn't destroyed while the picker is open
const quickPick = document.createElement('input');
quickPick.type = 'color';
quickPick.title = 'Custom color';
quickPick.oninput = e => setCustomColor(e.target.value);

function renderQuickPens() {
  const box = $('quickPens');
  box.replaceChildren();
  PENS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = i === penIndex ? 'active' : '';
    b.title = p.name;
    let dot;
    if (p.eraser) dot = eraserIcon(20);
    else {
      dot = document.createElement('i');
      dot.style.background = p.color;
      dot.style.opacity = Math.max(p.alpha, 0.6);
      if (p.glow) dot.style.boxShadow = `0 0 8px ${p.color}`;
    }
    b.append(dot);
    b.onclick = () => { setPen(i); box.hidden = true; };
    box.append(b);
  });
  quickPick.value = PENS[CUSTOM].color;
  box.append(quickPick);
  const penBtn = $('penBtn');
  if (PENS[penIndex].eraser) { penBtn.replaceChildren(eraserIcon(20)); penBtn.style.color = '#fff'; }
  else { penBtn.textContent = '✎'; penBtn.style.color = PENS[penIndex].color; }
}

$('penBtn').onclick = () => { $('quickPens').hidden = !$('quickPens').hidden; };
addEventListener('pointerdown', e => {
  if (!e.target.closest('#quickPens, #penBtn')) $('quickPens').hidden = true;
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = n => n == null ? 'unassigned' : `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1} (${n})`;

function renderMap() {
  const box = $('mapList');
  box.innerHTML = '';
  for (const a of ACTIONS) {
    const row = document.createElement('div');
    row.className = 'map';
    const label = document.createElement('span'); label.textContent = a.label;
    const code = document.createElement('code'); code.textContent = noteName(midiMap[a.id]);
    const learn = document.createElement('button');
    learn.textContent = learning === a.id ? '…' : 'Learn';
    learn.className = learning === a.id ? 'learning' : '';
    learn.onclick = () => { learning = learning === a.id ? null : a.id; renderMap(); };
    const clr = document.createElement('button'); clr.textContent = '✕'; clr.title = 'Unassign';
    clr.onclick = () => { midiMap[a.id] = null; store.set('midiMap', midiMap); renderMap(); };
    row.append(label, code, learn, clr);
    box.append(row);
  }
}

$('gear').onclick = () => { $('panel').hidden = !$('panel').hidden; };
$('closePanel').onclick = () => { $('panel').hidden = true; };
$('fsBtn').onclick = toggleFullscreen;
$('size').value = sizeMul;
$('size').oninput = e => { sizeMul = +e.target.value; store.set('size', sizeMul); };
document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => runAction(b.dataset.act));

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFullscreen();
  else if (k === 'c') clearInk();
  else if (k === 'h') setHidden(!hidden);
  else if (k === 'z') undo();
  else if (k === 'e') setPen(ERASER);
  else if (k === 'p') setPen(penIndex + 1);
  else if (k === 's') $('panel').hidden = !$('panel').hidden;
  else if (k >= '1' && k <= String(PENS.length)) setPen(+k - 1);
});

// hide cursor / gear after inactivity
let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if ($('panel').hidden) document.body.classList.add('idle'); }, 3000);
}
addEventListener('pointermove', wake);
addEventListener('pointerdown', wake);
wake();

// ---------- remote (stream to / draw from a browser on the LAN) ----------
// The viewer gets the camera over WebRTC and the ink as normalized vector strokes over a
// WebSocket, so remote pen input is drawn here as soon as it arrives.
const rmt = {
  on: store.get('remoteOn', false), port: store.get('remotePort', 8787), pin: store.get('remotePin', null),
  ws: null, token: null, retry: null, viewers: new Set(), peers: new Map(),
};
const newPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
if (!/^\d{4,8}$/.test(rmt.pin)) { rmt.pin = newPin(); store.set('remotePin', rmt.pin); }

const r4 = v => Math.round(v * 1e4) / 1e4;
const rmtFlat = pts => pts.flatMap(p => [r4(p.x / innerWidth), r4(p.y / innerHeight)]);
const rmtBg = () => ({ mode: bgMode, color: $('bgColor').value, fit: $('fitSelect').value });
const rmtStrokeHead = s => ({ id: s.id, c: s.color, w: r4(s.width / innerWidth), a: s.alpha, cap: s.cap, g: r4(s.glow / innerWidth), e: s.erase ? 1 : 0 });

function rmtSend(m) {
  if (rmt.ws && rmt.ws.readyState === 1 && (rmt.viewers.size || m.to)) rmt.ws.send(JSON.stringify(m));
}

function rmtState() {
  const enc = (s, open) => ({ ...rmtStrokeHead(s), p: rmtFlat(s.pts), open });
  return {
    t: 'state', view: { w: innerWidth, h: innerHeight }, bg: rmtBg(), hidden,
    strokes: [...strokes.map(s => enc(s, 0)), ...[...active.values()].map(s => enc(s, 1))],
  };
}

function rmtStatus() {
  const n = rmt.viewers.size;
  $('remoteStatus').textContent = !rmt.on ? '' : rmt.ws ? `(${n} viewer${n === 1 ? '' : 's'})` : '(starting…)';
}

// --- remote input (untrusted: validate everything) ---
const HEX = /^#[0-9a-f]{6}$/i;
const inRange = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
const MAX_REMOTE_PTS = 20000;

function rmtPoints(s, flat) {
  const out = [];
  if (!Array.isArray(flat) || flat.length % 2) return out;
  for (let i = 0; i < flat.length; i += 2) {
    if (!inRange(flat[i], -0.5, 1.5) || !inRange(flat[i + 1], -0.5, 1.5)) continue;
    if (s.pts.length >= MAX_REMOTE_PTS) break;
    const pt = { x: flat[i] * innerWidth, y: flat[i + 1] * innerHeight };
    const last = s.pts[s.pts.length - 1];
    if (last) {
      if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1) continue;
      s.len += Math.hypot(pt.x - last.x, pt.y - last.y);
      if (s.erase) eraseSegment(s, last, pt);
    }
    s.pts.push(pt);
    out.push(flat[i], flat[i + 1]);
  }
  return out;
}

function rmtFinish(id) {
  const s = active.get(id);
  if (!s) return;
  active.delete(id);
  strokes.push(s);
  if (!s.erase) drawStroke(cctx, s);
  scheduleLive();
  rmtSend({ t: 'se', id, except: id.split('.')[0] });
}

function rmtOnMessage(m) {
  if (!m || typeof m !== 'object') return;
  const from = m.from;
  switch (m.t) {
    case 'join':
      rmt.viewers.add(m.id);
      rmtSend({ to: m.id, ...rmtState() });
      rmtStatus();
      break;
    case 'leave':
      rmt.viewers.delete(m.id);
      rmtClosePeer(m.id);
      for (const id of [...active.keys()]) if (typeof id === 'string' && id.startsWith(m.id + '.')) rmtFinish(id);
      rmtStatus();
      break;
    case 'ss': {
      if (typeof m.id !== 'string' || m.id.length > 40 || !m.id.startsWith(from + '.') || active.has(m.id)) return;
      if (!HEX.test(m.c) || !inRange(m.w, 0, 0.25) || !inRange(m.a, 0, 1) || !inRange(m.g || 0, 0, 0.1)) return;
      if (m.cap !== 'round' && m.cap !== 'butt') return;
      if (hidden) setHidden(false);
      const s = { id: m.id, color: m.c, width: m.w * innerWidth, alpha: m.a, cap: m.cap, glow: (m.g || 0) * innerWidth, erase: !!m.e, pts: [], t0: 0, len: 0 };
      const p = rmtPoints(s, m.p);
      if (!s.pts.length) return;
      active.set(s.id, s);
      if (s.erase) eraseSegment(s, s.pts[0]);
      scheduleLive();
      rmtSend({ t: 'ss', id: s.id, c: s.color, w: m.w, a: s.alpha, cap: s.cap, g: m.g || 0, e: m.e ? 1 : 0, p, except: from });
      break;
    }
    case 'sp': {
      const s = typeof m.id === 'string' && m.id.startsWith(from + '.') ? active.get(m.id) : null;
      if (!s) return;
      const p = rmtPoints(s, m.p);
      if (!p.length) return;
      if (!s.erase) scheduleLive();
      rmtSend({ t: 'sp', id: s.id, p, except: from });
      break;
    }
    case 'se':
      if (typeof m.id === 'string' && m.id.startsWith(from + '.')) rmtFinish(m.id);
      break;
    case 'cmd':
      if (m.c === 'clear') clearInk();
      else if (m.c === 'undo') undo();
      else if (m.c === 'hide') setHidden(true);
      else if (m.c === 'show') setHidden(false);
      break;
    case 'rtc': rmtOffer(from, m.sdp); break;
    case 'ice': rmtIce(from, m.c); break;
  }
}

// --- video (WebRTC, host candidates only: LAN) ---
function rmtClosePeer(id) {
  const p = rmt.peers.get(id);
  if (!p) return;
  rmt.peers.delete(id);
  p.pc.close();
}

function rmtOffer(id, sdp) {
  if (!rmt.viewers.has(id) || !sdp || typeof sdp.sdp !== 'string') return;
  rmtClosePeer(id);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const peer = { pc, q: Promise.resolve(), answered: false, early: [] };
  rmt.peers.set(id, peer);
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    if (peer.answered) rmtSend({ t: 'ice', to: id, c: e.candidate });
    else peer.early.push(e.candidate);
  };
  peer.q = peer.q.then(async () => {
    await pc.setRemoteDescription({ type: 'offer', sdp: sdp.sdp });
    const tr = pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
    if (!tr) return;
    tr.direction = 'sendonly';
    const track = stream && stream.getVideoTracks()[0];
    if (track) { try { track.contentHint = 'motion'; } catch {} await tr.sender.replaceTrack(track); }
    await pc.setLocalDescription(await pc.createAnswer());
    rmtSend({ t: 'rtc', to: id, sdp: { type: 'answer', sdp: pc.localDescription.sdp } });
    peer.answered = true;
    for (const c of peer.early) rmtSend({ t: 'ice', to: id, c });
    peer.early = [];
    try {
      const p = tr.sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = 10e6;
      p.degradationPreference = 'maintain-framerate';
      await tr.sender.setParameters(p);
    } catch {}
  }).catch(() => {});
}

function rmtIce(id, c) {
  const peer = rmt.peers.get(id);
  if (!peer || !c || typeof c.candidate !== 'string') return;
  peer.q = peer.q.then(() => peer.pc.addIceCandidate(c)).catch(() => {});
}

function rmtSyncTracks() {
  const track = (stream && stream.getVideoTracks()[0]) || null;
  for (const [id, { pc }] of rmt.peers) {
    const tr = pc.getTransceivers().find(t => t.receiver.track.kind === 'video');
    if (!tr || tr.direction !== 'sendonly') continue;
    // a track that wasn't in the original answer isn't signalled, so the viewer must renegotiate
    if (track && !tr.sender.track) rmtSend({ t: 'renego', to: id });
    else tr.sender.replaceTrack(track).catch(() => {});
  }
}

// --- connection to the local hub ---
function rmtReset() {
  for (const id of [...rmt.peers.keys()]) rmtClosePeer(id);
  for (const id of [...active.keys()]) if (typeof id === 'string') active.delete(id);
  rmt.viewers.clear();
  rmtStatus();
}

function rmtConnect() {
  const ws = new WebSocket(`ws://127.0.0.1:${rmt.port}/?role=host&token=${rmt.token}`);
  rmt.ws = ws;
  ws.onopen = rmtStatus;
  ws.onmessage = e => { try { rmtOnMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    if (rmt.ws !== ws) return;
    rmt.ws = null;
    rmtReset();
    if (rmt.on) rmt.retry = setTimeout(rmtConnect, 1000);
  };
}

async function rmtApply() {
  clearTimeout(rmt.retry);
  const old = rmt.ws;
  rmt.ws = null;
  if (old) old.close();
  rmtReset();
  $('remoteInfo').hidden = !rmt.on;
  $('remoteToggle').checked = rmt.on;
  $('remotePort').value = rmt.port;
  $('remotePin').value = rmt.pin;
  if (!window.remote) { $('remoteSection').hidden = true; return; }
  if (!rmt.on) { await window.remote.stop(); $('remoteUrls').replaceChildren(); return; }
  const r = await window.remote.start({ port: rmt.port, pin: rmt.pin });
  if (!rmt.on) return;
  if (!r.ok) { $('remoteStatus').textContent = '(' + r.error + ')'; $('remoteUrls').replaceChildren(); return; }
  $('remoteUrls').replaceChildren(...r.urls.map(u => { const c = document.createElement('code'); c.textContent = u; return c; }));
  rmt.token = r.token;
  rmtConnect();
}

function setRemote(patch) {
  Object.assign(rmt, patch);
  store.set('remoteOn', rmt.on); store.set('remotePort', rmt.port); store.set('remotePin', rmt.pin);
  rmtApply();
}
$('remoteToggle').onchange = e => setRemote({ on: e.target.checked });
$('remotePort').onchange = e => {
  const p = +e.target.value;
  if (Number.isInteger(p) && p >= 1024 && p <= 65535) setRemote({ port: p }); else e.target.value = rmt.port;
};
$('remotePin').onchange = e => {
  if (/^\d{4,8}$/.test(e.target.value)) setRemote({ pin: e.target.value }); else e.target.value = rmt.pin;
};
$('remotePinNew').onclick = () => setRemote({ pin: newPin() });

// ---------- video ----------
const video = $('video');
let stream = null;

async function startCamera(deviceId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  rmtSyncTracks();
  $('noVideo').classList.toggle('off', bgMode !== 'camera');
  if (!deviceId || bgMode !== 'camera') return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = stream;
    rmtSyncTracks();
    $('noVideo').classList.add('off');
    store.set('cam', deviceId);
  } catch (err) {
    toast('Camera error: ' + err.name);
  }
}

async function listCameras() {
  const sel = $('camSelect');
  try {
    // A throwaway request is needed so device labels are populated.
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach(t => t.stop());
  } catch (err) {
    sel.innerHTML = '<option>Camera access denied</option>';
    return;
  }
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  sel.innerHTML = '<option value="">— none —</option>';
  for (const c of cams) {
    const o = document.createElement('option');
    o.value = c.deviceId; o.textContent = c.label || 'Camera';
    sel.append(o);
  }
  const saved = store.get('cam', null);
  const pick = cams.find(c => c.deviceId === saved) || cams.find(c => /ndi/i.test(c.label));
  if (pick) { sel.value = pick.deviceId; startCamera(pick.deviceId); }
}
$('camSelect').onchange = e => startCamera(e.target.value);

let bgMode = store.get('bgMode', 'camera');
$('bgMode').value = bgMode;
$('bgColor').value = store.get('bgColor', '#000000');

function applyBackground() {
  bgMode = $('bgMode').value;
  store.set('bgMode', bgMode);
  store.set('bgColor', $('bgColor').value);
  const blank = bgMode === 'blank';
  document.body.style.background = blank ? $('bgColor').value : '#000';
  video.style.display = blank ? 'none' : '';
  rmtSend({ t: 'bg', ...rmtBg() });
  $('colorRow').style.display = blank ? '' : 'none';
  $('camRow').style.display = $('fitRow').style.display = blank ? 'none' : '';
  if (blank) startCamera(null); // releases the camera
  else startCamera($('camSelect').value);
}
$('bgMode').onchange = applyBackground;
$('bgColor').oninput = applyBackground;

$('fitSelect').value = store.get('fit', 'contain');
function applyFit() { video.style.objectFit = $('fitSelect').value; store.set('fit', $('fitSelect').value); rmtSend({ t: 'bg', ...rmtBg() }); }
$('fitSelect').onchange = applyFit;

$('notifyToggle').checked = notify;
$('notifyToggle').onchange = () => {
  notify = $('notifyToggle').checked;
  store.set('notify', notify);
  if (!notify) $('toast').classList.remove('show');
};
applyFit();

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', listCameras);
  listCameras();
} else {
  $('camSelect').innerHTML = '<option>Needs https or localhost</option>';
}

// ---------- MIDI ----------
let midiAccess = null;

function onMidi(e) {
  const [status, note, vel] = e.data;
  if ((status & 0xf0) !== 0x90 || !vel) return; // note-on only
  $('lastNote').textContent = noteName(note);
  if (learning) {
    for (const k of Object.keys(midiMap)) if (midiMap[k] === note) midiMap[k] = null;
    midiMap[learning] = note;
    store.set('midiMap', midiMap);
    toast(`Bound ${noteName(note)}`);
    learning = null;
    renderMap();
    return;
  }
  for (const a of ACTIONS) if (midiMap[a.id] === note) a.run();
}

function attachInputs() {
  const sel = $('midiSelect');
  const prev = sel.value || store.get('midiIn', 'all');
  sel.innerHTML = '<option value="all">All inputs</option>';
  for (const inp of midiAccess.inputs.values()) {
    const o = document.createElement('option');
    o.value = inp.id; o.textContent = inp.name;
    sel.append(o);
  }
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : 'all';
  bindInputs();
  $('midiStatus').textContent = midiAccess.inputs.size ? `(${midiAccess.inputs.size} device${midiAccess.inputs.size > 1 ? 's' : ''})` : '(no devices)';
}
function bindInputs() {
  const want = $('midiSelect').value;
  store.set('midiIn', want);
  for (const inp of midiAccess.inputs.values()) inp.onmidimessage = (want === 'all' || want === inp.id) ? onMidi : null;
}
$('midiSelect').onchange = bindInputs;

if (navigator.requestMIDIAccess) {
  navigator.requestMIDIAccess().then(a => {
    midiAccess = a;
    a.onstatechange = attachInputs;
    attachInputs();
  }).catch(() => { $('midiStatus').textContent = '(permission denied)'; });
} else {
  $('midiStatus').textContent = '(not supported — use Chrome or Edge)';
}

// ---------- init ----------
applyBackground();
rmtApply();
renderPens();
renderMap();
resize();

// ---------- updates ----------
(function () {
  if (!window.updater) return;
  let version = '';
  let ready = false;
  const status = $('updateStatus'), btn = $('updateBtn');
  const label = s => {
    switch (s.state) {
      case 'checking': return 'Checking for updates…';
      case 'downloading': return 'Downloading update' + (s.percent != null ? ' ' + s.percent + '%' : '…');
      case 'ready': return 'Update ' + s.version + ' ready';
      case 'current': return 'Up to date';
      case 'dev': return 'Updates only work in the installed app';
      case 'error': return 'Update check failed';
    }
    return '';
  };
  window.updater.version().then(v => { version = v; status.textContent = 'Version ' + v; });
  window.updater.onStatus(s => {
    ready = s.state === 'ready';
    status.textContent = 'Version ' + version + ' — ' + label(s);
    btn.textContent = ready ? 'Restart to update' : 'Check for updates';
    if (ready) toast('Update ready — restart to install');
  });
  btn.onclick = () => ready ? window.updater.install() : window.updater.check();
})();
