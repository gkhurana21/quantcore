// Records the README demo: ~30 s on why QuantCore exists, told on the real terminal.
//
//   NEXT_PUBLIC_PROXY_URL=disabled npm run build      # the snapshot market data, never the live proxy
//   npm run demo                                       # writes docs/demo.gif (needs ffmpeg on PATH); DEMO_OUT overrides
//
// The terminal is the exported site, driven by the keyboard, computing in the hosted WebAssembly engine (stop any
// native engine on ws://localhost:8765 first). What is added is a layer drawn over it: a title card, a spotlight that
// rings the thing being talked about, and one caption per stop. Every number in a caption is read from the page at
// record time, and the recording fails rather than show one it could not read.
//
// A GIF pays for every pixel that changes, so nothing here fades the whole frame. Cards cut in; the dimming is always
// either fully on or fully off; the opening draws thin lines on black; and the spotlight opens and closes as an iris, which only changes the pixels its edge
// sweeps over. Fading the dim layer instead cost 4 MB for the same 30 seconds.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveOut } from './serve-out.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const OUT = process.env.DEMO_OUT || path.join(DOCS, 'demo.gif');
const W = 1280, H = 800;
const BUDGET_MB = 9;
// Native width, so no text is resampled; 50 fps, a 20 ms frame, the shortest delay browsers honour in a GIF; the full
// 256-colour palette; and no dithering, which the flat interface does not need. Lossless frames make all of that cheap.
const WIDTH = Number(process.env.DEMO_WIDTH || W), FPS = Number(process.env.DEMO_FPS || 50), COLOURS = Number(process.env.DEMO_COLOURS || 256), DITHER = process.env.DEMO_DITHER || 'none';
const IRIS_MS = 420;

const OVERLAY = `
<style>
  #qc-film { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;
             font-family: "Instrument Sans", ui-sans-serif, system-ui, sans-serif; color: #ece9e2; }
  #qc-spot { position: fixed; left: ${W / 2}px; top: ${H / 2}px; width: 0; height: 0; border-radius: 12px; display: none;
             box-shadow: 0 0 0 2px #e5a947, 0 0 0 9999px rgba(5, 6, 8, 0.64);
             transition: left ${IRIS_MS}ms cubic-bezier(.3,.7,.2,1), top ${IRIS_MS}ms cubic-bezier(.3,.7,.2,1),
                         width ${IRIS_MS}ms cubic-bezier(.3,.7,.2,1), height ${IRIS_MS}ms cubic-bezier(.3,.7,.2,1); }
  #qc-spot.on { display: block; }
  #qc-spot.shut { box-shadow: 0 0 0 9999px rgba(5, 6, 8, 0.64); }
  #qc-cap  { position: fixed; left: 50%; bottom: 14px; transform: translate(-50%, 16px); opacity: 0; white-space: nowrap;
             transition: opacity .3s, transform .3s cubic-bezier(.2,.7,.2,1);
             background: #0d0e11; border: 1px solid rgba(229, 169, 71, 0.5); border-radius: 14px; padding: 15px 28px;
             font-size: 31px; font-weight: 600; letter-spacing: -0.012em; box-shadow: 0 14px 44px rgba(0, 0, 0, 0.7); }
  #qc-cap.on { opacity: 1; transform: translate(-50%, 0); }
  #qc-cap b, #qc-card b { color: #f5c77e; font-weight: 700; }
  #qc-card { position: fixed; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
             gap: 20px; text-align: center; background: #08090b; }
  #qc-card.on { display: flex; }
  #qc-card h1 { margin: 0; font-size: 62px; font-weight: 650; letter-spacing: -0.025em; line-height: 1.12; max-width: 1000px; }
  #qc-card p  { margin: 0; font-size: 30px; font-weight: 500; color: #b8b4aa; }
  #qc-card .fact { font-size: 22px; color: #8d897f; letter-spacing: 0.01em; }
  #qc-card .url { margin-top: 10px; font-size: 26px; color: #f5c77e; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  #qc-fan { position: absolute; inset: 0; }
  #qc-claim { position: relative; opacity: 0; transform: translateY(14px); transition: opacity .4s, transform .4s cubic-bezier(.2,.7,.2,1);
              text-shadow: 0 0 26px #08090b, 0 0 26px #08090b, 0 0 12px #08090b; }
  #qc-claim.show { opacity: 1; transform: none; }
</style>
<div id="qc-spot"></div><div id="qc-card"></div><div id="qc-cap"></div>`;

const local = await serveOut(0);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-demo-'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark' });
const page = await ctx.newPage();

// ── the camera ──
// Lossless frames straight from the compositor, each with the time it was shown. Chrome sends one only when the
// screen changes, so a held caption is a single frame with a long duration. (Playwright's own video is lossy VP8:
// a still screen shimmers from frame to frame, the GIF pays for every shimmer, and 25 fps would not fit the budget.)
const cdp = await ctx.newCDPSession(page);
const shots = [];
let rolling = false;
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  if (!rolling) return;
  const file = path.join(tmp, `f${String(shots.length).padStart(5, '0')}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  shots.push({ t: metadata.timestamp, file });
});
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
const pause = ms => page.waitForTimeout(ms);
const ready = () => page.waitForSelector('main[data-ready="true"]', { timeout: 60_000 });
const key = async k => { await page.keyboard.press(k); await ready(); };

// ── the layer over the terminal ──
const card = html => page.evaluate(h => { const c = document.getElementById('qc-card'); if (h) c.innerHTML = h; c.classList.toggle('on', !!h); }, html);
const caption = html => page.evaluate(h => { const c = document.getElementById('qc-cap'); if (h) c.innerHTML = h; c.classList.toggle('on', !!h); }, html);
// The opening: one dot, one price today, bursts into a fan of the paths it could take, and the claim lands on top.
// The fan is a seeded geometric Brownian motion at the terminal's own volatility and horizon (13.8% over 47 days), an
// illustration of the idea rather than the engine's output; the engine's own paths are the Simulate stop.
const intro = () => page.evaluate(({ W, H }) => new Promise(done => {
  const card = document.getElementById('qc-card');
  card.innerHTML = `<canvas id="qc-fan" width="${W}" height="${H}"></canvas><h1 id="qc-claim">One price from one model<br/>is a <b>guess</b>.</h1>`;
  card.classList.add('on');
  const g = document.getElementById('qc-fan').getContext('2d');
  let seed = 7;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const N = 36, STEPS = 80, X0 = 170, X1 = W - 150, Y0 = H / 2, sd = 0.138 * Math.sqrt(47 / 365) / Math.sqrt(STEPS);
  const paths = Array.from({ length: N }, () => { let c = 0; const ys = [Y0]; for (let i = 0; i < STEPS; i++) { c += sd * gauss(); ys.push(Y0 - (Math.exp(c) - 1) / 0.15 * 300); } return ys; });
  const DOT = 450, DRAW = 1500, t0 = performance.now();
  const frame = now => {
    const t = Math.max(0, now - t0), p = Math.min(1, Math.max(0, (t - DOT) / DRAW))   , e = 1 - (1 - p) ** 3, upto = e * STEPS;
    g.clearRect(0, 0, W, H);
    paths.forEach((ys, k) => {
      const bright = k % 6 === 0;
      g.beginPath(); g.moveTo(X0, ys[0]);
      for (let i = 1; i <= Math.floor(upto); i++) g.lineTo(X0 + (X1 - X0) * i / STEPS, ys[i]);
      g.strokeStyle = bright ? 'rgba(245,199,126,0.95)' : 'rgba(229,169,71,0.36)'; g.lineWidth = bright ? 2.2 : 1.4; g.stroke();
    });
    const r = 8 * Math.min(1, t / DOT);
    g.beginPath(); g.arc(X0, Y0, r * 2.6, 0, 7); g.fillStyle = 'rgba(245,199,126,0.18)'; g.fill();
    g.beginPath(); g.arc(X0, Y0, r, 0, 7); g.fillStyle = '#f5c77e'; g.fill();
    if (p < 1) return requestAnimationFrame(frame);
    document.getElementById('qc-fan').style.opacity = '0.3';   // a cut, not a fade: a fade repaints every line for five frames
    document.getElementById('qc-claim').classList.add('show');
    setTimeout(done, 450);
  };
  requestAnimationFrame(frame);
}), { W, H });
// dim the whole terminal with the iris closed, at once
const dim = () => page.evaluate(() => document.getElementById('qc-spot').classList.add('on', 'shut'));
// close the iris onto its own centre
const shut = async () => {
  await page.evaluate(() => {
    const s = document.getElementById('qc-spot'), r = s.getBoundingClientRect();
    Object.assign(s.style, { left: `${r.x + r.width / 2}px`, top: `${r.y + r.height / 2}px`, width: '0px', height: '0px' });
    s.classList.add('shut');
  });
  await pause(IRIS_MS);
};
// open the iris from the centre of some test ids out to their union
const open = async (...ids) => {
  const boxes = [];
  for (const id of ids) { const b = await page.getByTestId(id).first().boundingBox(); if (!b) throw new Error(`nothing to ring: ${id}`); boxes.push(b); }
  await page.evaluate(({ boxes, W, H }) => {
    const s = document.getElementById('qc-spot'), pad = 10;
    const x0 = Math.max(6, Math.min(...boxes.map(b => b.x)) - pad), y0 = Math.max(6, Math.min(...boxes.map(b => b.y)) - pad);
    const x1 = Math.min(W - 6, Math.max(...boxes.map(b => b.x + b.width)) + pad), y1 = Math.min(H - 6, Math.max(...boxes.map(b => b.y + b.height)) + pad);
    s.style.transition = 'none';                                      // jump, closed, to the new centre
    Object.assign(s.style, { left: `${(x0 + x1) / 2}px`, top: `${(y0 + y1) / 2}px`, width: '0px', height: '0px' });
    void s.offsetWidth;
    s.style.transition = '';
    s.classList.remove('shut');
    Object.assign(s.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  }, { boxes, W, H });
  await pause(IRIS_MS);
};

// ── numbers come from the page, or the recording stops ──
const dollars = text => {
  const m = text.replace(/−/g, '-').match(/-?\$[\d,]+(?:\.\d+)?/);
  if (!m) throw new Error(`no dollar amount in "${text.slice(0, 80)}"`);
  return Number(m[0].replace(/[$,]/g, ''));
};
const read = async id => dollars(await page.getByTestId(id).first().innerText());
const usd = x => `$${Math.round(Math.abs(x)).toLocaleString('en-US')}`;
const signed = x => `${x < 0 ? '−' : ''}${usd(x)}`;
// a caption's verdict has to be true of the numbers beside it, or the recording stops
const must = (ok, what) => { if (!ok) throw new Error(`the caption would not be true: ${what}`); };

const t0 = Date.now();
await page.goto(local.url, { waitUntil: 'load' });
await ready(); await page.evaluate(() => document.fonts.ready);
await page.evaluate(html => { const d = document.createElement('div'); d.id = 'qc-film'; d.innerHTML = html; document.body.appendChild(d); }, OVERLAY);
// Before the recording starts, walk the route once: each workspace computes on its first visit and keeps its results,
// so the camera never waits on a dimmed screen.
await page.getByTestId('preset-iron-condor').click(); await ready();
for (const k of [']', '3', '5']) await key(k);
await page.getByTestId('scenario-covid').click(); await ready();
await key('6'); await key('1'); await pause(300);

rolling = true;                                                       // the GIF opens on the dot
await intro();
await pause(2400);                                                    // the claim, long enough to read

// 1 Build: the whole terminal, nothing dimmed
await card(''); await pause(350);
await caption('Build a position: an <b>iron condor</b> on SPY, four legs.');
await pause(2400);

// 2 Price: three independent models and how far apart they land
await caption(''); await pause(250);
await dim(); await key(']'); await pause(250);
const prices = [await read('lab-value-bs'), await read('lab-value-crr'), await read('lab-value-mc200k')];
await open('lab-table');
must((Math.max(...prices) - Math.min(...prices)) / Math.abs(prices[0]) < 0.01, `three prices within 1% of each other: ${prices}`);
await caption(`Three models price it: ${prices.map(signed).join(' · ')}. <b>They agree.</b>`);
await pause(3200);

// 3 Simulate: the paths replay inside the ring
await caption(''); await shut(); await key('3'); await pause(250);
await open('mc-paths-chart', 'mc-hist');
await caption('Simulated path by path, against the <b>exact</b> distribution.');
await page.getByTestId('mc-replay').click().catch(() => {});
await pause(2900);

// 4 Stress: the crash and what it costs this position
await caption(''); await shut(); await key('5'); await pause(250);   // the crash was chosen on the first walk
const pipeline = (await page.getByTestId('stress-pipeline').innerText()).replace(/\s+/g, ' ');
const crash = dollars(pipeline.slice(pipeline.indexOf('P&L')));
await open('stress-pipeline');
await caption(`A COVID-style crash: this position loses <b>${usd(crash)}</b>.`);
await pause(2900);

// 5 Risk: four methods, one position, and the spread between them
await caption(''); await shut(); await key('6'); await pause(350);
const vars = [await read('var-delta-normal'), await read('var-delta-gamma'), await read('var-mc'), await read('var-mc-2f')];
await open('var-methods');
must(Math.max(...vars) / Math.min(...vars) > 1.5, `four risk numbers more than 1.5x apart: ${vars}`);
await caption(`Four models measure its risk: ${usd(Math.min(...vars))} to ${usd(Math.max(...vars))}. <b>They don’t.</b>`);
await pause(3400);

await caption(''); await shut();
const wasmKB = Math.round(fs.statSync(path.join(DOCS, '..', 'dashboard', 'out', 'wasm', 'quantcore.wasm')).size / 1000);   // the module this recording ran on
await card(`<h1>Quant<b>Core</b></h1><p>A C++ pricing engine that runs in your browser.</p><p class="fact">${wasmKB} KB of WebAssembly · no server · nothing to install</p><div class="url">quantcore-gk.netlify.app</div>`);
await pause(2700);
console.log(`walk took ${((Date.now() - t0) / 1000).toFixed(1)} s · three prices ${prices.join(' / ')} · crash ${crash} · VaR ${vars.join(' / ')}`);

rolling = false;
const tEnd = Date.now() / 1000;
await cdp.send('Page.stopScreencast');
await ctx.close(); await browser.close(); local.server.close();

// every frame for exactly as long as it was on screen, then a two-pass palette GIF cut to the recorded length
const span = (a, b) => Math.max(0.001, b - a).toFixed(4);
const list = path.join(tmp, 'frames.txt');
fs.writeFileSync(list, shots.map((f, k) => `file '${f.file}'\nduration ${span(f.t, shots[k + 1]?.t ?? tEnd)}`).join('\n') + `\nfile '${shots.at(-1).file}'\nduration 0.04\n`);   // the concat demuxer needs the last frame named again to honour its duration
const gaps = shots.slice(1).map((f, k) => f.t - shots[k].t).filter(d => d < 0.2).sort((a, b) => a - b);
console.log(`${shots.length} frames over ${(tEnd - shots[0].t).toFixed(1)} s · in motion, a frame every ${(gaps[gaps.length >> 1] * 1000).toFixed(0)} ms (median)`);
const src = ['-f', 'concat', '-safe', '0', '-i', list], cut = ['-t', (tEnd - shots[0].t).toFixed(3)];
const vf = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
const pal = path.join(tmp, 'pal.png');
execFileSync('ffmpeg', ['-y', '-v', 'error', ...src, '-vf', `${vf},palettegen=max_colors=${COLOURS}:stats_mode=diff`, ...cut, pal]);
execFileSync('ffmpeg', ['-y', '-v', 'error', ...src, '-i', pal,
  '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=${DITHER}:diff_mode=rectangle`, ...cut, '-loop', '0', OUT]);
if (process.env.DEMO_FRAMES) fs.cpSync(tmp, process.env.DEMO_FRAMES, { recursive: true });   // keep the frames, to tune the encode
const mb = fs.statSync(OUT).size / 1024 / 1024;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${path.relative(process.cwd(), OUT)}  ${mb.toFixed(2)} MB${mb > BUDGET_MB ? `  OVER the ${BUDGET_MB} MB budget` : ''}`);
if (mb > BUDGET_MB) process.exit(1);
