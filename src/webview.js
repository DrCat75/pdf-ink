// PDF Ink – webview side. Bundled by build.mjs into media/webview.js.
//
// Coordinates: all ink is stored in PDF.js viewport space at scale 1
// (points, origin top-left of the rotated page). Screen px = pt * zoom,
// canvas px = pt * P.rs (render scale, includes devicePixelRatio).
import * as pdfjsLib from 'pdfjs-dist';
import { getStroke } from 'perfect-freehand';
import { PDFDocument, rgb, BlendMode } from 'pdf-lib';

const vscode = acquireVsCodeApi();
const $ = (s) => document.querySelector(s);
const viewer = $('#viewer');
const pagesEl = $('#pages');
const MAX_PIXELS = 16e6; // per canvas, caps memory at high zoom
const ZOOM_MIN = 0.25, ZOOM_MAX = 6;

const PALETTE = {
  pen: ['#111111', '#1a4fd6', '#d62828', '#2a9d4b', '#8e44ad', '#e67e22'],
  highlighter: ['#ffe14d', '#9be9a8', '#ffb3d9', '#a5d8ff', '#ffc078'],
};
const SIZE_RANGE = { pen: [0.5, 10, 0.1], highlighter: [4, 40, 1], eraser: [2, 40, 1] };
const DEFAULT_PREFS = {
  tool: 'pen',
  pen: { color: '#111111', size: 2.2 },
  highlighter: { color: '#ffe14d', size: 14 },
  eraser: { size: 8, mode: 'stroke' },
  penOnly: false,
  smooth: 0.5, // stroke stabilization 0..1
};

const S = {
  name: '',
  pdf: null,
  bytes: null,
  pages: [],
  orphans: {}, // ink for page indices the PDF no longer has – kept so saving never drops it
  zoom: 1,
  prefs: structuredClone(DEFAULT_PREFS),
  undo: [],
  redo: [],
  sel: null, // { P, ids:Set, bb:[x0,y0,x1,y1] }
  status: '',
  statusErr: false,
  curPage: 0,
};
let G = null; // active pointer gesture
let spaceHeld = false;

// ---------------------------------------------------------------- utilities
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dpr = () => window.devicePixelRatio || 1;

function distPtSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L, 0, 1) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}
function segsCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(c, d, a) * o(c, d, b) < 0 && o(a, b, c) * o(a, b, d) < 0;
}
function segSegDist(a, b, c, d) {
  if (segsCross(a, b, c, d)) return 0;
  return Math.min(distPtSeg(a, c, d), distPtSeg(b, c, d), distPtSeg(c, a, b), distPtSeg(d, a, b));
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const lerpPt = (a, b, t) => [r2(a[0] + (b[0] - a[0]) * t), r2(a[1] + (b[1] - a[1]) * t), r3(a[2] + (b[2] - a[2]) * t)];
const bbOverlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// ---------------------------------------------------------------- strokes
// Stroke: { id, c: color, w: size (pt), hl: highlighter, sp: simulate pressure, pts: [[x,y,p],...] }
// Runtime caches: _outline, _path (Path2D in pt), _bb.
// Stabilization (GoodNotes-like): resample the raw input to even spacing, then
// Gaussian-average along arc length. The window shrinks towards both ends, so the
// stroke still starts where the pen went down and the tip stays under the pen.
const RESAMPLE = 0.5; // pt
function smoothPts(pts, k) {
  if (k <= 0 || pts.length < 3) return pts;
  const rs = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = RESAMPLE - carry;
    while (d <= len) { rs.push(lerpPt(a, b, d / len)); d += RESAMPLE; }
    carry = len - (d - RESAMPLE);
  }
  const last = pts[pts.length - 1], tail = rs[rs.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) rs.push(last);
  const n = rs.length;
  const sigma = (0.4 + k * 3.6) / RESAMPLE; // in samples; k=1 → 4pt
  const R = Math.ceil(2 * sigma);
  const w = Array.from({ length: R + 1 }, (_, j) => Math.exp(-(j * j) / (2 * sigma * sigma)));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.min(R, i, n - 1 - i);
    let x = 0, y = 0, p = 0, W = 0;
    for (let j = -r; j <= r; j++) {
      const q = rs[i + j], wj = w[Math.abs(j)];
      x += q[0] * wj; y += q[1] * wj; p += q[2] * wj; W += wj;
    }
    out[i] = [r2(x / W), r2(y / W), r3(p / W)];
  }
  return out;
}

function outline(s, last = true) {
  return getStroke(s.pts, {
    size: s.w,
    thinning: s.hl ? 0 : 0.6,
    smoothing: 0.5,
    streamline: s.hl ? 0.5 : 0.35,
    simulatePressure: !!s.sp,
    last,
  });
}
function toPath(o) {
  const p = new Path2D();
  if (!o.length) return p;
  p.moveTo(o[0][0], o[0][1]);
  for (let i = 0; i < o.length; i++) {
    const [x0, y0] = o[i], [x1, y1] = o[(i + 1) % o.length];
    p.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  p.closePath();
  return p;
}
function prep(s) {
  if (!s._path) {
    s._outline = outline(s);
    s._path = toPath(s._outline);
    const h = s.w / 2;
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of s.pts) {
      if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y;
      if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
    }
    s._bb = [bb[0] - h, bb[1] - h, bb[2] + h, bb[3] + h];
  }
  return s;
}
const clone = (s, patch) => ({ id: uid(), c: s.c, w: s.w, hl: s.hl, sp: s.sp, pts: s.pts, ...patch });
const plain = (s) => {
  const o = { id: s.id, c: s.c, w: s.w, pts: s.pts };
  if (s.hl) o.hl = 1;
  if (s.sp) o.sp = 1;
  return o;
};
function sanitize(s) {
  if (!s || !Array.isArray(s.pts) || !s.pts.length) return null;
  const pts = s.pts.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
    .map((p) => [+p[0], +p[1], isFinite(p[2]) ? +p[2] : 0.5]);
  if (!pts.length) return null;
  return { id: String(s.id || uid()), c: typeof s.c === 'string' ? s.c : '#111111', w: +s.w || 2, hl: !!s.hl, sp: !!s.sp, pts };
}

// ---------------------------------------------------------------- pages
function buildPage(i, w, h) {
  const el = document.createElement('div');
  el.className = 'page';
  const mk = (cls, opts) => {
    const c = document.createElement('canvas');
    c.className = cls;
    c.width = c.height = 0;
    el.appendChild(c);
    return [c, c.getContext('2d', opts)];
  };
  const P = { i, w, h, el, pdfC: null, rs: 0, inkRs: 0, task: null, visible: false, strokes: [], selEl: null };
  [P.hlC, P.hlX] = mk('hl');
  [P.inkC, P.inkX] = mk('ink');
  [P.liveC, P.liveX] = mk('live', { desynchronized: true });
  el.addEventListener('pointerdown', (e) => onDown(e, P));
  el.addEventListener('pointermove', (e) => onMove(e, P));
  el.addEventListener('pointerup', (e) => onUp(e, P));
  el.addEventListener('pointercancel', (e) => onUp(e, P, true));
  el.addEventListener('pointerleave', () => { if (!G) clearLive(P); });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el._P = P;
  pagesEl.appendChild(el);
  return P;
}

function sizePages() {
  for (const P of S.pages) {
    P.el.style.width = P.w * S.zoom + 'px';
    P.el.style.height = P.h * S.zoom + 'px';
  }
  positionSel();
}

const targetScale = (P) => Math.min(S.zoom * dpr(), Math.sqrt(MAX_PIXELS / (P.w * P.h)));

function sizeInk(P, rs) {
  const W = Math.ceil(P.w * rs), H = Math.ceil(P.h * rs);
  for (const c of [P.hlC, P.inkC, P.liveC]) { c.width = W; c.height = H; }
  P.inkRs = rs;
  drawInk(P);
}

async function renderPage(P) {
  const rs = targetScale(P);
  if (P.inkRs !== rs) sizeInk(P, rs);
  if (P.rs === rs) return; // already rendered or rendering at this scale
  if (P.task) { P.task.cancel(); P.task = null; }
  P.rs = rs;
  const page = await S.pdf.getPage(P.i + 1);
  if (P.rs !== rs || !P.visible) return;
  const vp = page.getViewport({ scale: rs });
  const c = document.createElement('canvas');
  c.className = 'pdf';
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const task = (P.task = page.render({ canvas: c, viewport: vp }));
  try {
    await task.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    console.error(err);
  }
  if (P.task !== task) return;
  P.task = null;
  if (P.pdfC) P.pdfC.replaceWith(c);
  else P.el.prepend(c);
  P.pdfC = c;
}

function releasePage(P) {
  if (P.task) { P.task.cancel(); P.task = null; }
  if (P.pdfC) { P.pdfC.width = 0; P.pdfC.remove(); P.pdfC = null; }
  for (const c of [P.hlC, P.inkC, P.liveC]) c.width = c.height = 0;
  P.rs = P.inkRs = 0;
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const P = e.target._P;
    P.visible = e.isIntersecting;
    if (P.visible) renderPage(P);
    else releasePage(P);
  }
}, { root: viewer, rootMargin: '800px 0px' });

let rerenderTimer = 0;
function renderVisibleSoon() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => S.pages.forEach((P) => P.visible && renderPage(P)), 160);
}

// ---------------------------------------------------------------- ink drawing
function setT(ctx, rs) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(rs, 0, 0, rs, 0, 0);
}
function fillStroke(P, s, dx = 0, dy = 0) {
  const ctx = s.hl ? P.hlX : P.inkX;
  prep(s);
  ctx.fillStyle = s.c;
  if (dx || dy) { ctx.save(); ctx.translate(dx, dy); ctx.fill(s._path); ctx.restore(); }
  else ctx.fill(s._path);
}
function drawInk(P, moving) {
  if (!P.inkRs) return;
  setT(P.hlX, P.inkRs);
  setT(P.inkX, P.inkRs);
  for (const s of P.strokes) {
    if (moving && moving.ids.has(s.id)) fillStroke(P, s, moving.dx, moving.dy);
    else fillStroke(P, s);
  }
}
function clearLive(P) {
  if (P.inkRs) setT(P.liveX, P.inkRs);
}
function drawLiveStroke(P, s) {
  clearLive(P);
  if (!s.pts.length) return;
  P.liveC.classList.toggle('hl', s.hl);
  P.liveX.fillStyle = s.c;
  P.liveX.fill(toPath(outline(s, false)));
}
function drawEraserCursor(P, p) {
  clearLive(P);
  P.liveC.classList.remove('hl');
  const x = P.liveX;
  x.beginPath();
  x.arc(p[0], p[1], S.prefs.eraser.size, 0, Math.PI * 2);
  x.lineWidth = 1 / S.zoom;
  x.strokeStyle = 'rgba(80,80,80,.9)';
  x.stroke();
  x.fillStyle = 'rgba(160,160,160,.15)';
  x.fill();
}
function drawLasso(P, poly) {
  clearLive(P);
  const x = P.liveX;
  P.liveC.classList.remove('hl');
  x.beginPath();
  poly.forEach(([px, py], k) => (k ? x.lineTo(px, py) : x.moveTo(px, py)));
  x.lineWidth = 1.5 / S.zoom;
  x.setLineDash([5 / S.zoom, 4 / S.zoom]);
  x.strokeStyle = '#0e639c';
  x.stroke();
  x.setLineDash([]);
  x.fillStyle = 'rgba(14,99,156,.06)';
  x.fill();
}

// ---------------------------------------------------------------- selection
function setSel(P, ids) {
  clearSel();
  if (!ids.size) return;
  S.sel = { P, ids };
  P.selEl = document.createElement('div');
  P.selEl.className = 'sel';
  P.el.appendChild(P.selEl);
  updateSelBox();
}
function updateSelBox(dx = 0, dy = 0) {
  const sel = S.sel;
  if (!sel) return;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of sel.P.strokes) {
    if (!sel.ids.has(s.id)) continue;
    const b = prep(s)._bb;
    bb[0] = Math.min(bb[0], b[0]); bb[1] = Math.min(bb[1], b[1]);
    bb[2] = Math.max(bb[2], b[2]); bb[3] = Math.max(bb[3], b[3]);
  }
  const pad = 4 / S.zoom;
  sel.bb = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
  positionSel(dx, dy);
}
function positionSel(dx = 0, dy = 0) {
  const sel = S.sel;
  if (!sel || !sel.P.selEl) return;
  const z = S.zoom, [x0, y0, x1, y1] = sel.bb, st = sel.P.selEl.style;
  st.left = (x0 + dx) * z + 'px';
  st.top = (y0 + dy) * z + 'px';
  st.width = (x1 - x0) * z + 'px';
  st.height = (y1 - y0) * z + 'px';
}
function clearSel() {
  if (!S.sel) return;
  S.sel.P.selEl?.remove();
  S.sel.P.selEl = null;
  S.sel = null;
}
function selectedStrokes() {
  return S.sel ? S.sel.P.strokes.filter((s) => S.sel.ids.has(s.id)) : [];
}
function replaceSelected(make) {
  const P = S.sel.P, old = selectedStrokes();
  if (!old.length) return;
  const neu = old.map(make);
  const map = new Map(old.map((s, k) => [s.id, neu[k]]));
  P.strokes = P.strokes.map((s) => map.get(s.id) || s);
  pushUndo({ p: P.i, del: old, add: neu });
  drawInk(P);
  setSel(P, new Set(neu.map((s) => s.id)));
}
function deleteSelected() {
  if (!S.sel) return;
  const P = S.sel.P, old = selectedStrokes();
  P.strokes = P.strokes.filter((s) => !S.sel.ids.has(s.id));
  clearSel();
  pushUndo({ p: P.i, del: old, add: [] });
  drawInk(P);
}

// ---------------------------------------------------------------- undo / redo
function pushUndo(a) {
  if (!a.add.length && !a.del.length) return;
  S.undo.push(a);
  if (S.undo.length > 1000) S.undo.shift();
  S.redo.length = 0;
  changed();
}
function applyAction(a, inverse) {
  const P = S.pages[a.p];
  const del = inverse ? a.add : a.del, add = inverse ? a.del : a.add;
  const ids = new Set(del.map((s) => s.id));
  P.strokes = P.strokes.filter((s) => !ids.has(s.id)).concat(add);
  clearSel();
  drawInk(P);
  if (!P.visible) P.el.scrollIntoView({ block: 'nearest' });
  changed();
}
function undo() {
  if (G) return;
  const a = S.undo.pop();
  if (a) { applyAction(a, true); S.redo.push(a); updateToolbarState(); }
}
function redo() {
  if (G) return;
  const a = S.redo.pop();
  if (a) { applyAction(a, false); S.undo.push(a); updateToolbarState(); }
}

// ---------------------------------------------------------------- saving
let saveTimer = 0, saveSeq = 0;
function changed() {
  setStatus('Unsaved');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
  updateToolbarState();
}
function serialize() {
  const pages = { ...S.orphans };
  for (const P of S.pages) if (P.strokes.length) pages[P.i] = P.strokes.map(plain);
  return { format: 'pdf-ink', version: 1, pdf: S.name, pages };
}
function saveNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  vscode.postMessage({ type: 'save', seq: ++saveSeq, ink: serialize() });
  setStatus('Saving…');
}
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => document.hidden && saveNow());

let prefsTimer = 0;
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => vscode.postMessage({ type: 'prefs', prefs: S.prefs }), 300);
}
let viewTimer = 0;
function saveView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const P = S.pages[S.curPage];
    if (!P) return;
    const frac = (viewer.scrollTop - P.el.offsetTop) / P.el.offsetHeight;
    vscode.postMessage({ type: 'view', view: { zoom: S.zoom, page: P.i, frac: r3(frac) } });
  }, 500);
}

// ---------------------------------------------------------------- pointer input
function pagePt(e, rect) {
  return [r2((e.clientX - rect.left) / S.zoom), r2((e.clientY - rect.top) / S.zoom)];
}
function pressure(e) {
  return e.pointerType === 'pen' && e.pressure > 0 ? r3(e.pressure) : 0.5;
}
function events(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  return list.length ? list : [e];
}

function onDown(e, P) {
  if (G) return;
  const isTouch = e.pointerType === 'touch';
  const wantsPan = S.prefs.tool === 'hand' || spaceHeld || e.button === 1 || (isTouch && S.prefs.penOnly);
  if (!wantsPan && e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  P.el.setPointerCapture(e.pointerId);
  if (wantsPan) {
    G = { tool: 'pan', P, id: e.pointerId, x: e.clientX, y: e.clientY };
    document.body.classList.add('panning');
    return;
  }
  // Pen with eraser end / barrel eraser button erases regardless of tool.
  let tool = S.prefs.tool;
  if (e.pointerType === 'pen' && (e.button === 5 || e.buttons & 32)) tool = 'eraser';
  const rect = P.el.getBoundingClientRect();
  const p = pagePt(e, rect);
  G = { tool, P, id: e.pointerId, rect };
  document.body.dataset.gesture = tool; // keeps the cursor even when the pen leaves the page mid-stroke

  if (tool !== 'lasso') clearSel();
  if (tool === 'pen' || tool === 'highlighter') {
    const pr = S.prefs[tool];
    G.stroke = { id: uid(), c: pr.color, w: pr.size, hl: tool === 'highlighter', sp: e.pointerType !== 'pen', pts: [] };
    G.smooth = S.prefs.smooth;
    addPoints(e);
  } else if (tool === 'eraser') {
    G.added = new Map();
    G.removed = new Map();
    G.last = p;
    eraseSeg(P, p, p);
    drawEraserCursor(P, p);
  } else if (tool === 'lasso') {
    if (S.sel && S.sel.P === P && pointInBox(p, S.sel.bb)) {
      G.mode = 'move';
      G.start = p;
      G.dx = G.dy = 0;
    } else {
      clearSel();
      G.mode = 'lasso';
      G.poly = [p];
    }
  }
}

const pointInBox = (p, b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

function addPoints(e) {
  const pts = G.stroke.pts;
  for (const ev of events(e)) {
    const [x, y] = pagePt(ev, G.rect);
    const last = pts[pts.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    pts.push([x, y, pressure(ev)]);
  }
  scheduleLive();
}

let liveRaf = 0;
function scheduleLive() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    if (G && G.stroke) drawLiveStroke(G.P, { ...G.stroke, pts: smoothPts(G.stroke.pts, G.smooth) });
  });
}

function onMove(e, P) {
  if (!G) {
    if (S.prefs.tool === 'eraser' && e.pointerType !== 'touch' && P.inkRs)
      drawEraserCursor(P, pagePt(e, P.el.getBoundingClientRect()));
    return;
  }
  if (e.pointerId !== G.id) return;
  if (G.tool === 'pan') {
    viewer.scrollBy(G.x - e.clientX, G.y - e.clientY);
    G.x = e.clientX;
    G.y = e.clientY;
    return;
  }
  G.rect = P.el.getBoundingClientRect();
  if (G.stroke) return addPoints(e);
  if (G.tool === 'eraser') {
    for (const ev of events(e)) {
      const p = pagePt(ev, G.rect);
      eraseSeg(P, G.last, p);
      G.last = p;
    }
    drawEraserCursor(P, G.last);
  } else if (G.mode === 'lasso') {
    const p = pagePt(e, G.rect), last = G.poly[G.poly.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) * S.zoom >= 2) G.poly.push(p);
    drawLasso(P, G.poly);
  } else if (G.mode === 'move') {
    const p = pagePt(e, G.rect);
    G.dx = p[0] - G.start[0];
    G.dy = p[1] - G.start[1];
    drawInk(P, { ids: S.sel.ids, dx: G.dx, dy: G.dy });
    positionSel(G.dx, G.dy);
  }
}

function onUp(e, P, cancelled = false) {
  if (!G || e.pointerId !== G.id) return;
  const g = G;
  G = null;
  delete document.body.dataset.gesture;
  if (P.el.hasPointerCapture(e.pointerId)) P.el.releasePointerCapture(e.pointerId);
  if (g.tool === 'pan') {
    document.body.classList.remove('panning');
    saveView();
    return;
  }
  if (g.stroke) {
    cancelAnimationFrame(liveRaf);
    liveRaf = 0;
    clearLive(P);
    if (!cancelled && g.stroke.pts.length) {
      if (g.smooth > 0 && g.stroke.pts.length > 2) {
        // keep every 2nd resampled point (1 pt spacing) so the sidecar stays small
        const sm = smoothPts(g.stroke.pts, g.smooth);
        g.stroke.pts = sm.filter((_, i) => i % 2 === 0 || i === sm.length - 1);
      }
      const s = prep(g.stroke);
      P.strokes.push(s);
      fillStroke(P, s);
      pushUndo({ p: P.i, add: [s], del: [] });
    }
  } else if (g.tool === 'eraser') {
    if (e.pointerType === 'touch') clearLive(P);
    pushUndo({ p: P.i, add: [...g.added.values()], del: [...g.removed.values()] });
  } else if (g.mode === 'lasso') {
    clearLive(P);
    if (g.poly.length > 2) selectInPoly(P, g.poly);
  } else if (g.mode === 'move') {
    const { dx, dy } = g;
    if (Math.abs(dx) + Math.abs(dy) > 0.01 && !cancelled) {
      replaceSelected((s) => clone(s, { pts: s.pts.map(([x, y, p]) => [r2(x + dx), r2(y + dy), p]) }));
    } else {
      drawInk(P);
      positionSel();
    }
  }
}

function selectInPoly(P, poly) {
  const ids = new Set();
  for (const s of P.strokes) {
    let inside = 0;
    for (const p of s.pts) if (pointInPoly(p, poly)) inside++;
    if (inside / s.pts.length >= 0.5) ids.add(s.id);
  }
  setSel(P, ids);
}

// Erase along segment a→b on page P (eraser radius in pt).
function eraseSeg(P, a, b) {
  const r = S.prefs.eraser.size;
  const partial = S.prefs.eraser.mode === 'partial';
  const ebb = [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r];
  let touched = false;
  const next = [];
  for (const s of P.strokes) {
    if (!bbOverlap(prep(s)._bb, ebb)) { next.push(s); continue; }
    if (partial) {
      const pieces = splitStroke(s, a, b, r);
      if (!pieces) { next.push(s); continue; }
      gRemove(s);
      for (const n of pieces) { G.added.set(n.id, n); next.push(n); }
      touched = true;
    } else if (hitStroke(s, a, b, r)) {
      gRemove(s);
      touched = true;
    } else next.push(s);
  }
  if (touched) {
    P.strokes = next;
    drawInk(P);
  }
}
function gRemove(s) {
  if (G.added.has(s.id)) G.added.delete(s.id);
  else G.removed.set(s.id, s);
}
function hitStroke(s, a, b, r) {
  const thr = r + s.w / 2, pts = s.pts;
  if (pts.length === 1) return distPtSeg(pts[0], a, b) <= thr;
  for (let i = 1; i < pts.length; i++) if (segSegDist(pts[i - 1], pts[i], a, b) <= thr) return true;
  return false;
}
// Cut the parts of s within the eraser's reach. Returns null if untouched,
// else the remaining pieces (possibly none). Only segments near the eraser
// are resampled, so the rest of the stroke keeps its original points.
function splitStroke(s, a, b, r) {
  const thr = r + s.w / 2;
  const pieces = [];
  let run = [], hit = false;
  const visit = (p) => {
    if (distPtSeg(p, a, b) > thr) run.push(p);
    else { hit = true; if (run.length) pieces.push(run); run = []; }
  };
  const pts = s.pts;
  visit(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1], p1 = pts[i];
    if (segSegDist(p0, p1, a, b) <= thr) {
      const n = Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / Math.max(0.3, thr / 4));
      for (let k = 1; k < n; k++) visit(lerpPt(p0, p1, k / n));
    }
    visit(p1);
  }
  if (!hit) return null;
  if (run.length) pieces.push(run);
  return pieces.filter((pp) => pp.length >= 2).map((pp) => prep(clone(s, { pts: pp })));
}

// ---------------------------------------------------------------- zoom / scroll
function setZoom(z, ax, ay) {
  z = clamp(z, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(z - S.zoom) < 1e-4) return;
  if (ax === undefined) { ax = viewer.clientWidth / 2; ay = viewer.clientHeight / 2; }
  const k = z / S.zoom;
  const sx = viewer.scrollLeft + ax, sy = viewer.scrollTop + ay;
  S.zoom = z;
  sizePages();
  viewer.scrollLeft = sx * k - ax;
  viewer.scrollTop = sy * k - ay;
  updateToolbarState();
  renderVisibleSoon();
  saveView();
}
function fitWidth() {
  const maxW = Math.max(...S.pages.map((P) => P.w));
  setZoom((viewer.clientWidth - 48) / maxW);
}
viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return; // trackpad pinch arrives as ctrl+wheel
  e.preventDefault();
  const r = viewer.getBoundingClientRect();
  setZoom(S.zoom * Math.exp(-clamp(e.deltaY, -50, 50) * 0.01), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const mid = viewer.scrollTop + viewer.clientHeight / 2;
    let cur = 0;
    for (const P of S.pages) { if (P.el.offsetTop <= mid) cur = P.i; else break; }
    if (cur !== S.curPage) { S.curPage = cur; updateToolbarState(); }
    saveView();
  });
});

// ---------------------------------------------------------------- keyboard
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k === 's') { e.preventDefault(); if (saveTimer) saveNow(); return; }
  if (mod || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); if (!spaceHeld) { spaceHeld = true; document.body.dataset.tool = 'hand'; } return; }
  const tools = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', s: 'lasso', v: 'hand' };
  if (tools[k]) return setTool(tools[k]);
  if (e.key === 'Delete' || e.key === 'Backspace') return deleteSelected();
  if (e.key === 'Escape') return clearSel();
  if (k === '+' || k === '=') return setZoom(S.zoom * 1.2);
  if (k === '-') return setZoom(S.zoom / 1.2);
  if (k === '0') return fitWidth();
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceHeld = false; document.body.dataset.tool = S.prefs.tool; }
});
window.addEventListener('blur', () => { spaceHeld = false; document.body.dataset.tool = S.prefs.tool; });

// ---------------------------------------------------------------- toolbar
const I = {
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5z"/><path d="M13.5 7l3.5 3.5"/></svg>',
  highlighter: '<svg viewBox="0 0 24 24"><path d="M9 17l-2.5 2.5H3V16l2.5-2.5"/><path d="M5.5 13.5L15 4l5 5-9.5 9.5z"/><path d="M14 21h7"/></svg>',
  eraser: '<svg viewBox="0 0 24 24"><path d="M8.5 20h11"/><path d="M4.5 15.5l10-10 5 5-9 9.5h-3.5z"/><path d="M9.5 10.5l5 5"/></svg>',
  lasso: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="10" rx="8" ry="5.5" stroke-dasharray="3 2.6"/><path d="M8.5 15c-1.5 2.5-.5 5.5 2.5 5.5"/></svg>',
  hand: '<svg viewBox="0 0 24 24"><path d="M8 13V6a1.5 1.5 0 013 0v5M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v7c0 4.5-2.5 7.5-6 7.5-2.6 0-4-1.4-5.4-3.8L3.8 13a1.5 1.5 0 012.6-1.5L8 14"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 20.5h14"/></svg>',
};

function setTool(t) {
  if (S.prefs.tool === t) return;
  if (G) return;
  S.prefs.tool = t;
  if (t !== 'lasso') clearSel();
  document.body.dataset.tool = t;
  S.pages.forEach(clearLive);
  renderToolbar();
  savePrefs();
}

function renderToolbar() {
  const t = S.prefs.tool;
  const btn = (a, html, title, on = false) => `<button data-a="${a}" title="${title}" class="${on ? 'on' : ''}">${html}</button>`;
  const sep = '<span class="sep"></span>';
  let h = '';
  h += btn('tool:pen', I.pen, 'Pen (P)', t === 'pen');
  h += btn('tool:highlighter', I.highlighter, 'Highlighter (H)', t === 'highlighter');
  h += btn('tool:eraser', I.eraser, 'Eraser (E) – pen eraser end also works', t === 'eraser');
  h += btn('tool:lasso', I.lasso, 'Lasso select (L): drag to move, Delete to remove, swatch to recolor', t === 'lasso');
  h += btn('tool:hand', I.hand, 'Pan (V, or hold Space)', t === 'hand');
  h += sep;
  const pal = t === 'highlighter' ? 'highlighter' : t === 'pen' || t === 'lasso' ? 'pen' : null;
  if (pal) {
    const cur = S.prefs[pal].color;
    for (const c of PALETTE[pal])
      h += `<button class="swatch${c === cur ? ' on' : ''}" data-a="color:${c}" style="background:${c}" title="${c}"></button>`;
    h += `<input type="color" id="customColor" value="${cur}" title="Custom color">`;
  }
  if (SIZE_RANGE[t]) {
    const [mn, mx, st] = SIZE_RANGE[t];
    h += `${pal ? sep : ''}<input type="range" id="size" min="${mn}" max="${mx}" step="${st}" value="${S.prefs[t].size}" title="Size (pt)"><span class="label" id="sizeLabel"></span>`;
  }
  if (t === 'pen' || t === 'highlighter')
    h += `<span class="sep"></span><span class="label" title="Stroke smoothing">Smooth</span><input type="range" id="smooth" min="0" max="1" step="0.05" value="${S.prefs.smooth}" title="Stroke smoothing (0 = raw input)">`;
  if (t === 'eraser')
    h += btn('eraserMode', S.prefs.eraser.mode === 'partial' ? 'Partial' : 'Whole stroke', 'Eraser mode: whole stroke ↔ partial (cuts strokes)');
  h += sep;
  h += btn('undo', I.undo, 'Undo (⌘Z)') + btn('redo', I.redo, 'Redo (⇧⌘Z)');
  h += sep;
  h += btn('zoomOut', '−', 'Zoom out (-)') + '<span class="label" id="zoomLabel"></span>' + btn('zoomIn', '+', 'Zoom in (+)') + btn('fit', 'Fit', 'Fit width (0)');
  h += sep;
  h += btn('penOnly', 'Pen only', 'Ignore touch for drawing (touch scrolls). Palm rejection for pen tablets.', S.prefs.penOnly);
  h += btn('export', I.export + 'Export', 'Export a PDF with the ink baked in');
  h += '<span class="spacer"></span><span class="label" id="pageLabel"></span><span class="sep"></span><span id="status"></span>';
  $('#toolbar').innerHTML = h;
  updateToolbarState();
}

function updateToolbarState() {
  const q = (s) => $('#toolbar ' + s);
  const set = (s, fn) => { const el = q(s); if (el) fn(el); };
  set('[data-a=undo]', (el) => (el.disabled = !S.undo.length));
  set('[data-a=redo]', (el) => (el.disabled = !S.redo.length));
  set('#zoomLabel', (el) => (el.textContent = Math.round(S.zoom * 100) + '%'));
  set('#pageLabel', (el) => (el.textContent = S.pages.length ? `${S.curPage + 1} / ${S.pages.length}` : ''));
  set('#sizeLabel', (el) => (el.textContent = S.prefs[S.prefs.tool]?.size ?? ''));
  set('#status', (el) => { el.textContent = S.status; el.classList.toggle('err', S.statusErr); });
}
function setStatus(text, err = false) {
  S.status = text;
  S.statusErr = err;
  updateToolbarState();
}

const toolbar = $('#toolbar');
toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep keyboard focus off buttons
toolbar.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const [a, arg] = b.dataset.a.split(':');
  if (a === 'tool') setTool(arg);
  else if (a === 'color') pickColor(arg);
  else if (a === 'undo') undo();
  else if (a === 'redo') redo();
  else if (a === 'zoomIn') setZoom(S.zoom * 1.2);
  else if (a === 'zoomOut') setZoom(S.zoom / 1.2);
  else if (a === 'fit') fitWidth();
  else if (a === 'eraserMode') {
    S.prefs.eraser.mode = S.prefs.eraser.mode === 'partial' ? 'stroke' : 'partial';
    renderToolbar();
    savePrefs();
  } else if (a === 'penOnly') {
    S.prefs.penOnly = !S.prefs.penOnly;
    renderToolbar();
    savePrefs();
  } else if (a === 'export') exportPdf();
});
toolbar.addEventListener('input', (e) => {
  if (e.target.id === 'size') {
    S.prefs[S.prefs.tool].size = +e.target.value;
    updateToolbarState();
    savePrefs();
  } else if (e.target.id === 'smooth') {
    S.prefs.smooth = +e.target.value;
    savePrefs();
  } else if (e.target.id === 'customColor') {
    pickColor(e.target.value, true);
  }
});
toolbar.addEventListener('change', (e) => { if (e.target.id === 'size' || e.target.id === 'smooth') e.target.blur(); });

function pickColor(c, fromInput = false) {
  const t = S.prefs.tool;
  if (t === 'lasso' && S.sel) {
    const hl = selectedStrokes().every((s) => s.hl);
    replaceSelected((s) => clone(s, { c }));
    if (hl) return;
  }
  const pal = t === 'highlighter' ? 'highlighter' : 'pen';
  S.prefs[pal].color = c;
  savePrefs();
  if (!fromInput) renderToolbar();
}

// ---------------------------------------------------------------- export
function svgPath(o, vp) {
  if (!o.length) return '';
  const q = o.map(([x, y]) => { const [X, Y] = vp.convertToPdfPoint(x, y); return [X, -Y]; }); // pdf-lib flips y
  const f = (v) => v.toFixed(2);
  let d = `M${f(q[0][0])} ${f(q[0][1])}`;
  for (let i = 0; i < q.length; i++) {
    const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % q.length];
    d += `Q${f(x0)} ${f(y0)} ${f((x0 + x1) / 2)} ${f((y0 + y1) / 2)}`;
  }
  return d + 'Z';
}
function hexRgb(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  const n = m ? parseInt(m[1], 16) : 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
let exporting = false;
async function exportPdf() {
  if (exporting) return;
  exporting = true;
  setStatus('Exporting…');
  try {
    const doc = await PDFDocument.load(S.bytes, { ignoreEncryption: true });
    const out = doc.getPages();
    for (const P of S.pages) {
      if (!P.strokes.length) continue;
      const vp = (await S.pdf.getPage(P.i + 1)).getViewport({ scale: 1 });
      // highlighter first so pen ink stays on top, as on screen
      const ordered = [...P.strokes.filter((s) => s.hl), ...P.strokes.filter((s) => !s.hl)];
      for (const s of ordered) {
        const d = svgPath(prep(s)._outline, vp);
        if (!d) continue;
        out[P.i].drawSvgPath(d, { x: 0, y: 0, color: hexRgb(s.c), borderWidth: 0, ...(s.hl ? { blendMode: BlendMode.Multiply } : {}) });
      }
    }
    const bytes = await doc.save();
    vscode.postMessage({ type: 'export', b64: bytesToB64(bytes) });
  } catch (err) {
    exporting = false;
    setStatus('Export failed', true);
    vscode.postMessage({ type: 'error', message: 'Export failed: ' + (err && err.message) });
  }
}

// ---------------------------------------------------------------- startup
async function setupWorker(assets) {
  try {
    const src = await (await fetch(assets.worker)).text();
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
  } catch (err) {
    console.warn('PDF Ink: worker blob failed, falling back', err);
    pdfjsLib.GlobalWorkerOptions.workerSrc = assets.worker;
  }
}

let bytesWaiter = null;
async function loadPdfBytes(url) {
  try {
    const res = await fetch(url);
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length) return buf;
    }
    console.warn('PDF Ink: fetch returned', res.status);
  } catch (err) {
    console.warn('PDF Ink: fetch failed, asking extension for bytes', err);
  }
  const b64 = await new Promise((resolve) => { bytesWaiter = resolve; vscode.postMessage({ type: 'needBytes' }); });
  return b64ToBytes(b64);
}
function b64ToBytes(b64) {
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Cursors as PNG (Chromium is unreliable with SVG cursors), crisp on Retina.
// --dot for writing (pen, highlighter), --cross for the lasso.
function makeCursor(name, n, draw) {
  const png = (scale) => {
    const c = document.createElement('canvas');
    c.width = c.height = n * scale;
    const x = c.getContext('2d');
    x.scale(scale, scale);
    draw(x);
    return c.toDataURL('image/png');
  };
  const one = `url("${png(1)}")`, two = `url("${png(2)}")`, h = n / 2;
  const candidates = [`image-set(${one} 1x, ${two} 2x) ${h} ${h}, crosshair`, `-webkit-image-set(${one} 1x, ${two} 2x) ${h} ${h}, crosshair`, `${one} ${h} ${h}, crosshair`];
  document.documentElement.style.setProperty(name, candidates.find((c) => CSS.supports('cursor', c)) || 'crosshair');
}
makeCursor('--dot', 6, (x) => {
  x.beginPath(); x.arc(3, 3, 2.25, 0, Math.PI * 2);
  x.fillStyle = '#000'; x.fill();
  x.lineWidth = 1; x.strokeStyle = 'rgba(255,255,255,.9)'; x.stroke();
});
makeCursor('--cross', 11, (x) => {
  x.lineCap = 'round';
  const cross = () => { x.beginPath(); x.moveTo(5.5, 1.5); x.lineTo(5.5, 9.5); x.moveTo(1.5, 5.5); x.lineTo(9.5, 5.5); x.stroke(); };
  x.strokeStyle = 'rgba(255,255,255,.95)'; x.lineWidth = 3; cross();
  x.strokeStyle = '#000'; x.lineWidth = 1; cross();
});

async function init(msg) {
  S.name = msg.name;
  if (msg.prefs) {
    const p = msg.prefs, d = DEFAULT_PREFS;
    S.prefs = {
      tool: p.tool in { pen: 1, highlighter: 1, eraser: 1, lasso: 1, hand: 1 } ? p.tool : d.tool,
      pen: { ...d.pen, ...p.pen },
      highlighter: { ...d.highlighter, ...p.highlighter },
      eraser: { ...d.eraser, ...p.eraser },
      penOnly: !!p.penOnly,
      smooth: isFinite(p.smooth) ? clamp(+p.smooth, 0, 1) : d.smooth,
    };
  }
  document.body.dataset.tool = S.prefs.tool;
  renderToolbar();
  setStatus('Loading…');

  await setupWorker(msg.assets);
  const data = await loadPdfBytes(msg.pdfUrl);
  S.bytes = data.slice(); // pdf.js transfers its copy to the worker
  const base = msg.assets.base;
  S.pdf = await pdfjsLib.getDocument({
    data,
    cMapUrl: base + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'standard_fonts/',
    wasmUrl: base + 'wasm/',
    iccUrl: base + 'iccs/',
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;

  for (let i = 0; i < S.pdf.numPages; i++) {
    const vp = (await S.pdf.getPage(i + 1)).getViewport({ scale: 1 });
    S.pages.push(buildPage(i, vp.width, vp.height));
  }

  const ink = msg.ink && typeof msg.ink.pages === 'object' ? msg.ink.pages : {};
  for (const [k, list] of Object.entries(ink)) {
    if (!Array.isArray(list)) continue;
    const strokes = list.map(sanitize).filter(Boolean);
    const P = S.pages[+k];
    if (P) P.strokes = strokes;
    else if (strokes.length) S.orphans[k] = strokes.map(plain);
  }
  if (Object.keys(S.orphans).length)
    vscode.postMessage({ type: 'error', message: `Ink exists for pages beyond this PDF's ${S.pages.length} pages; it is kept in the sidecar but not shown.` });

  const v = msg.view;
  if (v && isFinite(v.zoom)) {
    S.zoom = clamp(v.zoom, ZOOM_MIN, ZOOM_MAX);
    sizePages();
  } else {
    S.zoom = 1;
    sizePages();
    fitWidth();
  }
  if (v && S.pages[v.page]) {
    const P = S.pages[v.page];
    viewer.scrollTop = P.el.offsetTop + (v.frac || 0) * P.el.offsetHeight;
    S.curPage = P.i;
  }
  for (const P of S.pages) io.observe(P.el);
  setStatus('Saved');
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init(msg).catch((err) => {
        setStatus('Failed to load', true);
        pagesEl.innerHTML = `<div id="msg">Could not open PDF: ${String(err && err.message).replace(/</g, '&lt;')}</div>`;
        vscode.postMessage({ type: 'error', message: 'Could not open PDF: ' + (err && err.message) });
      });
      break;
    case 'bytes':
      if (bytesWaiter) { bytesWaiter(msg.b64); bytesWaiter = null; }
      break;
    case 'saved':
      if (msg.seq === saveSeq && !saveTimer) setStatus('Saved');
      break;
    case 'saveFailed':
      setStatus('Save failed', true);
      break;
    case 'exported':
      exporting = false;
      setStatus(saveTimer ? 'Unsaved' : 'Saved');
      break;
  }
});

vscode.postMessage({ type: 'ready' });
