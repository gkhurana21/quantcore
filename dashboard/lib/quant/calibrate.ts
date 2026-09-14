// Fit the SSVI smile to one expiry of a listed option chain.
//
// The smile's information sits in out-of-the-money quotes — puts below the forward, calls
// above — so those are the ones used; in-the-money quotes repeat them through put-call
// parity with wider spreads. For a single expiry SSVI depends only on θ (ATM total
// variance), ρ and φ(θ). The fit minimises squared implied-volatility errors over those
// three with a bounded Nelder–Mead search, then writes φ as η for the app's power-law form
// with γ held fixed. The search stays inside the same arbitrage-free region as the sliders
// (|ρ| ≤ 0.95, 0.05 ≤ η ≤ 2 / (1 + |ρ|)); when the data would push past it, the fit lands on
// the boundary and says so.

import type { LiveChainOption } from '../market/marketData';
import type { Market, Smile, TermStructure } from './types';
import { atmVol, fittedTerm, legSigma, SMILE_LIMITS, ssvi } from './volSurface';

export interface SmileQuote { K: number; iv: number; call: boolean; }
export interface CalibrationPoint { K: number; k: number; call: boolean; ivMarket: number; ivModel: number; }

export interface Calibration {
  sigma: number;          // fitted at-the-money-forward volatility for this expiry
  smile: Smile;
  T: number;
  forward: number;
  points: CalibrationPoint[];
  rmseVolPts: number;     // root-mean-square implied-vol error, in vol points
  maxErrVolPts: number;
  atLimit: boolean;       // the best fit sits on the arbitrage-free boundary
}

export const MIN_QUOTES = 5;
const RHO_MAX = SMILE_LIMITS.rho[1];
const [ETA_MIN, ETA_MAX] = SMILE_LIMITS.eta;

/** Out-of-the-money quotes with a usable implied volatility: at most one per strike. */
export function otmQuotes(chain: LiveChainOption[], forward: number, atmIv = 0): SmileQuote[] {
  const byStrike = new Map<number, SmileQuote>();
  for (const o of chain) {
    const call = o.type === 'call';
    if (!(o.strike > 0) || call !== o.strike >= forward) continue;          // out of the money only
    if (!(typeof o.iv === 'number' && Number.isFinite(o.iv) && o.iv > 0.005 && o.iv < 5)) continue;
    if (!(o.bid > 0 || o.last > 0)) continue;                                // no quote, no information
    if (atmIv > 0 && (o.iv > atmIv * 2.5 || o.iv < atmIv * 0.25)) continue;  // a cent of noise in the far wings
    byStrike.set(o.strike, { K: o.strike, iv: o.iv, call });
  }
  return Array.from(byStrike.values()).sort((a, b) => a.K - b.K);
}

/** Implied volatility of the out-of-the-money quote nearest the forward: the reference level for otmQuotes' band. */
export function atmReferenceIv(chain: LiveChainOption[], forward: number): number {
  let iv = 0, dist = Infinity;
  for (const o of chain) {
    if ((o.type === 'call') !== o.strike >= forward || !(o.bid > 0 || o.last > 0)) continue;
    if (!(typeof o.iv === 'number' && Number.isFinite(o.iv) && o.iv > 0.005 && o.iv < 5)) continue;
    const d = Math.abs(o.strike - forward);
    if (d < dist) { dist = d; iv = o.iv; }
  }
  return iv;
}

/** Years from now to 4 pm New York (21:00 UTC) on a YYYY-MM-DD expiration, at least one day. */
export function yearsToExpiry(date: string, now = Date.now()): number {
  const days = Math.max(1, Math.round((Date.parse(`${date}T21:00:00Z`) - now) / 86_400_000));
  return days / 365;
}

type Vec = number[];

function nelderMead(f: (x: Vec) => number, x0: Vec, step: Vec, maxIter = 1500, tol = 1e-12): { x: Vec; fx: number } {
  const n = x0.length;
  let pts: Vec[] = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[j] : v)))];
  let vals = pts.map(f);
  for (let it = 0; it < maxIter; it++) {
    const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map(i => pts[i]);
    vals = order.map(i => vals[i]);
    if (vals[n] - vals[0] <= 1e-16 + tol * vals[0]) break;
    const c = Array.from({ length: n }, (_, j) => pts.slice(0, n).reduce((a, p) => a + p[j], 0) / n);
    const along = (t: number) => c.map((cj, j) => cj + t * (pts[n][j] - cj));
    const xr = along(-1), fr = f(xr);
    if (fr < vals[0]) {
      const xe = along(-2), fe = f(xe);
      [pts[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < vals[n - 1]) {
      [pts[n], vals[n]] = [xr, fr];
    } else {
      const xc = along(fr < vals[n] ? -0.5 : 0.5), fc = f(xc);
      if (fc < Math.min(fr, vals[n])) {
        [pts[n], vals[n]] = [xc, fc];
      } else {
        for (let i = 1; i <= n; i++) {
          pts[i] = pts[i].map((v, j) => pts[0][j] + 0.5 * (v - pts[0][j]));
          vals[i] = f(pts[i]);
        }
      }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return { x: pts[best], fx: vals[best] };
}

/**
 * Fit θ, ρ and φ to the quotes, reported as an ATM volatility and a Smile with the given γ.
 * Returns null without enough quotes or a positive time to expiry.
 */
export function calibrateSmile(quotes: SmileQuote[], S: number, r: number, q: number, T: number,
                               gamma = 0.45): Calibration | null {
  if (!(T > 0) || !(S > 0)) return null;
  const g = Math.min(SMILE_LIMITS.gamma[1], Math.max(SMILE_LIMITS.gamma[0], gamma));
  const forward = S * Math.exp((r - q) * T);
  const data = quotes.filter(p => p.K > 0 && Number.isFinite(p.iv) && p.iv > 0)
                     .map(p => ({ K: p.K, call: p.call, k: Math.log(p.K / forward), iv: p.iv }));
  if (data.length < MIN_QUOTES) return null;

  // φ = η·c(θ): η's bounds become φ's bounds for a given θ and ρ
  const c = (theta: number) => Math.pow(theta, -g) * Math.pow(1 + theta, g - 1);
  const decode = (x: Vec) => {
    const theta = Math.exp(x[0]);
    const rho = RHO_MAX * Math.tanh(x[1]);
    const etaHi = Math.min(ETA_MAX, 2 / (1 + Math.abs(rho)));
    const u = 1 / (1 + Math.exp(-x[2]));
    return { theta, rho, eta: ETA_MIN + (etaHi - ETA_MIN) * u, u };
  };
  const model = (p: ReturnType<typeof decode>, k: number) =>
    Math.sqrt(ssvi(k, p.theta, { rho: p.rho, eta: p.eta, gamma: g }).w / T);
  const loss = (x: Vec) => {
    const p = decode(x);
    let s = 0;
    for (const d of data) { const e = model(p, d.k) - d.iv; s += e * e; }
    return Number.isFinite(s) ? s : 1e9;
  };

  // start at the quote nearest the money; several skews and curvatures guard against local minima
  const atm = data.reduce((a, d) => (Math.abs(d.k) < Math.abs(a.k) ? d : a));
  const theta0 = Math.log(atm.iv * atm.iv * T);
  let best = { x: [theta0, 0, 0], fx: Infinity };
  for (const rho0 of [-0.6, -0.2, 0.3]) for (const u0 of [-1.5, 0, 1.5]) {
    const run = nelderMead(loss, [theta0, Math.atanh(rho0 / RHO_MAX), u0], [0.2, 0.3, 0.8]);
    if (run.fx < best.fx) best = run;
  }
  best = nelderMead(loss, best.x, [0.05, 0.1, 0.3]);   // restart from the best point to finish converging

  const p = decode(best.x);
  const points = data.map(d => ({ K: d.K, k: d.k, call: d.call, ivMarket: d.iv, ivModel: model(p, d.k) }));
  const errs = points.map(pt => (pt.ivModel - pt.ivMarket) * 100);
  return {
    sigma: Math.sqrt(p.theta / T),
    smile: { rho: p.rho, eta: p.eta, gamma: g },
    T, forward, points,
    rmseVolPts: Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length),
    maxErrVolPts: Math.max(...errs.map(Math.abs)),
    atLimit: p.u > 0.999 || Math.abs(p.rho) > RHO_MAX * 0.999,
  };
}

// ── The whole surface: several expiries at once ────────────────────────────
//
// One skew ρ, curvature η and decay γ shared by every expiry (the SSVI surface), and one ATM
// total variance θᵢ per expiry. For a given (ρ, η, γ) each θᵢ is a one-dimensional least-squares
// problem, solved by golden-section search on ln θ; the outer three parameters use the bounded
// Nelder–Mead search above, from several starts. Total variance must not fall with maturity — a
// calendar spread would then have a negative price — so adjacent expiries that break that are
// pooled to one θ fitted to all their quotes (pool-adjacent-violators on the actual loss). The θᵢ
// become a fitted term structure: the app prices every listed expiry at exactly these volatilities
// and interpolates total variance linearly in maturity between them.

export interface SurfaceSliceInput { expiry: string; T: number; quotes: SmileQuote[]; }

export interface SurfaceSlice {
  expiry: string;
  T: number;
  forward: number;
  atmVol: number;               // fitted at-the-money-forward volatility at this expiry
  marketAtmVol: number | null;  // market implied vol interpolated to the forward, when quotes straddle it
  points: CalibrationPoint[];
  rmseVolPts: number;
}

export interface SurfaceCalibration {
  sigma: number;                // 30-day ATM volatility (σ of the fitted market)
  smile: Smile;
  term: TermStructure | null;   // null when only one expiry had enough quotes: that slice's ATM vol everywhere
  slices: SurfaceSlice[];
  quotes: number;
  rmseVolPts: number;
  maxErrVolPts: number;
  atLimit: boolean;             // the best fit sits on the arbitrage-free boundary
  pooled: boolean;              // market ATM variance fell with maturity somewhere; those expiries share one θ
}

interface Prepared {
  expiry: string; T: number; forward: number; theta0: number;
  data: { K: number; call: boolean; k: number; iv: number }[];
  k: Float64Array; iv: Float64Array;
}

const [GAMMA_MIN, GAMMA_MAX] = SMILE_LIMITS.gamma;
const THETA_SPAN = Math.log(6);   // each θ is searched within a factor of 6 of its nearest-the-money quote

function goldenMin(f: (y: number) => number, a: number, b: number, iters = 34): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return fc < fd ? c : d;
}

/** Σ (model IV − market IV)² over one expiry's quotes at ATM total variance θ. */
function sliceLoss(s: Prepared, theta: number, rho: number, eta: number, gamma: number): number {
  const p = eta / (Math.pow(theta, gamma) * Math.pow(1 + theta, 1 - gamma));
  const c = 1 - rho * rho, scale = theta / (2 * s.T);
  let sum = 0;
  for (let j = 0; j < s.k.length; j++) {
    const pk = p * s.k[j], x = pk + rho;
    const e = Math.sqrt(scale * (1 + rho * pk + Math.sqrt(x * x + c))) - s.iv[j];
    sum += e * e;
  }
  return sum;
}

/** Best non-decreasing θᵢ for a given (ρ, η, γ), and the loss there. */
function profileThetas(slices: Prepared[], rho: number, eta: number, gamma: number) {
  const fit = (members: Prepared[]) => {
    let lo = Infinity, hi = -Infinity;
    for (const m of members) { lo = Math.min(lo, Math.log(m.theta0)); hi = Math.max(hi, Math.log(m.theta0)); }
    const f = (y: number) => {
      const th = Math.exp(y);
      let s = 0;
      for (const m of members) s += sliceLoss(m, th, rho, eta, gamma);
      return s;
    };
    const y = goldenMin(f, lo - THETA_SPAN, hi + THETA_SPAN);
    return { theta: Math.exp(y), loss: f(y) };
  };
  const blocks: { members: Prepared[]; theta: number; loss: number }[] = [];
  let pooled = false;
  for (const s of slices) {
    blocks.push({ members: [s], ...fit([s]) });
    while (blocks.length > 1 && blocks[blocks.length - 2].theta > blocks[blocks.length - 1].theta) {
      const b2 = blocks.pop()!, b1 = blocks.pop()!;
      const members = [...b1.members, ...b2.members];
      blocks.push({ members, ...fit(members) });
      pooled = true;
    }
  }
  const theta: number[] = [];
  let loss = 0;
  for (const b of blocks) {
    loss += b.loss;
    for (let i = 0; i < b.members.length; i++) theta.push(b.theta);
  }
  return { theta, loss, pooled };
}

/** Market implied vol linearly interpolated to the forward (k = 0) from the quotes either side of it. */
function ivAtForward(data: Prepared['data']): number | null {
  let below: Prepared['data'][number] | null = null, above: Prepared['data'][number] | null = null;
  for (const d of data) {
    if (d.k < 0 && (!below || d.k > below.k)) below = d;
    if (d.k >= 0 && (!above || d.k < above.k)) above = d;
  }
  if (!below || !above) return null;
  return below.iv + ((0 - below.k) / (above.k - below.k)) * (above.iv - below.iv);
}

function summarise(slices: SurfaceSlice[]) {
  const errs = slices.flatMap(s => s.points.map(p => (p.ivModel - p.ivMarket) * 100));
  return {
    quotes: errs.length,
    rmseVolPts: Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length),
    maxErrVolPts: Math.max(...errs.map(Math.abs)),
  };
}

const sliceRmse = (points: CalibrationPoint[]) =>
  Math.sqrt(points.reduce((a, p) => a + ((p.ivModel - p.ivMarket) * 100) ** 2, 0) / points.length);

/**
 * Fit an arbitrage-free SSVI surface to several expiries' out-of-the-money quotes. Expiries with fewer than
 * MIN_QUOTES usable quotes are left out; with one left this is calibrateSmile at γ = ½ and no term structure.
 * Returns null when no expiry can be fitted.
 */
export function calibrateSurface(input: SurfaceSliceInput[], S: number, r: number, q: number): SurfaceCalibration | null {
  if (!(S > 0)) return null;
  const byT = new Map<number, Prepared>();
  for (const s of input) {
    if (!(s.T > 0)) continue;
    const forward = S * Math.exp((r - q) * s.T);
    const data = s.quotes.filter(p => p.K > 0 && Number.isFinite(p.iv) && p.iv > 0)
                         .map(p => ({ K: p.K, call: p.call, k: Math.log(p.K / forward), iv: p.iv }));
    if (data.length < MIN_QUOTES) continue;
    const atm = data.reduce((a, d) => (Math.abs(d.k) < Math.abs(a.k) ? d : a));
    const prev = byT.get(s.T);
    if (prev && prev.data.length >= data.length) continue;   // one slice per maturity: the better quoted
    byT.set(s.T, { expiry: s.expiry, T: s.T, forward, theta0: atm.iv * atm.iv * s.T, data,
                   k: Float64Array.from(data, d => d.k), iv: Float64Array.from(data, d => d.iv) });
  }
  const slices = Array.from(byT.values()).sort((a, b) => a.T - b.T);
  if (!slices.length) return null;

  if (slices.length === 1) {
    const s = slices[0];
    const cal = calibrateSmile(s.data, S, r, q, s.T, GAMMA_MAX)!;
    const out: SurfaceSlice[] = [{ expiry: s.expiry, T: s.T, forward: s.forward, atmVol: cal.sigma,
                                   marketAtmVol: ivAtForward(s.data), points: cal.points, rmseVolPts: cal.rmseVolPts }];
    return { sigma: cal.sigma, smile: cal.smile, term: null, slices: out, ...summarise(out), atLimit: cal.atLimit, pooled: false };
  }

  const decode = (x: Vec) => {
    const rho = RHO_MAX * Math.tanh(x[0]);
    const etaHi = Math.min(ETA_MAX, 2 / (1 + Math.abs(rho)));
    const u = 1 / (1 + Math.exp(-x[1])), v = 1 / (1 + Math.exp(-x[2]));
    return { rho, eta: ETA_MIN + (etaHi - ETA_MIN) * u, gamma: GAMMA_MIN + (GAMMA_MAX - GAMMA_MIN) * v, u, v };
  };
  const loss = (x: Vec) => {
    const p = decode(x);
    const l = profileThetas(slices, p.rho, p.eta, p.gamma).loss;
    return Number.isFinite(l) ? l : 1e9;
  };
  let best = { x: [0, 0, 0], fx: Infinity };
  for (const rho0 of [-0.6, -0.2, 0.3]) for (const u0 of [-1.5, 0, 1.5]) {
    const run = nelderMead(loss, [Math.atanh(rho0 / RHO_MAX), u0, 1], [0.3, 0.8, 0.8], 250, 1e-9);
    if (run.fx < best.fx) best = run;
  }
  best = nelderMead(loss, best.x, [0.1, 0.3, 0.3], 600, 1e-12);   // restart from the best point to finish converging

  const p = decode(best.x);
  const prof = profileThetas(slices, p.rho, p.eta, p.gamma);
  const fitted = fittedTerm(slices.map(s => s.T), prof.theta);
  if (!fitted) return null;
  const smile: Smile = { rho: p.rho, eta: p.eta, gamma: p.gamma };
  // report exactly what the app will price: the fitted market through legSigma
  const market: Market = { S, sigma: fitted.sigma, r, q, smile, term: fitted.term };
  const out = slices.map(s => {
    const points = s.data.map(d => ({ K: d.K, k: d.k, call: d.call, ivMarket: d.iv, ivModel: legSigma(market, d.K, s.T) }));
    return { expiry: s.expiry, T: s.T, forward: s.forward, atmVol: atmVol(market, s.T), marketAtmVol: ivAtForward(s.data),
             points, rmseVolPts: sliceRmse(points) };
  });
  return {
    sigma: fitted.sigma, smile, term: fitted.term, slices: out, ...summarise(out),
    atLimit: p.u > 0.999 || Math.abs(p.rho) > RHO_MAX * 0.999 || p.v > 0.999,
    pooled: prof.pooled,
  };
}
