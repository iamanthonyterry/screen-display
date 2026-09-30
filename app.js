'use strict';

// ---------- config ----------
const PENS = [
  { name: 'Red marker',  color: '#ff3b30', width: 6,  alpha: 1,   cap: 'round' },
  { name: 'Highlighter', color: '#ffe600', width: 30, alpha: 0.4, cap: 'butt' },
  { name: 'White chalk', color: '#ffffff', width: 5,  alpha: 0.95, cap: 'round' },
  { name: 'Neon cyan',   color: '#00e5ff', width: 5,  alpha: 1,   cap: 'round', glow: 18 },
  { name: 'Green pen',   color: '#34c759', width: 4,  alpha: 1,   cap: 'round' },
  { name: 'Blue brush',  color: '#0a84ff', width: 16, alpha: 0.9, cap: 'round' },
];

const ACTIONS = [
  { id: 'clear',      label: 'Clear drawing',  note: 60, run: () => clearInk() },
  { id: 'toggleHide', label: 'Hide / show',    note: 61, run: () => setHidden(!hidden) },
  { id: 'hide',       label: 'Hide only',      note: null, run: () => setHidden(true) },
  { id: 'show',       label: 'Show only',      note: null, run: () => setHidden(false) },
  { id: 'nextPen',    label: 'Next pen',       note: 62, run: () => setPen(penIndex + 1) },
  { id: 'prevPen',    label: 'Previous pen',   note: 63, run: () => setPen(penIndex - 1) },
  { id: 'undo',       label: 'Undo stroke',    note: 70, run: () => undo() },
  ...PENS.map((p, i) => ({ id: 'pen' + i, label: 'Pen ' + (i + 1) + ': ' + p.name, note: 64 + i, run: () => setPen(i) })),
];

// ---------- state ----------
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('sd.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sd.' + k, JSON.stringify(v)); } catch {} },
};

let penIndex = store.get('pen', 0);
let sizeMul = store.get('size', 1);
let notify = store.get('notify', true);
let hidden = false;
let strokes = [];
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
}
addEventListener('resize', resize);

function drawStroke(ctx, s) {
  const p = s.pts;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = s.cap; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  ctx.globalAlpha = s.alpha; ctx.lineWidth = s.width;
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
    for (const s of active.values()) drawStroke(lctx, s);
  });
}

// ---------- drawing input ----------
committed.parentElement.addEventListener('pointerdown', e => {
  if (e.button > 0 && e.pointerType === 'mouse') return;
  const now = performance.now();
  if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    lastTap = null;
    clearInk();
    return;
  }
  if (hidden) setHidden(false);
  const pen = PENS[penIndex];
  const s = {
    color: pen.color, width: pen.width * sizeMul, alpha: pen.alpha, cap: pen.cap, glow: pen.glow || 0,
    pts: [{ x: e.clientX, y: e.clientY }], t0: now, len: 0,
  };
  active.set(e.pointerId, s);
  e.currentTarget.setPointerCapture(e.pointerId);
  scheduleLive();
});

committed.parentElement.addEventListener('pointermove', e => {
  const s = active.get(e.pointerId);
  if (!s) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (events.length ? events : [e])) {
    const last = s.pts[s.pts.length - 1];
    const d = Math.hypot(ev.clientX - last.x, ev.clientY - last.y);
    if (d < 1) continue;
    s.len += d;
    s.pts.push({ x: ev.clientX, y: ev.clientY });
  }
  scheduleLive();
});

function endStroke(e) {
  const s = active.get(e.pointerId);
  if (!s) return;
  active.delete(e.pointerId);
  const now = performance.now();
  if (e.type === 'pointerup' && s.len < 10 && now - s.t0 < 250) lastTap = { t: now, x: e.clientX, y: e.clientY };
  strokes.push(s);
  drawStroke(cctx, s);
  scheduleLive();
}
for (const t of ['pointerup', 'pointercancel']) committed.parentElement.addEventListener(t, endStroke);
committed.parentElement.addEventListener('contextmenu', e => e.preventDefault());

// ---------- commands ----------
function clearInk() {
  strokes = [];
  active.clear();
  cctx.clearRect(0, 0, committed.width, committed.height);
  lctx.clearRect(0, 0, live.width, live.height);
  toast('Cleared');
}
function undo() {
  strokes.pop();
  redrawCommitted();
  toast('Undo');
}
function setHidden(h) {
  hidden = h;
  $('ink').classList.toggle('hidden', h);
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
function renderPens() {
  const box = $('pens');
  box.innerHTML = '';
  PENS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = i === penIndex ? 'active' : '';
    const bar = document.createElement('i');
    bar.style.background = p.color;
    bar.style.opacity = p.alpha;
    bar.style.height = Math.max(3, Math.min(p.width, 16)) + 'px';
    if (p.glow) bar.style.boxShadow = `0 0 8px ${p.color}`;
    b.append(bar, document.createTextNode(p.name));
    b.onclick = () => setPen(i);
    box.append(b);
  });
  renderQuickPens();
}

function renderQuickPens() {
  const box = $('quickPens');
  box.innerHTML = '';
  PENS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = i === penIndex ? 'active' : '';
    b.title = p.name;
    const dot = document.createElement('i');
    dot.style.background = p.color;
    dot.style.opacity = Math.max(p.alpha, 0.6);
    if (p.glow) dot.style.boxShadow = `0 0 8px ${p.color}`;
    b.append(dot);
    b.onclick = () => { setPen(i); box.hidden = true; };
    box.append(b);
  });
  $('penBtn').style.color = PENS[penIndex].color;
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

// ---------- video ----------
const video = $('video');
let stream = null;

async function startCamera(deviceId) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  video.srcObject = null;
  $('noVideo').classList.toggle('off', bgMode !== 'camera');
  if (!deviceId || bgMode !== 'camera') return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    video.srcObject = stream;
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
  $('colorRow').style.display = blank ? '' : 'none';
  $('camRow').style.display = $('fitRow').style.display = blank ? 'none' : '';
  if (blank) startCamera(null); // releases the camera
  else startCamera($('camSelect').value);
}
$('bgMode').onchange = applyBackground;
$('bgColor').oninput = applyBackground;

$('fitSelect').value = store.get('fit', 'contain');
function applyFit() { video.style.objectFit = $('fitSelect').value; store.set('fit', $('fitSelect').value); }
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
