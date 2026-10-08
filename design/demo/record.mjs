// Records the README demo: images/demo.gif (+ design/demo/out/demo.mp4).
// Runs the real webview bundle in headless Chrome inside a VS Code-like frame and
// drives it with scripted pen/mouse input over the DevTools protocol.
//   cd tools/pdf-ink && npm run build && node design/demo/record.mjs
// Needs Google Chrome, python3 (static server) and ffmpeg.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'out');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8766, DBG = 9334, W = 1600, H = 900;
const SPEED = 1.6; // playback speed-up of the final video
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'frames'), { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${join(OUT, 'profile')}`,
  '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { chrome.kill(); server.kill(); };
process.on('exit', cleanup);

// ------------------------------------------------------------------ CDP
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${DBG}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let nextId = 0;
const pending = new Map(), handlers = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
  else handlers.get(m.method)?.(m.params);
});
const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result.result.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// ------------------------------------------------------------------ 1. sample PDF
const base = `http://127.0.0.1:${PORT}/design/demo/`;
await send('Page.navigate', { url: base + 'sample.html' });
await sleep(800);
// element boxes on page 1 in CSS px of the 960×540 page
const boxes = await ev(`Object.fromEntries(['eq','ul1','hl1'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, [r.left, r.top, r.right, r.bottom]]; }))`);
const pdf = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true });
writeFileSync(join(HERE, 'sample.pdf'), Buffer.from(pdf.result.data, 'base64'));

// ------------------------------------------------------------------ 2. open the frame
await send('Page.navigate', { url: base + 'frame.html' });
const inFrame = (expr) => ev(`(() => { const f = document.getElementById('wv'), d = f.contentDocument, fr = f.getBoundingClientRect(); return (${expr}); })()`);
for (let i = 0; i < 80 && (await inFrame(`d?.querySelector('#status')?.textContent`).catch(() => '')) !== 'Saved'; i++) await sleep(150);
await inFrame(`d.querySelector('#viewer').scrollTop = 0`); // fit-width keeps the old center; start at the top of page 1
await sleep(1200);
const center = (sel) => inFrame(`(() => { const r = [...d.querySelectorAll(${JSON.stringify(sel)})].pop().getBoundingClientRect(); return [fr.left + r.left + r.width / 2, fr.top + r.top + r.height / 2]; })()`);
const rowCenter = (text) => inFrame(`(() => { const r = [...d.querySelectorAll('#tocList .row')].find(e => e.textContent.includes(${JSON.stringify(text)})).getBoundingClientRect(); return [fr.left + r.left + 120, fr.top + r.top + r.height / 2]; })()`);
// page-1 CSS px → screen px (valid while page 1 is scrolled to the top)
const pageMap = await inFrame(`(() => { const r = d.querySelector('.page').getBoundingClientRect(); return [fr.left + r.left, fr.top + r.top, r.width / 960]; })()`);
const S = ([x, y]) => [pageMap[0] + x * pageMap[2], pageMap[1] + y * pageMap[2]];

// ------------------------------------------------------------------ 3. record
const frames = [];
handlers.set('Page.screencastFrame', (p) => {
  frames.push({ t: p.metadata.timestamp, data: p.data });
  send('Page.screencastFrameAck', { sessionId: p.sessionId });
});
await send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

let cur = [W * 0.62, H * 0.9];
const mouse = (type, [x, y], extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, ...extra });
// Human-like motion.
// Point-to-point moves (cursor, pen hovering): minimum-jerk trajectory (Flash & Hogan 1985),
// i.e. a bell-shaped speed profile, along a slightly bowed path; the duration follows
// Fitts' law (Fitts 1954), so long moves take longer but cover ground faster.
const minJerk = (t) => t * t * t * (10 + t * (-15 + 6 * t));
const fittsMs = (D, W = 24) => 150 + 115 * Math.log2(D / W + 1);
async function glide(to, ms, pointerType = 'mouse') {
  const from = cur, dx = to[0] - from[0], dy = to[1] - from[1], D = Math.hypot(dx, dy);
  if (D < 1) return;
  const T = ms ?? fittsMs(D);
  const bow = D * (0.025 + Math.random() * 0.035) * (Math.random() < 0.5 ? -1 : 1);
  const n = Math.max(3, Math.round(T / 16));
  for (let i = 1; i <= n; i++) {
    const s = minJerk(i / n), off = bow * Math.sin(Math.PI * s);
    cur = [from[0] + dx * s - (dy / D) * off, from[1] + dy * s + (dx / D) * off];
    await mouse('mouseMoved', cur, { pointerType });
    await sleep(16);
  }
}
async function click(sel, pause = 350) {
  await glide(typeof sel === 'string' ? await center(sel) : sel);
  await sleep(120);
  await mouse('mousePressed', cur, { button: 'left', buttons: 1, clickCount: 1 });
  await sleep(70);
  await mouse('mouseReleased', cur, { button: 'left', buttons: 0, clickCount: 1 });
  await ev(`code.blur()`); // every scripted click lands in the PDF pane
  await sleep(pause);
}
// click into line i of the code pane and type there
async function codeType(i, text) {
  await glide(await ev(`code.lineBox(${i})`));
  await sleep(100);
  await mouse('mousePressed', cur, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', cur, { button: 'left', buttons: 0, clickCount: 1 });
  await ev(`code.focus(${i})`);
  await sleep(300);
  await ev(`code.type(${JSON.stringify(text)})`);
  await sleep(700);
}
const cast = (...k) => ev(`keycast(${k.map((x) => JSON.stringify(x)).join(',')})`);
async function key(k, mods = 0) {
  const code = k.length === 1 ? 'Key' + k.toUpperCase() : k;
  const vk = { Enter: 13, Escape: 27 }[k] ?? k.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods, text: k.length === 1 && !mods ? k : undefined });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
async function type(text) { for (const ch of text) { await key(ch); await sleep(85); } }

// One pen stroke through screen points. Speed along the stroke follows the two-thirds
// power law (Lacquaniti, Terzuolo & Viviani 1983: v ∝ κ^(-1/3), so the pen slows down in
// tight curves), under an envelope that accelerates at the start and decelerates at the
// end. Pressure is a bell over the stroke and gets a bit lighter when the pen is fast.
async function penStroke(pts, speed = 650) {
  await glide(pts[0], undefined, 'pen');
  // dense path, ~1 px spacing
  const path = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 1; k <= n; k++) path.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  const N = path.length, arc = [0];
  for (let i = 1; i < N; i++) arc.push(arc[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const L = arc[N - 1] || 1;
  // curvature from the turning angle over ±4 samples, then v = speed·(40κ)^(-1/3), smoothed
  const raw = path.map((p, i) => {
    const a = path[Math.max(0, i - 4)], b = path[Math.min(N - 1, i + 4)];
    const a1 = Math.atan2(p[1] - a[1], p[0] - a[0]), a2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    const turn = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
    const len = Math.max(1, arc[Math.min(N - 1, i + 4)] - arc[Math.max(0, i - 4)]);
    return speed * Math.min(1.5, Math.max(0.35, (40 * (turn / len) + 1e-3) ** (-1 / 3)));
  });
  const vel = raw.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - 6); j <= Math.min(N - 1, i + 6); j++) { s += raw[j]; c++; } return s / c; });
  const env = (u) => Math.min(1, Math.max(0.14, Math.sin(Math.PI * Math.min(u, 1 - u)) * 2.6));
  const at = (s) => { let i = 0; while (i < N - 2 && arc[i + 1] < s) i++; const t = (s - arc[i]) / Math.max(1e-6, arc[i + 1] - arc[i]); return [i, [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t]]; };
  const force = (u, v) => Math.min(1, Math.max(0.08, (0.3 + 0.5 * Math.sin(Math.PI * Math.min(1, u * 1.1))) * (1.1 - 0.3 * v / speed) + 0.04 * Math.sin(u * 23)));
  await mouse('mousePressed', path[0], { button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: force(0, 0) });
  const dt = 1 / 120;
  let s = 0;
  while (s < L) {
    const [i] = at(s);
    const v = vel[i] * env(s / L);
    s = Math.min(L, s + v * dt);
    const [, p] = at(s);
    cur = p;
    await mouse('mouseMoved', p, { button: 'left', buttons: 1, pointerType: 'pen', force: force(s / L, v) });
    await sleep(8);
  }
  await mouse('mouseReleased', cur, { button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  await sleep(90);
}

// Handwriting: single-line glyphs (y up, x-height 1), Catmull-Rom smoothed, slanted.
const G = {
  k: [0.75, [[[0.06, 1.8], [0.05, 0.9], [0.04, 0]], [[0.62, 1], [0.3, 0.68], [0.07, 0.45]], [[0.24, 0.6], [0.48, 0.28], [0.7, 0]]]],
  e: [0.78, [[[0.06, 0.5], [0.6, 0.56], [0.58, 0.86], [0.34, 1], [0.1, 0.84], [0.02, 0.45], [0.14, 0.1], [0.4, 0], [0.66, 0.14]]]],
  y: [0.8, [[[0.04, 1], [0.08, 0.42], [0.3, 0.16], [0.56, 0.34], [0.66, 1]], [[0.66, 1], [0.62, -0.3], [0.48, -0.74], [0.2, -0.8], [0.04, -0.55]]]],
  '!': [0.45, [[[0.24, 1.8], [0.2, 0.5]], [[0.18, 0.08], [0.19, 0]]]],
};
function catmull(ps, n = 10) {
  if (ps.length < 3) return ps;
  const q = [ps[0], ...ps, ps[ps.length - 1]], out = [];
  for (let i = 1; i < q.length - 2; i++) {
    const [p0, p1, p2, p3] = [q[i - 1], q[i], q[i + 1], q[i + 2]];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(ps[ps.length - 1]);
  return out;
}
function handwriting(text, [x0, y0], size) {
  const strokes = [];
  let x = 0;
  for (const ch of text) {
    const [adv, ss] = G[ch];
    for (const s of ss) strokes.push(catmull(s.map(([gx, gy]) => [x0 + (x + gx + 0.22 * gy) * size, y0 - gy * size])));
    x += adv;
  }
  return strokes;
}
const ellipse = (cx, cy, rx, ry) => Array.from({ length: 90 }, (_, i) => {
  const t = -2.6 + (i / 89) * Math.PI * 2.12;
  const w = 1 + 0.035 * Math.sin(3 * t + 1);
  return [cx + rx * w * Math.cos(t) + i * 0.12, cy + ry * w * Math.sin(t) - i * 0.05];
});

// ---- the choreography
await sleep(900);
// pen: circle the equation, then write a note next to it
const [ex0, ey0, ex1, ey1] = boxes.eq;
const [c1, c2] = [S([(ex0 + ex1) / 2, (ey0 + ey1) / 2]), S([ex1, ey1])];
const sc = pageMap[2];
await penStroke(ellipse(c1[0], c1[1], (ex1 - ex0) / 2 * sc + 26, (ey1 - ey0) / 2 * sc + 18), 900);
const noteAt = [c2[0] + 42, c2[1] - 8];
for (const s of handwriting('key!', noteAt, 22)) await penStroke(s, 420);
await sleep(400);
// …and turn the formula into code on the right
await codeType(6, '    # x = f · X / Z,  y = f · Y / Z\n    uv = K @ (P_C / P_C[2])');
// red pen: underline
await click('[data-a="color:#d62828"]');
const u = boxes.ul1;
const [ua, ub] = [S([u[0] - 3, u[3] + 2]), S([u[2] + 3, u[3] + 3])];
await penStroke([ua, [(ua[0] + ub[0]) / 2, ua[1] + 2.5], ub], 520);
await sleep(400);
// highlighter
await click('[data-a="tool:highlighter"]');
const h = boxes.hl1, hy = (h[1] + h[3]) / 2;
await penStroke([S([h[0] - 2, hy + 1]), S([(h[0] + h[2]) / 2, hy - 0.5]), S([h[2] + 2, hy + 0.5])], 480);
await sleep(500);
// eraser: scrub away the underline
await click('[data-a="tool:eraser"]');
await glide([ua[0] - 30, ua[1] - 30], undefined, 'pen');
await sleep(250);
await penStroke([[ua[0] - 6, ua[1] - 6], [ua[0] + 25, ua[1] + 1], [ua[0] + 50, ua[1] - 7], [ub[0] - 20, ub[1] + 1], [ub[0] + 6, ub[1] - 6]], 380); // stays above the highlighted line
await glide([ub[0] + 60, ub[1] - 40], undefined, 'pen');
await sleep(400);
// lasso: select the note and move it
await click('[data-a="tool:lasso"]');
const nb = [noteAt[0] - 14, noteAt[1] - 52, noteAt[0] + 92, noteAt[1] + 30];
await penStroke(ellipse((nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2, (nb[2] - nb[0]) / 2, (nb[3] - nb[1]) / 2), 700);
await sleep(500);
const grab = [(nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2 + 4];
await penStroke([grab, [grab[0] - 10, grab[1] - 30], [grab[0] - 16, grab[1] - 62]], 260);
await sleep(600);
await key('Escape');
await click('[data-a="tool:pen"]', 500);
// find (⌘F – the find button may be scrolled out of the narrower toolbar)
await ev(`document.getElementById('wv').contentWindow.focus()`); // keys go to the PDF pane again (toolbar clicks don't take focus)
await cast('⌘', 'F');
await key('f', 4);
await sleep(300);
await type('distortion');
await sleep(1200);
await cast('↩');
await key('Enter');
await sleep(1000);
await cast('↩');
await key('Enter');
await sleep(1100);
// the distortion formula goes into code as well
await codeType(15, '    return (1 + k1 * r2) * (uv - u0) + u0');
await click('[data-f="close"]', 400);
// table of contents: jump to the last section, then back to the start
await click('[data-a="toc"]', 700);
await click(await rowCenter('Calibration'), 1300);
await click('[data-a="toc"]', 700);
await click(await rowCenter('Pinhole'), 400);
await glide([W * 0.62, H * 0.9]);
await sleep(2200);

await send('Page.stopScreencast');
console.log(`${frames.length} frames`);

// ------------------------------------------------------------------ 4. encode
const list = [];
frames.forEach((f, i) => {
  const name = `f${String(i).padStart(5, '0')}.png`;
  writeFileSync(join(OUT, 'frames', name), Buffer.from(f.data, 'base64'));
  const dur = i + 1 < frames.length ? frames[i + 1].t - f.t : 0.5;
  list.push(`file 'frames/${name}'`, `duration ${Math.max(0.001, dur).toFixed(4)}`);
});
list.push(`file 'frames/f${String(frames.length - 1).padStart(5, '0')}.png'`);
writeFileSync(join(OUT, 'frames.txt'), list.join('\n') + '\n');
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: OUT, stdio: 'inherit' });
ff(['-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', `setpts=PTS/${SPEED},fps=30,format=yuv420p`, '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', 'demo.mp4']);
ff(['-i', 'demo.mp4', '-vf', 'fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  join(ROOT, 'images', 'demo.gif')]);
rmSync(join(OUT, 'frames'), { recursive: true });
rmSync(join(OUT, 'profile'), { recursive: true, force: true });
console.log('wrote images/demo.gif and design/demo/out/demo.mp4');
cleanup();
process.exit(0);
