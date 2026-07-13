'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── constants ──────────────────────────────────────────────────────────────

const WS_URL   = 'ws://localhost:8765/ws';
// Canonical option the local C++ engine subscribes to (must stay in sync with
// the Playwright suite and server defaults).
const BASE_OPT = { S: 756.48, K: 755.0, r: 0.045, sigma: 0.138, T: 0.129,
                   call: true, position: 10 };

const SPOT_SHOCKS = [-0.10, -0.05, 0, +0.05, +0.10];
const VOL_SHOCKS  = [-0.50, -0.25, 0, +0.25, +0.50];

// Verified benchmarks (see README) — the real engineering story behind the demo.
const BENCH = [
  { k: 'GPU Monte Carlo', v: '69×',    s: 'vs vectorized NumPy · 10M paths' },
  { k: 'Stream latency',  v: '4.4 ms', s: 'p99 end-to-end · WebSocket' },
  { k: 'VaR calibration', v: '4.5%',   s: 'breach rate vs 5% · 851 days' },
  { k: 'Pricing error',   v: '<0.01%', s: 'vs live market mid' },
];

// Indicative market snapshots (clearly labelled in the UI — this is a pricing
// demo, not a quote feed). SPY matches the C++ engine's canonical subscription.
interface Inst {
  sym: string; name: string; spot: number; vol: number;
  min: number; max: number; step: number; kstep: number;
}
const INSTRUMENTS: Inst[] = [
  { sym: 'SPY',  name: 'S&P 500 ETF',    spot: 756.48, vol: 0.138, min: 680, max: 830, step: 0.5,  kstep: 5   },
  { sym: 'AAPL', name: 'Apple',          spot: 227.60, vol: 0.225, min: 200, max: 255, step: 0.25, kstep: 2.5 },
  { sym: 'NVDA', name: 'NVIDIA',         spot: 142.35, vol: 0.380, min: 125, max: 160, step: 0.25, kstep: 2.5 },
  { sym: 'TSLA', name: 'Tesla',          spot: 251.80, vol: 0.450, min: 222, max: 282, step: 0.5,  kstep: 5   },
  { sym: 'QQQ',  name: 'Nasdaq-100 ETF', spot: 515.20, vol: 0.165, min: 455, max: 575, step: 0.5,  kstep: 5   },
];

// Market scenario presets: multipliers on the instrument's base spot / vol.
const SCENARIOS = [
  { name: 'Reset',     s: 1.0,   v: 1.0  },
  { name: 'Rally',     s: 1.057, v: 0.80 },
  { name: 'Sell-off',  s: 0.938, v: 1.95 },
  { name: 'Vol spike', s: 1.0,   v: 2.60 },
];

const MAX_LEGS   = 8;
const PATH_OPTS  = [10_000, 50_000, 200_000];
const BIN_STEPS  = 512;
const CHART_MODES = ['P&L', 'Δ', 'Γ', 'ν', 'Θ'] as const;
type ChartMode = typeof CHART_MODES[number];

// ── types ──────────────────────────────────────────────────────────────────

interface Leg {
  id: string; call: boolean; K: number; T: number;  // T in years
  qty: number;                                       // signed: + long, − short
  entry: number;                                     // per-share entry price
}

interface Snapshot {
  price: number; delta: number; gamma: number;
  theta: number; vega: number;  pnl:   number;
  calcUs: number; multi: boolean;
}

interface LabViz {
  paths: number[][];       // sampled GBM paths (per-path array of prices)
  horizonT: number;
  bins: { x0: number; x1: number; n: number; itm: boolean }[];
  binMax: number;
  pLo: number; pHi: number;
  K: number | null; call: boolean;
}

interface LabResult {
  bsV: number; binV: number; mcV: number; se: number; z: number;
  msBs: number; msBin: number; msMc: number; paths: number;
  viz: LabViz;
}

// ── Black-Scholes (in-browser; mirrors the C++ engine's math) ────────────────

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-x * x / 2);
}

interface BSOut { price: number; delta: number; gamma: number; theta: number; vega: number; }

function bs(S: number, K: number, r: number, sigma: number, T: number, call: boolean): BSOut {
  if (S <= 0 || K <= 0 || sigma <= 0 || T <= 0) {
    const intr = Math.max(call ? S - K : K - S, 0);
    return { price: intr, delta: 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2), pdf = normPdf(d1);
  const price = call ? S * Nd1 - K * disc * Nd2
                     : K * disc * normCdf(-d2) - S * normCdf(-d1);
  const delta = call ? Nd1 : Nd1 - 1;
  const gamma = pdf / (S * sigma * sqrtT);
  const theta = -(S * pdf * sigma) / (2 * sqrtT)
                - (call ? r * K * disc * Nd2 : -r * K * disc * normCdf(-d2));
  const vega  = S * pdf * sqrtT;
  return { price, delta, gamma, theta, vega };
}

const intrinsic = (S: number, K: number, call: boolean) => Math.max(call ? S - K : K - S, 0);

// ── Binomial (Cox-Ross-Rubinstein, European) ─────────────────────────────────

function binomialPrice(S: number, K: number, r: number, sigma: number, T: number,
                       call: boolean, steps = BIN_STEPS): number {
  if (S <= 0 || K <= 0 || sigma <= 0 || T <= 0) return intrinsic(S, K, call);
  const dt = T / steps;
  const u = Math.exp(sigma * Math.sqrt(dt)), d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  const disc = Math.exp(-r * dt);
  const vals = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const ST = S * Math.pow(u, steps - i) * Math.pow(d, i);
    vals[i] = intrinsic(ST, K, call);
  }
  for (let s = steps - 1; s >= 0; s--) {
    for (let i = 0; i <= s; i++) vals[i] = disc * (p * vals[i] + (1 - p) * vals[i + 1]);
  }
  return vals[0];
}

// ── seeded RNG (mulberry32) + standard normals via Box-Muller ────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Monte Carlo lab: price portfolio with all three models ───────────────────
// MC draws ONE standard normal per path and applies it across legs scaled by
// each leg's own horizon (single-factor GBM coupling) — the portfolio mean and
// standard error are then computed on the per-path portfolio payoff, so the SE
// shown is the real sampling error of the estimate.

function runLab(legs: Leg[], S: number, sigma: number, r: number,
                nPaths: number, seed: number): LabResult {
  // Black-Scholes (closed form)
  let t0 = performance.now();
  const bsV = legs.reduce((a, l) => a + l.qty * 100 * bs(S, l.K, r, sigma, l.T, l.call).price, 0);
  const msBs = performance.now() - t0;

  // Binomial CRR
  t0 = performance.now();
  const binV = legs.reduce((a, l) =>
    a + l.qty * 100 * binomialPrice(S, l.K, r, sigma, l.T, l.call), 0);
  const msBin = performance.now() - t0;

  // Monte Carlo (direct terminal sampling — exact for GBM European)
  t0 = performance.now();
  const rng = mulberry32(seed);
  const pre = legs.map(l => ({
    drift: (r - 0.5 * sigma * sigma) * l.T,
    volT:  sigma * Math.sqrt(l.T),
    disc:  Math.exp(-r * l.T) * l.qty * 100,
    K: l.K, call: l.call,
  }));
  let sum = 0, sumSq = 0;
  let z1 = 0, hasSpare = false, spare = 0;
  for (let i = 0; i < nPaths; i++) {
    if (hasSpare) { z1 = spare; hasSpare = false; }
    else {
      const u1 = Math.max(rng(), 1e-12), u2 = rng();
      const m = Math.sqrt(-2 * Math.log(u1));
      z1 = m * Math.cos(2 * Math.PI * u2);
      spare = m * Math.sin(2 * Math.PI * u2);
      hasSpare = true;
    }
    let pv = 0;
    for (const p of pre) {
      const ST = S * Math.exp(p.drift + p.volT * z1);
      pv += p.disc * intrinsic(ST, p.K, p.call);
    }
    sum += pv; sumSq += pv * pv;
  }
  const mcV  = sum / nPaths;
  const varm = Math.max(sumSq / nPaths - mcV * mcV, 0) / nPaths;
  const se   = Math.sqrt(varm);
  const msMc = performance.now() - t0;
  const z    = se > 0 ? Math.abs(mcV - bsV) / se : 0;

  // ── visualization: sample paths + terminal histogram ──────────────────────
  const horizonT = Math.max(...legs.map(l => l.T));
  const vizRng = mulberry32(seed ^ 0x9E3779B9);
  const NPATHS_VIZ = 42, NSTEPS = 48;
  const dt = horizonT / NSTEPS, drift = (r - 0.5 * sigma * sigma) * dt, volDt = sigma * Math.sqrt(dt);
  const paths: number[][] = [];
  for (let p = 0; p < NPATHS_VIZ; p++) {
    const path = [S];
    let cur = S;
    for (let s = 0; s < NSTEPS; s++) {
      const u1 = Math.max(vizRng(), 1e-12), u2 = vizRng();
      const zz = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      cur = cur * Math.exp(drift + volDt * zz);
      path.push(cur);
    }
    paths.push(path);
  }
  // terminal histogram from a dedicated 20k sample at the horizon
  const NH = 20_000;
  const hRng = mulberry32(seed ^ 0x85EBCA6B);
  const hDrift = (r - 0.5 * sigma * sigma) * horizonT, hVol = sigma * Math.sqrt(horizonT);
  const terms = new Float64Array(NH);
  for (let i = 0; i < NH; i++) {
    const u1 = Math.max(hRng(), 1e-12), u2 = hRng();
    const zz = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    terms[i] = S * Math.exp(hDrift + hVol * zz);
  }
  const sorted = Float64Array.from(terms).sort();
  const pLo = sorted[Math.floor(NH * 0.005)], pHi = sorted[Math.floor(NH * 0.995)];
  const NB = 36;
  const singleK = legs.length === 1 ? legs[0].K : null;
  const singleCall = legs.length === 1 ? legs[0].call : true;
  const bins = Array.from({ length: NB }, (_, i) => {
    const x0 = pLo + ((pHi - pLo) * i) / NB, x1 = pLo + ((pHi - pLo) * (i + 1)) / NB;
    const mid = (x0 + x1) / 2;
    return { x0, x1, n: 0,
             itm: singleK != null && intrinsic(mid, singleK, singleCall) > 0 };
  });
  for (let i = 0; i < NH; i++) {
    const b = Math.min(NB - 1, Math.max(0, Math.floor(((terms[i] - pLo) / (pHi - pLo)) * NB)));
    bins[b].n++;
  }
  const binMax = Math.max(...bins.map(b => b.n), 1);

  return { bsV, binV, mcV, se, z, msBs, msBin, msMc, paths: nPaths,
           viz: { paths, horizonT, bins, binMax, pLo, pHi, K: singleK, call: singleCall } };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const mkId = () => Math.random().toString(36).slice(2, 9);

const fmtUsd = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '+';
  if (a >= 100_000) return `${s}$${(a / 1000).toFixed(0)}k`;
  if (a >= 10_000)  return `${s}$${(a / 1000).toFixed(1)}k`;
  return `${s}$${a.toFixed(0)}`;
};
const fmtUsdPrec = (v: number) => {
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  return `${s}$${a.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
};

function atmStrike(inst: Inst): number {
  return Math.round(inst.spot / inst.kstep) * inst.kstep;
}

function defaultLegs(inst: Inst, S: number, sigma: number, r: number): Leg[] {
  if (inst.sym === 'SPY') {
    // Canonical engine-priced leg — identical to the C++ subscription.
    return [{ id: 'd', call: true, K: BASE_OPT.K, T: BASE_OPT.T, qty: 10,
              entry: bs(BASE_OPT.S, BASE_OPT.K, BASE_OPT.r, BASE_OPT.sigma, BASE_OPT.T, true).price }];
  }
  const K = atmStrike(inst), T = 47 / 365;
  return [{ id: mkId(), call: true, K, T, qty: 10, entry: bs(S, K, r, sigma, T, true).price }];
}

// Strategy templates for the current instrument (ATM-centred, ~2% wings).
function strategyLegs(name: string, inst: Inst, S: number, sigma: number, r: number): Leg[] {
  if (name === 'Long Call') return defaultLegs(inst, S, sigma, r);
  const K = atmStrike(inst), T = 47 / 365, ks = inst.kstep;
  const w = Math.max(ks, Math.round((inst.spot * 0.02) / ks) * ks);
  const mk = (call: boolean, strike: number, qty: number): Leg =>
    ({ id: mkId(), call, K: strike, T, qty, entry: bs(S, strike, r, sigma, T, call).price });
  switch (name) {
    case 'Long Put':    return [mk(false, K, 10)];
    case 'Straddle':    return [mk(true, K, 10), mk(false, K, 10)];
    case 'Strangle':    return [mk(true, K + w, 10), mk(false, K - w, 10)];
    case 'Bull Spread': return [mk(true, K, 10), mk(true, K + w, -10)];
    case 'Iron Condor': return [mk(false, K - 2 * w, 10), mk(false, K - w, -10),
                                mk(true,  K + w, -10),   mk(true,  K + 2 * w, 10)];
    default:            return defaultLegs(inst, S, sigma, r);
  }
}
const STRATEGY_NAMES = ['Long Call', 'Long Put', 'Straddle', 'Strangle', 'Bull Spread', 'Iron Condor'];

// The exact state in which the local C++ engine (when connected) is authoritative.
function isEnginePortfolio(instSym: string, legs: Leg[]): boolean {
  return instSym === 'SPY' && legs.length === 1 && legs[0].call &&
         legs[0].K === BASE_OPT.K && Math.abs(legs[0].T - BASE_OPT.T) < 1e-9 &&
         legs[0].qty === 10;
}

// Rows: type,strike,days,qty  (qty < 0 = short). Header row optional.
function rowsToLegs(rows: string[][], S: number, sigma: number, r: number):
    { legs?: Leg[]; error?: string } {
  const legs: Leg[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map(c => String(c ?? '').trim());
    if (!cells.some(Boolean)) continue;
    if (i === 0 && /type/i.test(cells[0])) continue;           // header
    if (cells.length < 4) return { error: `Row ${i + 1}: need type,strike,days,qty` };
    const call = /^c/i.test(cells[0]);
    const put  = /^p/i.test(cells[0]);
    if (!call && !put) return { error: `Row ${i + 1}: type must be call or put` };
    const K = parseFloat(cells[1]), days = parseFloat(cells[2]), qty = parseFloat(cells[3]);
    if (!isFinite(K) || K <= 0)          return { error: `Row ${i + 1}: bad strike` };
    if (!isFinite(days) || days < 1 || days > 1095) return { error: `Row ${i + 1}: days must be 1–1095` };
    if (!isFinite(qty) || qty === 0 || Math.abs(qty) > 999) return { error: `Row ${i + 1}: bad qty` };
    const T = days / 365;
    legs.push({ id: mkId(), call, K, T, qty, entry: bs(S, K, r, sigma, T, call).price });
    if (legs.length > MAX_LEGS) return { error: `Max ${MAX_LEGS} legs.` };
  }
  if (!legs.length) return { error: 'No positions found.' };
  return { legs };
}

const SAMPLE_CSV = 'data:text/csv;charset=utf-8,' +
  encodeURIComponent('type,strike,days,qty\ncall,760,47,10\nput,750,47,10\n');

// ── strategy chart (P&L + Greek curve modes) ─────────────────────────────────

function StrategyChart({ legs, spot, sigma, rate, inst, mode }:
    { legs: Leg[]; spot: number; sigma: number; rate: number; inst: Inst; mode: ChartMode }) {
  const W = 680, H = 320, padL = 48, padR = 16, padT = 18, padB = 28;
  const xMin = inst.spot * 0.873, xMax = inst.spot * 1.137;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverS, setHoverS] = useState<number | null>(null);

  const nowPnl = (S: number) =>
    legs.reduce((a, l) => a + l.qty * 100 * (bs(S, l.K, rate, sigma, l.T, l.call).price - l.entry), 0);
  const expPnl = (S: number) =>
    legs.reduce((a, l) => a + l.qty * 100 * (intrinsic(S, l.K, l.call) - l.entry), 0);
  const greekAt = (S: number): number => {
    let d = 0, g = 0, v = 0, t = 0;
    legs.forEach(l => {
      const o = bs(S, l.K, rate, sigma, l.T, l.call);
      const m = l.qty * 100;
      d += m * o.delta; g += m * o.gamma; v += m * o.vega; t += m * o.theta;
    });
    switch (mode) {
      case 'Δ': return d;                 // share-equivalents
      case 'Γ': return g;                 // shares per $
      case 'ν': return v * 0.01;          // $ per 1% vol
      case 'Θ': return t / 365;           // $ per day
      default:  return 0;
    }
  };
  const isPnl = mode === 'P&L';
  const series = (S: number) => (isPnl ? nowPnl(S) : greekAt(S));
  const fmtY = (val: number): string => {
    if (mode === 'Δ') return `${val >= 0 ? '+' : ''}${val.toFixed(0)} sh`;
    if (mode === 'Γ') return val.toFixed(1);
    return fmtUsd(val);
  };

  // sample grid + explicit strike points for crisp expiry kinks
  const xs: number[] = [];
  const N = 150;
  for (let i = 0; i <= N; i++) xs.push(xMin + (xMax - xMin) * (i / N));
  legs.forEach(l => { if (l.K > xMin && l.K < xMax) xs.push(l.K - 0.01, l.K, l.K + 0.01); });
  xs.sort((a, b) => a - b);

  const mainPts: [number, number][] = xs.map(S => [S, series(S)]);
  const expPts:  [number, number][] = isPnl ? xs.map(S => [S, expPnl(S)]) : [];

  let yLo = 0, yHi = 0;
  [...mainPts, ...expPts].forEach(([, v]) => { yLo = Math.min(yLo, v); yHi = Math.max(yHi, v); });
  const span = Math.max(yHi - yLo, 1e-6);
  yLo -= span * 0.08; yHi += span * 0.08;

  const x = (S: number) => padL + ((S - xMin) / (xMax - xMin)) * (W - padL - padR);
  const y = (v: number) => padT + ((yHi - v) / (yHi - yLo)) * (H - padT - padB);
  const y0 = y(0);
  const toPath = (pts: [number, number][]) =>
    pts.map(([S, v], i) => `${i ? 'L' : 'M'}${x(S).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const mainPath = toPath(mainPts);
  const expPath  = isPnl ? toPath(expPts) : '';
  const expArea  = isPnl
    ? `${expPath} L${x(xMax).toFixed(1)},${y0.toFixed(1)} L${x(xMin).toFixed(1)},${y0.toFixed(1)} Z` : '';

  // break-evens: zero crossings of expiry P&L (P&L mode only)
  const bes: number[] = [];
  if (isPnl) {
    for (let i = 1; i < expPts.length; i++) {
      const [s0, v0] = expPts[i - 1], [s1, v1] = expPts[i];
      if ((v0 <= 0 && v1 > 0) || (v0 >= 0 && v1 < 0)) {
        const t = Math.abs(v1 - v0) < 1e-9 ? 0 : -v0 / (v1 - v0);
        const s = s0 + (s1 - s0) * t;
        if (!bes.some(b => Math.abs(b - s) < inst.spot * 0.004)) bes.push(s);
      }
    }
  }

  // nice y ticks
  const rawStep = (yHi - yLo) / 4.5;
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 1e-9))));
  const nn = rawStep / pow;
  const step = (nn < 1.5 ? 1 : nn < 3 ? 2 : nn < 7 ? 5 : 10) * pow;
  const yTicks: number[] = [];
  for (let t = Math.ceil(yLo / step) * step; t <= yHi + 1e-9; t += step) yTicks.push(t);

  const xTicks: number[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = xMin + (xMax - xMin) * (i / 4);
    xTicks.push(Math.round(v / 10) * 10);
  }

  const spotC = Math.max(xMin, Math.min(xMax, spot));
  const curVal = series(spotC);
  const cx = x(spotC), cy = y(curVal);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    let S = xMin + ((vbX - padL) / (W - padL - padR)) * (xMax - xMin);
    S = Math.max(xMin, Math.min(xMax, S));
    setHoverS(S);
  };
  const hMain = hoverS != null ? series(hoverS) : null;
  const hExp  = hoverS != null && isPnl ? expPnl(hoverS) : null;
  const hx = hoverS != null ? x(hoverS) : 0;

  const modeName = mode === 'P&L' ? 'profit and loss'
    : mode === 'Δ' ? 'net delta' : mode === 'Γ' ? 'net gamma'
    : mode === 'ν' ? 'net vega per 1 percent vol' : 'net theta per day';

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
         preserveAspectRatio="xMidYMid meet"
         onPointerMove={onMove} onPointerLeave={() => setHoverS(null)}
         aria-label={`${modeName} curve across spot, ${legs.length} leg${legs.length > 1 ? 's' : ''}. Current value ${fmtY(curVal)} at spot ${spot.toFixed(0)}.${bes.length ? ` Break-even near ${bes.map(b => b.toFixed(0)).join(' and ')}.` : ''}`}
         style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}>
      <defs>
        <clipPath id="clipPos"><rect x={padL} y={padT - 2} width={W - padL - padR} height={Math.max(y0 - padT + 2, 0)} /></clipPath>
        <clipPath id="clipNeg"><rect x={padL} y={y0} width={W - padL - padR} height={Math.max(H - padB - y0 + 2, 0)} /></clipPath>
      </defs>

      {/* y gridlines + labels */}
      {yTicks.map(t => (
        <g key={t}>
          <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)}
                stroke={Math.abs(t) < 1e-9 ? 'var(--line-strong)' : 'rgba(201,168,106,0.08)'} strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3} fill="var(--muted-2)" fontSize="9" textAnchor="end"
                fontFamily="var(--mono)">{fmtY(t).replace('+$0', '$0')}</text>
        </g>
      ))}

      {/* x ticks */}
      {xTicks.map(t => (
        <text key={t} x={x(t)} y={H - 10} fill="var(--muted-2)" fontSize="9.5" textAnchor="middle"
              fontFamily="var(--mono)">{t}</text>
      ))}

      {/* profit / loss shading of expiry payoff (P&L mode) */}
      {isPnl && <path d={expArea} fill="rgba(99,216,145,0.13)" clipPath="url(#clipPos)" />}
      {isPnl && <path d={expArea} fill="rgba(244,122,128,0.12)" clipPath="url(#clipNeg)" />}

      {/* strike marker (single leg only, to avoid clutter) */}
      {legs.length === 1 && legs[0].K > xMin && legs[0].K < xMax && (
        <g>
          <line x1={x(legs[0].K)} y1={padT} x2={x(legs[0].K)} y2={H - padB}
                stroke="var(--muted-2)" strokeWidth="1" strokeDasharray="3 4" opacity="0.6" />
          <text x={x(legs[0].K) + 4} y={padT + 9} fill="var(--muted-2)" fontSize="9.5"
                fontFamily="var(--mono)">K {legs[0].K}</text>
        </g>
      )}

      {/* break-even markers */}
      {bes.slice(0, 4).map(b => (
        <g key={b}>
          <line x1={x(b)} y1={y0 - 7} x2={x(b)} y2={y0 + 7} stroke="var(--green)" strokeWidth="1.6" />
          <text x={x(b)} y={y0 - 11} fill="var(--green)" fontSize="9" textAnchor="middle" opacity="0.95"
                fontFamily="var(--mono)">B/E {b.toFixed(0)}</text>
        </g>
      ))}

      {/* expiry P&L */}
      {isPnl && (
        <path d={expPath} fill="none" stroke="var(--muted-2)" strokeWidth="1.4" strokeDasharray="5 5" opacity="0.85" />
      )}
      {/* main curve */}
      <path className="chart-line" d={mainPath} fill="none" stroke="var(--gold)"
            strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />

      {/* hover crosshair + tooltip */}
      {hMain != null && (
        <g>
          <line x1={hx} y1={padT} x2={hx} y2={H - padB} stroke="var(--ink)" strokeWidth="1" opacity="0.22" />
          <circle cx={hx} cy={y(hMain)} r="4" fill="var(--ink-bright)" />
          <g transform={`translate(${Math.min(Math.max(hx, 72), W - 84)}, ${padT + 8})`}>
            <rect x="-68" y="-6" width="136" height={hExp != null ? 44 : 32} rx="7"
                  fill="#141210" stroke="var(--line-strong)" />
            <text x="0" y="6" fill="var(--muted)" fontSize="9" textAnchor="middle" fontFamily="var(--mono)">
              spot {hoverS!.toFixed(inst.spot > 400 ? 0 : 1)}
            </text>
            <text x="0" y="19" fill="var(--gold-bright)" fontSize="10" fontWeight="700" textAnchor="middle"
                  fontFamily="var(--mono)">{isPnl ? `now ${fmtUsd(hMain)}` : fmtY(hMain)}</text>
            {hExp != null && (
              <text x="0" y="31" fill="var(--muted)" fontSize="9.5" textAnchor="middle"
                    fontFamily="var(--mono)">expiry {fmtUsd(hExp)}</text>
            )}
          </g>
        </g>
      )}

      {/* current spot marker */}
      <line x1={cx} y1={Math.min(cy, y0)} x2={cx} y2={Math.max(cy, y0)}
            stroke="var(--gold-bright)" strokeWidth="1" opacity="0.5" />
      <circle className="dot-ring" cx={cx} cy={cy} r="11" fill="none" stroke="var(--gold-bright)" strokeWidth="1" />
      <circle cx={cx} cy={cy} r="6" fill="var(--gold-bright)" stroke="#0c0b0a" strokeWidth="2" />
      {hMain == null && (
        <text x={cx} y={cy - 15} fill="var(--ink-bright)" fontSize="11.5" fontWeight="700"
              textAnchor="middle" fontFamily="var(--mono)">{fmtY(curVal)}</text>
      )}
    </svg>
  );
}

// ── Monte Carlo lab charts ────────────────────────────────────────────────────

function McPathsChart({ viz, animKey }: { viz: LabViz; animKey: string }) {
  const W = 460, H = 230, padL = 8, padR = 8, padT = 10, padB = 20;
  const all = viz.paths.flat();
  let lo = Math.min(...all), hi = Math.max(...all);
  if (viz.K != null) { lo = Math.min(lo, viz.K); hi = Math.max(hi, viz.K); }
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const n = viz.paths[0]?.length ?? 1;
  const x = (i: number) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v: number) => padT + ((hi - v) / (hi - lo)) * (H - padT - padB);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" preserveAspectRatio="xMidYMid meet"
         aria-label={`${viz.paths.length} sample GBM Monte Carlo paths over ${Math.round(viz.horizonT * 365)} days.`}
         style={{ display: 'block' }}>
      {viz.K != null && (
        <g>
          <line x1={padL} y1={y(viz.K)} x2={W - padR} y2={y(viz.K)}
                stroke="var(--muted-2)" strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
          <text x={W - padR - 4} y={y(viz.K) - 4} fill="var(--muted-2)" fontSize="9"
                textAnchor="end" fontFamily="var(--mono)">K {viz.K}</text>
        </g>
      )}
      <g key={animKey}>
        {viz.paths.map((p, i) => (
          <path key={i} className="mc-path"
                style={{ animationDelay: `${i * 14}ms` }}
                d={p.map((v, j) => `${j ? 'L' : 'M'}${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
                fill="none"
                stroke={i % 7 === 0 ? 'var(--gold-bright)' : 'var(--gold)'}
                strokeWidth={i % 7 === 0 ? 1.4 : 0.7}
                opacity={i % 7 === 0 ? 0.85 : 0.28} />
        ))}
      </g>
      <text x={padL + 2} y={H - 6} fill="var(--muted-2)" fontSize="9" fontFamily="var(--mono)">t = 0</text>
      <text x={W - padR - 2} y={H - 6} fill="var(--muted-2)" fontSize="9" textAnchor="end"
            fontFamily="var(--mono)">{Math.round(viz.horizonT * 365)}d</text>
    </svg>
  );
}

function McHistChart({ viz, animKey }: { viz: LabViz; animKey: string }) {
  const W = 460, H = 230, padL = 8, padR = 8, padT = 12, padB = 22;
  const x0 = (v: number) => padL + ((v - viz.pLo) / (viz.pHi - viz.pLo)) * (W - padL - padR);
  const bh = (nCount: number) => (nCount / viz.binMax) * (H - padT - padB);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" preserveAspectRatio="xMidYMid meet"
         aria-label={`Terminal price distribution histogram from 20 thousand Monte Carlo samples${viz.K != null ? `, in-the-money region highlighted around strike ${viz.K}` : ''}.`}
         style={{ display: 'block' }}>
      <g key={animKey}>
        {viz.bins.map((b, i) => {
          const bx = x0(b.x0), bw = Math.max(x0(b.x1) - bx - 1, 1);
          const h = bh(b.n);
          return (
            <rect key={i} className="mc-bar"
                  style={{ animationDelay: `${i * 10}ms` }}
                  x={bx} y={H - padB - h} width={bw} height={Math.max(h, 0.5)}
                  rx="1.5"
                  fill={b.itm ? 'rgba(99,216,145,0.55)' : 'rgba(201,168,106,0.42)'} />
          );
        })}
      </g>
      {viz.K != null && viz.K > viz.pLo && viz.K < viz.pHi && (
        <g>
          <line x1={x0(viz.K)} y1={padT} x2={x0(viz.K)} y2={H - padB}
                stroke="var(--muted-2)" strokeWidth="1" strokeDasharray="4 4" opacity="0.8" />
          <text x={x0(viz.K) + 4} y={padT + 8} fill="var(--muted-2)" fontSize="9"
                fontFamily="var(--mono)">K {viz.K}</text>
        </g>
      )}
      <text x={padL + 2} y={H - 8} fill="var(--muted-2)" fontSize="9"
            fontFamily="var(--mono)">{viz.pLo.toFixed(0)}</text>
      <text x={W - padR - 2} y={H - 8} fill="var(--muted-2)" fontSize="9" textAnchor="end"
            fontFamily="var(--mono)">{viz.pHi.toFixed(0)}</text>
    </svg>
  );
}

// ── component ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const spyInst = INSTRUMENTS[0];
  const [instKey, setInstKey] = useState('SPY');
  const inst = INSTRUMENTS.find(i => i.sym === instKey)!;

  const [status,  setStatus]  = useState<'connecting' | 'connected' | 'demo'>('connecting');
  const [snap,    setSnap]    = useState<Snapshot | null>(null);
  const [spot,    setSpot]    = useState(spyInst.spot);
  const [sigma,   setSigma]   = useState(spyInst.vol);
  const [rate,    setRate]    = useState(0.045);
  const [scen,    setScen]    = useState('Reset');
  const [strat,   setStrat]   = useState('Long Call');
  const [legs,    setLegs]    = useState<Leg[]>(() => defaultLegs(spyInst, spyInst.spot, spyInst.vol, 0.045));
  const [live,    setLive]    = useState('');
  const [csvMsg,  setCsvMsg]  = useState('');
  const [drag,    setDrag]    = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>('P&L');
  const [mcPaths, setMcPaths] = useState(PATH_OPTS[1]);
  const [mcTick,  setMcTick]  = useState(0);
  const [lab,     setLab]     = useState<LabResult | null>(null);

  const wsRef    = useRef<WebSocket | null>(null);
  const demoRef  = useRef(false);
  const localRef = useRef(false);          // true → price in-browser even if WS is up
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef  = useRef<HTMLInputElement | null>(null);
  const legsRef  = useRef(legs); legsRef.current = legs;

  // ── local portfolio pricing ───────────────────────────────────────────────

  const computeLocal = useCallback((S: number, sig: number, r: number) => {
    const t0 = performance.now();
    const ls = legsRef.current;
    const outs = ls.map(l => bs(S, l.K, r, sig, l.T, l.call));
    const calcUs = (performance.now() - t0) * 1000;
    if (ls.length === 1) {
      const g = outs[0], l = ls[0];
      setSnap({ price: g.price, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega,
                pnl: (g.price - l.entry) * l.qty * 100, calcUs, multi: false });
    } else {
      let price = 0, delta = 0, gamma = 0, theta = 0, vega = 0, pnl = 0;
      ls.forEach((l, i) => {
        const g = outs[i], m = l.qty * 100;
        price += m * g.price; delta += m * g.delta; gamma += m * g.gamma;
        theta += m * g.theta; vega  += m * g.vega;
        pnl   += m * (g.price - l.entry);
      });
      setSnap({ price, delta, gamma, theta, vega, pnl, calcUs, multi: true });
    }
  }, []);

  const sendUpdate = useCallback((S: number, sig: number, r: number) => {
    if (demoRef.current || localRef.current) { computeLocal(S, sig, r); return; }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'update', S, sigma: sig, r,
        t_ns: Math.round(performance.now() * 1_000_000),
      }));
    }
  }, [computeLocal]);

  // ── WebSocket lifecycle (falls back to in-browser demo) ──────────────────

  useEffect(() => {
    let ws: WebSocket | null = null;

    const goDemo = () => {
      if (demoRef.current) return;
      demoRef.current = true;
      setStatus('demo');
      computeLocal(BASE_OPT.S, BASE_OPT.sigma, BASE_OPT.r);
    };

    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(host);
    if (!isLocal) { goDemo(); return; }

    const demoTimer = setTimeout(goDemo, 1200);
    try {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        clearTimeout(demoTimer);
        setStatus('connected');
        ws!.send(JSON.stringify({ type: 'subscribe', option: BASE_OPT }));
      };
      ws.onmessage = (ev) => {
        if (localRef.current) return;   // engine snapshot only when it's authoritative
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'subscribed') {
          setSnap({ price: msg.price, delta: msg.delta, gamma: msg.gamma,
                    theta: msg.theta, vega: msg.vega, pnl: 0, calcUs: 0, multi: false });
        } else if (msg.type === 'result') {
          setSnap({ price: msg.price, delta: msg.delta, gamma: msg.gamma,
                    theta: msg.theta, vega: msg.vega, pnl: msg.pnl,
                    calcUs: msg.calc_us, multi: false });
        }
      };
      ws.onerror = () => { clearTimeout(demoTimer); goDemo(); };
      ws.onclose = () => { clearTimeout(demoTimer); goDemo(); };
    } catch {
      clearTimeout(demoTimer); goDemo();
    }
    return () => { clearTimeout(demoTimer); if (ws) ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── react to portfolio / instrument changes ───────────────────────────────
  useEffect(() => {
    const engineOK = isEnginePortfolio(instKey, legs);
    localRef.current = !engineOK;
    if (demoRef.current || !engineOK) {
      computeLocal(spot, sigma, rate);
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      sendUpdate(spot, sigma, rate);      // back to canonical → resync engine
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, instKey]);

  // ── pricing-models lab (debounced; BS vs Binomial vs seeded MC) ───────────
  useEffect(() => {
    const id = setTimeout(() => {
      try {
        setLab(runLab(legsRef.current, spot, sigma, rate, mcPaths, 42 + mcTick));
      } catch { /* lab is auxiliary — never break the page */ }
    }, 260);
    return () => clearTimeout(id);
  }, [legs, spot, sigma, rate, mcPaths, mcTick]);

  // ── screen-reader announcements (debounced) ───────────────────────────────
  useEffect(() => {
    if (!snap) return;
    const id = setTimeout(() => {
      setLive(`P and L ${snap.pnl >= 0 ? 'up' : 'down'} ${Math.abs(snap.pnl).toFixed(0)} dollars.`);
    }, 550);
    return () => clearTimeout(id);
  }, [snap]);

  // ── slider handlers ───────────────────────────────────────────────────────
  const onSpot  = (v: number) => { setScen(''); setSpot(v);  sendUpdate(v, sigma, rate); };
  const onSigma = (v: number) => { setScen(''); setSigma(v); sendUpdate(spot, v, rate); };
  const onRate  = (v: number) => { setScen(''); setRate(v);  sendUpdate(spot, sigma, v); };

  // ── animated market scenarios ─────────────────────────────────────────────
  const applyScenario = useCallback((sc: typeof SCENARIOS[number]) => {
    setScen(sc.name);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    const tgtS = Math.max(inst.min, Math.min(inst.max, inst.spot * sc.s));
    const tgtV = Math.max(0.05, Math.min(0.50, inst.vol * sc.v));
    const apply = (S: number, sig: number) => { setSpot(S); setSigma(sig); sendUpdate(S, sig, rate); };

    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { apply(tgtS, tgtV); return; }

    const s0 = spot, v0 = sigma, dur = 520, t0 = performance.now();
    const ease = (u: number) => 1 - Math.pow(1 - u, 3);
    timerRef.current = setInterval(() => {
      const u = Math.min(1, (performance.now() - t0) / dur), e = ease(u);
      apply(s0 + (tgtS - s0) * e, v0 + (tgtV - v0) * e);
      if (u >= 1 && timerRef.current) {
        clearInterval(timerRef.current); timerRef.current = null;
        apply(tgtS, tgtV);
      }
    }, 16);
  }, [spot, sigma, rate, inst, sendUpdate]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // ── instrument / strategy / legs actions ──────────────────────────────────
  const pickInstrument = (sym: string) => {
    const ni = INSTRUMENTS.find(i => i.sym === sym)!;
    setInstKey(sym); setScen('Reset'); setStrat('Long Call'); setCsvMsg('');
    setSpot(ni.spot); setSigma(ni.vol);
    setLegs(defaultLegs(ni, ni.spot, ni.vol, rate));
  };

  const pickStrategy = (name: string) => {
    setStrat(name); setCsvMsg('');
    setLegs(strategyLegs(name, inst, spot, sigma, rate));
  };

  const editLeg = (id: string, patch: Partial<Pick<Leg, 'call' | 'K' | 'qty'>> & { days?: number }) => {
    setStrat(''); setCsvMsg('');
    setLegs(ls => ls.map(l => {
      if (l.id !== id) return l;
      const call = patch.call ?? l.call;
      const K    = patch.K != null && isFinite(patch.K) && patch.K > 0 ? patch.K : l.K;
      const T    = patch.days != null && isFinite(patch.days)
                   ? Math.min(Math.max(patch.days, 1), 1095) / 365 : l.T;
      const qty  = patch.qty != null && isFinite(patch.qty) ? patch.qty : l.qty;
      return { ...l, call, K, T, qty, entry: bs(spot, K, rate, sigma, T, call).price };
    }));
  };

  const addLeg = () => {
    setStrat(''); setCsvMsg('');
    const K = atmStrike(inst), T = 47 / 365;
    setLegs(ls => ls.length >= MAX_LEGS ? ls :
      [...ls, { id: mkId(), call: true, K, T, qty: 10, entry: bs(spot, K, rate, sigma, T, true).price }]);
  };

  const removeLeg = (id: string) => {
    setStrat(''); setCsvMsg('');
    setLegs(ls => ls.length <= 1 ? ls : ls.filter(l => l.id !== id));
  };

  // ── file upload: CSV directly, Excel via dynamically-imported SheetJS ─────
  const applyRows = (rows: string[][], srcLabel: string) => {
    const res = rowsToLegs(rows, spot, sigma, rate);
    if (res.error) { setCsvMsg(`✗ ${res.error}`); return; }
    setStrat(''); setLegs(res.legs!);
    setCsvMsg(`✓ Loaded ${res.legs!.length} position${res.legs!.length > 1 ? 's' : ''} from ${srcLabel} — parsed in your browser, nothing uploaded.`);
  };

  const onFile = (f: File | undefined | null) => {
    if (!f) return;
    if (f.size > 2_000_000) { setCsvMsg('✗ File too large (max 2 MB).'); return; }
    const isExcel = /\.xlsx?$/i.test(f.name);
    if (isExcel) {
      setCsvMsg('… parsing Excel workbook');
      const rd = new FileReader();
      rd.onload = async () => {
        try {
          const XLSX = await import('xlsx');               // code-split; loads on demand
          const wb = XLSX.read(rd.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false }) as string[][];
          applyRows(rows.map(r => (r ?? []).map(c => String(c ?? ''))), f.name);
        } catch {
          setCsvMsg('✗ Could not read that workbook — export as CSV and retry.');
        }
      };
      rd.readAsArrayBuffer(f);
    } else {
      const rd = new FileReader();
      rd.onload = () => {
        const text = String(rd.result ?? '');
        const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
                         .map(l => l.split(/[,;\t]/));
        applyRows(rows, f.name);
      };
      rd.readAsText(f);
    }
  };

  // ── derived ────────────────────────────────────────────────────────────────
  const statusColor = status === 'connected' ? 'var(--green)'
                    : status === 'connecting' ? '#e0a94a' : 'var(--gold)';
  const statusText  = status === 'connected' ? 'Connected'
                    : status === 'connecting' ? 'Connecting…' : 'Live demo';
  const engineMode  = status === 'connected' && isEnginePortfolio(instKey, legs);

  const moneyness = legs.length === 1 ? spot / legs[0].K : 1;
  const moneyLabel = legs.length !== 1 ? `${legs.length} legs`
                   : moneyness > 1.002 ? 'ITM' : moneyness < 0.998 ? 'OTM' : 'ATM';

  // per-leg greeks for surface + parametric VaR (aggregated locally)
  const legG = legs.map(l => ({ l, g: bs(spot, l.K, rate, sigma, l.T, l.call) }));
  const netD = legG.reduce((a, { l, g }) => a + l.qty * 100 * g.delta, 0);
  const netG = legG.reduce((a, { l, g }) => a + l.qty * 100 * g.gamma, 0);
  // 1-day 95% parametric VaR (delta-gamma, current σ): worst of ±1.645σ√(1/252) move
  const dS1d = 1.645 * spot * sigma / Math.sqrt(252);
  const lossAt = (dx: number) => -(netD * dx + 0.5 * netG * dx * dx);
  const var95 = Math.max(lossAt(dS1d), lossAt(-dS1d), 0);

  const surface = snap ? SPOT_SHOCKS.map(ds =>
    VOL_SHOCKS.map(dv => {
      const dS = spot * ds, dSig = sigma * dv;
      return legG.reduce((a, { l, g }) =>
        a + (g.delta * dS + 0.5 * g.gamma * dS * dS + g.vega * dSig) * l.qty * 100, 0);
    })
  ) : null;
  const surfMax = surface ? Math.max(1, ...surface.flat().map(v => Math.abs(v))) : 1;

  const tiles: [string, string, string, string][] = snap ? (snap.multi ? [
    ['Net value',  'price', fmtUsd(snap.price),                'var(--ink-bright)'],
    ['Net Δ',      'delta', `${snap.delta >= 0 ? '+' : ''}${snap.delta.toFixed(0)} sh`, 'var(--ink-bright)'],
    ['Net Γ',      'gamma', snap.gamma.toFixed(1),             'var(--ink-bright)'],
    ['Θ / day',    'theta', `${fmtUsd(snap.theta / 365)}/d`,   'var(--ink-bright)'],
    ['ν / 1% σ',   'vega',  fmtUsd(snap.vega * 0.01),          'var(--ink-bright)'],
    ['P&L',        'pnl',   fmtUsd(snap.pnl),                  snap.pnl >= 0 ? 'var(--green)' : 'var(--red)'],
  ] : [
    ['Price',      'price', snap.price.toFixed(3),             'var(--ink-bright)'],
    ['Delta Δ',    'delta', snap.delta.toFixed(4),             'var(--ink-bright)'],
    ['Gamma Γ',    'gamma', snap.gamma.toFixed(5),             'var(--ink-bright)'],
    ['Theta/day',  'theta', (snap.theta / 365).toFixed(4),     'var(--ink-bright)'],
    ['Vega ν',     'vega',  snap.vega.toFixed(3),              'var(--ink-bright)'],
    ['P&L',        'pnl',   `${snap.pnl >= 0 ? '+' : ''}${snap.pnl.toFixed(0)}`,
                            snap.pnl >= 0 ? 'var(--green)' : 'var(--red)'],
  ]) : [];

  const labKey = lab ? `${mcTick}-${mcPaths}-${legs.length}-${spot.toFixed(1)}-${sigma.toFixed(3)}` : '';

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: '2rem 1.25rem 3rem' }}>

      <div className="sr-only" role="status" aria-live="polite">{live}</div>

      {/* ── header ──────────────────────────────────────────────────────── */}
      <header style={{ marginBottom: '1.4rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.85rem', flexWrap: 'wrap' }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
            <span aria-hidden="true" style={{
              display: 'inline-grid', placeItems: 'center', width: 30, height: 30,
              borderRadius: 8, fontSize: '.95rem', fontWeight: 800, color: '#1a1408',
              background: 'linear-gradient(135deg, #f7e8c6, var(--gold))',
              boxShadow: '0 2px 10px rgba(201,168,106,0.35)',
            }}>Q</span>
            QuantCore
          </h1>
          <span data-testid="ws-status" role="status"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem',
                         padding: '4px 11px', borderRadius: 999, fontSize: '.72rem',
                         fontWeight: 600, color: statusColor,
                         background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line-strong)' }}>
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%',
                         background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
            {statusText}
          </span>
          <nav style={{ marginLeft: 'auto', display: 'flex', gap: '1.1rem', fontSize: '.82rem' }}>
            <a href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
            <a href="https://gaurangkhurana.ca" target="_blank" rel="noopener noreferrer">Portfolio ↗</a>
          </nav>
        </div>
        <p style={{ marginTop: '.6rem', color: 'var(--muted)', fontSize: '.92rem', maxWidth: 660 }}>
          Real-time options pricing &amp; risk engine — a C++17 Black-Scholes / Monte&nbsp;Carlo core
          with analytic Greeks, GPU-accelerated on Apple&nbsp;Metal and streamed over WebSocket.
        </p>
        {status === 'demo' && (
          <p style={{ marginTop: '.55rem', fontSize: '.78rem', color: 'var(--muted-2)' }}>
            Hosted demo — everything is priced live in your browser with the same math as the C++
            engine, including a real seeded Monte Carlo. Market data are indicative snapshots; the
            native GPU backend runs locally.
          </p>
        )}
      </header>

      {/* ── benchmark strip ─────────────────────────────────────────────── */}
      <ul style={{ listStyle: 'none', display: 'grid',
                   gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                   gap: '.7rem', marginBottom: '1.4rem' }}>
        {BENCH.map(b => (
          <li key={b.k} style={{ padding: '.85rem .95rem', borderRadius: 12,
                background: 'linear-gradient(180deg, rgba(201,168,106,0.06), rgba(201,168,106,0.015))',
                border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.16em',
                          color: 'var(--muted-2)' }}>{b.k}</div>
            <div className="mono" style={{ fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.15,
                          margin: '.15rem 0 .1rem', color: 'var(--gold-bright)' }}>{b.v}</div>
            <div style={{ fontSize: '.68rem', color: 'var(--muted)' }}>{b.s}</div>
          </li>
        ))}
      </ul>

      {/* ── main grid ───────────────────────────────────────────────────── */}
      <div className="qc-grid" style={{ display: 'grid',
             gridTemplateColumns: 'minmax(300px, 0.95fr) minmax(320px, 1.25fr)',
             gap: '1.15rem', alignItems: 'start' }}>

        {/* left column */}
        <div style={{ display: 'grid', gap: '1.15rem' }}>

          {/* market controls */}
          <section>
            <h2>Market Scenario
              <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 600,
                     padding: '2px 8px', borderRadius: 999, letterSpacing: '.08em',
                     color: moneyLabel === 'ITM' ? 'var(--green)'
                          : moneyLabel === 'OTM' ? 'var(--red)' : 'var(--gold)',
                     border: '1px solid var(--line)' }}>{moneyLabel}</span>
            </h2>

            {/* instrument picker */}
            <div role="group" aria-label="Underlying instrument"
                 style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '1rem 0 .2rem' }}>
              {INSTRUMENTS.map(i => (
                <button key={i.sym} className="preset" type="button"
                        aria-pressed={instKey === i.sym}
                        title={`${i.name} — indicative snapshot`}
                        onClick={() => pickInstrument(i.sym)}>{i.sym}</button>
              ))}
            </div>

            {/* scenario presets */}
            <div role="group" aria-label="Market scenarios"
                 style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '.55rem 0 .3rem' }}>
              {SCENARIOS.map(sc => (
                <button key={sc.name} className="preset" type="button"
                        aria-pressed={scen === sc.name}
                        onClick={() => applyScenario(sc)}>{sc.name}</button>
              ))}
            </div>

            <div style={{ display: 'grid', gap: '1.15rem', marginTop: '1rem' }}>
              {[
                { label: 'Spot', sym: 'S', tid: 'spot-input',  val: spot,  set: onSpot,
                  min: inst.min, max: inst.max, step: inst.step,
                  disp: (v: number) => v.toFixed(2),           dtid: 'spot-display' },
                { label: 'Volatility', sym: 'σ', tid: 'vol-input', val: sigma, set: onSigma,
                  min: 0.05, max: 0.50, step: 0.005,
                  disp: (v: number) => (v * 100).toFixed(1) + '%', dtid: 'vol-display' },
                { label: 'Rate', sym: 'r', tid: 'rate-input', val: rate,  set: onRate,
                  min: 0.00, max: 0.10, step: 0.001,
                  disp: (v: number) => (v * 100).toFixed(2) + '%', dtid: 'rate-display' },
              ].map(({ label, sym, tid, val, set, min, max, step, disp, dtid }) => {
                const pct = ((val - min) / (max - min)) * 100;
                return (
                  <label key={tid} style={{ display: 'grid', gap: '.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
                        {label} <span className="mono" style={{ color: 'var(--muted-2)' }}>({sym})</span>
                      </span>
                      <strong data-testid={dtid} className="mono"
                              style={{ fontSize: '.98rem', color: 'var(--ink-bright)' }}>{disp(val)}</strong>
                    </div>
                    <input data-testid={tid} type="range"
                           min={min} max={max} step={step} value={val}
                           aria-label={`${label} (${sym})`} aria-valuetext={disp(val)}
                           onChange={e => set(parseFloat(e.target.value))}
                           style={{ background:
                             `linear-gradient(90deg, var(--gold) 0%, var(--gold) ${pct}%, rgba(201,168,106,0.14) ${pct}%, rgba(201,168,106,0.14) 100%)` }} />
                  </label>
                );
              })}
            </div>
          </section>

          {/* strategy builder */}
          <section>
            <h2>Strategy
              <span style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 400,
                             color: 'var(--muted-2)', letterSpacing: 0, textTransform: 'none' }}>
                {inst.sym} · flat σ across legs
              </span>
            </h2>

            <div role="group" aria-label="Strategy templates"
                 style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '1rem 0 .8rem' }}>
              {STRATEGY_NAMES.map(n => (
                <button key={n} className="preset" type="button"
                        aria-pressed={strat === n}
                        onClick={() => pickStrategy(n)}>{n}</button>
              ))}
            </div>

            <div style={{ display: 'grid', gap: '.45rem' }}>
              {legs.map(l => (
                <div key={l.id} className="leg-row">
                  <button type="button" className={`kind-btn ${l.call ? 'call' : 'put'}`}
                          aria-label={`Leg type: ${l.call ? 'call' : 'put'} — press to flip`}
                          onClick={() => editLeg(l.id, { call: !l.call })}>
                    {l.call ? 'CALL' : 'PUT'}
                  </button>
                  <span className="leg-lbl">K
                    <input className="leg-input" type="number" value={l.K}
                           min={1} step={inst.kstep} aria-label="Strike"
                           onChange={e => editLeg(l.id, { K: parseFloat(e.target.value) })} />
                  </span>
                  <span className="leg-lbl">days
                    <input className="leg-input" type="number" value={Math.round(l.T * 365)}
                           min={1} max={1095} step={1} aria-label="Days to expiry" style={{ width: '3.6em' }}
                           onChange={e => editLeg(l.id, { days: parseFloat(e.target.value) })} />
                  </span>
                  <span className="leg-lbl">qty
                    <input className="leg-input" type="number" value={l.qty}
                           min={-999} max={999} step={1} aria-label="Quantity (negative = short)"
                           style={{ width: '3.6em' }}
                           onChange={e => editLeg(l.id, { qty: parseFloat(e.target.value) })} />
                  </span>
                  <span className="mono" style={{ fontSize: '.68rem', color: 'var(--muted-2)' }}>
                    @{bs(spot, l.K, rate, sigma, l.T, l.call).price.toFixed(2)}
                  </span>
                  {legs.length > 1 && (
                    <button type="button" className="x-btn" aria-label="Remove leg"
                            onClick={() => removeLeg(l.id)}>×</button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.7rem', flexWrap: 'wrap' }}>
              {legs.length < MAX_LEGS && (
                <button type="button" className="preset" onClick={addLeg} aria-pressed={false}>+ Add leg</button>
              )}
              <a href={SAMPLE_CSV} download="portfolio-sample.csv"
                 style={{ fontSize: '.68rem', color: 'var(--muted-2)' }}>sample.csv</a>
            </div>

            {/* CSV / Excel upload (fully client-side) */}
            <div className={`dropzone${drag ? ' drag' : ''}`} role="button" tabIndex={0}
                 aria-label="Upload a CSV or Excel portfolio: type, strike, days, qty per row. Parsed locally in your browser — nothing is uploaded."
                 style={{ marginTop: '.7rem' }}
                 onClick={() => fileRef.current?.click()}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click(); }}
                 onDragOver={e => { e.preventDefault(); setDrag(true); }}
                 onDragLeave={() => setDrag(false)}
                 onDrop={e => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files?.[0]); }}>
              Drop a <strong>CSV or Excel</strong> file here or click —{' '}
              <span className="mono">type,strike,days,qty</span> (qty&lt;0 = short)
            </div>
            <input ref={fileRef} type="file"
                   accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                   className="sr-only"
                   onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            {csvMsg && (
              <p role="status" style={{ marginTop: '.5rem', fontSize: '.7rem',
                    color: csvMsg.startsWith('✓') ? 'var(--green)'
                         : csvMsg.startsWith('…') ? 'var(--muted)' : 'var(--red)' }}>{csvMsg}</p>
            )}
          </section>

          {/* live pricing */}
          <section>
            <h2>Live Pricing
              {snap && (
                <span style={{ marginLeft: 'auto', fontSize: '.62rem', color: 'var(--muted-2)',
                               textTransform: 'none', letterSpacing: 0 }}>
                  {engineMode ? 'C++ engine' : 'in-browser'} ·{' '}
                  <span data-testid="calc-us" className="mono">{snap.calcUs.toFixed(1)}</span> µs
                </span>
              )}
            </h2>
            {snap ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '.55rem',
                              marginTop: '1.05rem' }}>
                  {tiles.map(([lbl, tid, val, color]) => (
                    <div key={tid} aria-label={`${lbl}: ${val}`}
                         style={{ padding: '.65rem .6rem .7rem', borderRadius: 11,
                                  background: 'var(--panel-2)', border: '1px solid var(--line)' }}>
                      <div style={{ fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.09em',
                                    color: 'var(--muted-2)', marginBottom: '.3rem' }}>{lbl}</div>
                      <div data-testid={tid} className="mono" style={{ fontSize: '1.12rem', fontWeight: 650, color }}>
                        <span key={val} className="flash" style={{ color }}>{val}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <p style={{ marginTop: '.75rem', fontSize: '.7rem', color: 'var(--muted-2)' }}>
                  1-day 95% VaR <span style={{ opacity: .8 }}>(δ-Γ parametric at current σ)</span>:{' '}
                  <strong className="mono" style={{ color: 'var(--ink-bright)' }}>
                    ${var95.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </strong>
                </p>
              </>
            ) : (
              <div data-testid="loading" style={{ color: 'var(--muted)', marginTop: '1rem' }}>
                Waiting for pricing data…
              </div>
            )}
          </section>
        </div>

        {/* right column: strategy chart with mode selector */}
        <section style={{ position: 'sticky', top: '1rem' }}>
          <h2>{chartMode === 'P&L' ? 'Strategy P&L' : `Net ${chartMode} vs spot`}
            <span style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 400,
                           color: 'var(--muted-2)', letterSpacing: 0, textTransform: 'none' }}>
              {legs.length} leg{legs.length > 1 ? 's' : ''}
            </span>
          </h2>

          <div role="group" aria-label="Chart mode"
               style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '.8rem 0 .2rem' }}>
            {CHART_MODES.map(m => (
              <button key={m} className="preset" type="button"
                      aria-pressed={chartMode === m}
                      onClick={() => setChartMode(m)}>{m}</button>
            ))}
          </div>

          <div style={{ marginTop: '.7rem' }}>
            <StrategyChart legs={legs} spot={spot} sigma={sigma} rate={rate} inst={inst} mode={chartMode} />
          </div>

          {chartMode === 'P&L' ? (
            <div style={{ display: 'flex', gap: '1.1rem', marginTop: '.4rem', flexWrap: 'wrap',
                          fontSize: '.7rem', color: 'var(--muted)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
                <span style={{ width: 16, height: 2, background: 'var(--gold)', borderRadius: 2 }} /> P&amp;L now
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
                <span style={{ width: 16, height: 0, borderTop: '2px dashed var(--muted-2)' }} /> at expiry
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--gold-bright)' }} /> current spot
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: 'rgba(99,216,145,0.35)' }} /> profit zone
              </span>
            </div>
          ) : (
            <p style={{ marginTop: '.5rem', fontSize: '.7rem', color: 'var(--muted-2)' }}>
              Net portfolio {chartMode === 'Δ' ? 'delta (share-equivalents)'
                : chartMode === 'Γ' ? 'gamma (Δ per $1 move)'
                : chartMode === 'ν' ? 'vega ($ per 1% vol)' : 'theta ($ per day)'} as spot moves —
              the curve every options desk watches.
            </p>
          )}

          <p style={{ marginTop: '.8rem', fontSize: '.68rem', color: 'var(--muted-2)', lineHeight: 1.55 }}>
            Hover to read any spot. Switch modes to see how the Greeks reshape as you edit legs,
            change vol, or move spot — everything re-prices live.
          </p>
        </section>
      </div>

      {/* ── pricing models lab ──────────────────────────────────────────── */}
      <section style={{ marginTop: '1.15rem' }}>
        <h2>Pricing Models Lab
          <span style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 400,
                         color: 'var(--muted-2)', letterSpacing: 0, textTransform: 'none' }}>
            same acceptance gate as the C++ engine — Monte Carlo must converge to closed form
          </span>
        </h2>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', alignItems: 'center',
                      margin: '1rem 0 .9rem' }}>
          <span style={{ fontSize: '.7rem', color: 'var(--muted-2)', marginRight: '.2rem' }}>MC paths:</span>
          {PATH_OPTS.map(p => (
            <button key={p} className="preset" type="button"
                    aria-pressed={mcPaths === p}
                    onClick={() => setMcPaths(p)}>{p >= 1000 ? `${p / 1000}k` : p}</button>
          ))}
          <button className="preset" type="button" aria-pressed={false}
                  onClick={() => setMcTick(t => t + 1)}
                  title="Draw a fresh random sample">↻ Re-run</button>
        </div>

        {lab ? (
          <>
            {/* model comparison */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                          gap: '.6rem' }}>
              {([
                ['Black-Scholes', 'closed form — the reference', fmtUsdPrec(lab.bsV),
                 `${lab.msBs < 0.05 ? '<0.1' : lab.msBs.toFixed(1)} ms`],
                [`Binomial CRR`, `${BIN_STEPS}-step lattice`, fmtUsdPrec(lab.binV),
                 `${lab.msBin.toFixed(1)} ms`],
                ['Monte Carlo', `${(lab.paths / 1000).toFixed(0)}k paths, seeded GBM`,
                 `${fmtUsdPrec(lab.mcV)} ± ${lab.se.toFixed(0)}`,
                 `${lab.msMc.toFixed(1)} ms`],
              ] as [string, string, string, string][]).map(([name, sub, val, ms]) => (
                <div key={name} style={{ padding: '.8rem .9rem', borderRadius: 11,
                       background: 'var(--panel-2)', border: '1px solid var(--line)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: '.72rem', fontWeight: 600, color: 'var(--muted)' }}>{name}</span>
                    <span className="mono" style={{ fontSize: '.62rem', color: 'var(--muted-2)' }}>{ms}</span>
                  </div>
                  <div className="mono" style={{ fontSize: '1.25rem', fontWeight: 700,
                        margin: '.25rem 0 .1rem', color: 'var(--ink-bright)' }}>{val}</div>
                  <div style={{ fontSize: '.64rem', color: 'var(--muted-2)' }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* convergence verdict */}
            <p role="status" style={{ marginTop: '.7rem', fontSize: '.74rem',
                  color: lab.z <= 2 ? 'var(--green)' : 'var(--red)' }}>
              {lab.z <= 2
                ? `✓ Monte Carlo within ${lab.z.toFixed(1)}σ of closed form (|MC − BS| = $${Math.abs(lab.mcV - lab.bsV).toFixed(0)}, SE = $${lab.se.toFixed(0)}) — converged.`
                : `△ ${lab.z.toFixed(1)}σ from closed form this draw — a ~5% statistical tail; hit Re-run or raise the path count.`}
              <span style={{ color: 'var(--muted-2)' }}>
                {' '}Increase paths and watch the error shrink at the 1/√N rate — the exact Phase-1 gate the C++ engine passes.
              </span>
            </p>

            {/* paths + histogram */}
            <div className="lab-grid" style={{ display: 'grid',
                   gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
              <div>
                <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.14em',
                              color: 'var(--muted-2)', marginBottom: '.4rem' }}>
                  Sample GBM paths ({lab.viz.paths.length} of {(lab.paths / 1000).toFixed(0)}k)
                </div>
                <McPathsChart viz={lab.viz} animKey={labKey} />
              </div>
              <div>
                <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.14em',
                              color: 'var(--muted-2)', marginBottom: '.4rem' }}>
                  Terminal price distribution{lab.viz.K != null ? ' · ITM region green' : ''}
                </div>
                <McHistChart viz={lab.viz} animKey={labKey} />
              </div>
            </div>
          </>
        ) : (
          <div style={{ color: 'var(--muted)', fontSize: '.8rem' }}>Running first simulation…</div>
        )}
      </section>

      {/* ── P&L surface ─────────────────────────────────────────────────── */}
      {surface && (
        <section style={{ marginTop: '1.15rem' }}>
          <h2>P&amp;L Surface
            <span style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 400,
                           color: 'var(--muted-2)', letterSpacing: 0, textTransform: 'none' }}>
              δ-Γ-ν approximation · rows = spot shock · cols = vol shock
            </span>
          </h2>
          <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
            <table data-testid="pnl-surface" className="mono"
                   style={{ borderCollapse: 'separate', borderSpacing: 4, width: '100%',
                            fontSize: '.8rem', minWidth: 440 }}>
              <thead>
                <tr>
                  <th style={TH}><span style={{ color: 'var(--muted-2)' }}>ΔS \ Δσ</span></th>
                  {VOL_SHOCKS.map(v => (
                    <th key={v} style={TH}>{v >= 0 ? '+' : ''}{(v * 100).toFixed(0)}%</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SPOT_SHOCKS.map((ds, ri) => (
                  <tr key={ds}>
                    <th scope="row" style={TH}>{ds >= 0 ? '+' : ''}{(ds * 100).toFixed(0)}%</th>
                    {VOL_SHOCKS.map((dv, ci) => {
                      const v = surface[ri][ci];
                      const mag = Math.min(Math.abs(v) / surfMax, 1);
                      const a = 0.06 + mag * 0.66;
                      const bg = v >= 0 ? `rgba(99,216,145,${a})` : `rgba(244,122,128,${a})`;
                      const isCenter = ds === 0 && dv === 0;
                      return (
                        <td key={ci} data-testid={`pnl-${ri}-${ci}`}
                            title={`Spot ${ds >= 0 ? '+' : ''}${(ds * 100).toFixed(0)}%, Vol ${dv >= 0 ? '+' : ''}${(dv * 100).toFixed(0)}%  →  ${v >= 0 ? '+' : ''}$${v.toFixed(0)}`}
                            style={{ ...TD, background: bg,
                                     color: mag > 0.42 ? '#0a0806' : 'var(--ink)',
                                     fontWeight: mag > 0.42 ? 700 : 500,
                                     boxShadow: isCenter ? 'inset 0 0 0 1.5px var(--gold-bright)' : 'none' }}>
                          {v >= 0 ? '+' : ''}{v.toFixed(0)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', marginTop: '.9rem',
                        fontSize: '.68rem', color: 'var(--muted-2)' }}>
            <span>loss</span>
            <span aria-hidden="true" style={{ flex: 1, maxWidth: 200, height: 7, borderRadius: 999,
                   background: 'linear-gradient(90deg, var(--red-deep), rgba(120,110,95,0.25), var(--green-deep))' }} />
            <span>gain</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3,
                     boxShadow: 'inset 0 0 0 1.5px var(--gold-bright)' }} /> current
            </span>
          </div>
        </section>
      )}

      {/* ── footer ──────────────────────────────────────────────────────── */}
      <footer style={{ marginTop: '1.6rem', textAlign: 'center', fontSize: '.72rem', color: 'var(--muted-2)' }}>
        C++17 · pybind11 · Apple Metal · FastAPI · Next.js —{' '}
        <a href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">source on GitHub</a>
      </footer>

      <style>{`
        @media (max-width: 720px) {
          .qc-grid  { grid-template-columns: 1fr !important; }
          .lab-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </main>
  );
}

const TH: React.CSSProperties = {
  padding: '6px 8px', color: 'var(--muted)', textAlign: 'center', fontWeight: 600, fontSize: '.72rem',
};
const TD: React.CSSProperties = {
  padding: '9px 8px', textAlign: 'right', borderRadius: 7, transition: 'background .18s ease',
};
