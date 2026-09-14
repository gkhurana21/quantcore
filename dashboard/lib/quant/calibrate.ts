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
import type { Smile } from './types';
import { SMILE_LIMITS, ssvi } from './volSurface';

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

/** Years from now to 4 pm New York (21:00 UTC) on a YYYY-MM-DD expiration, at least one day. */
export function yearsToExpiry(date: string, now = Date.now()): number {
  const days = Math.max(1, Math.round((Date.parse(`${date}T21:00:00Z`) - now) / 86_400_000));
  return days / 365;
}

type Vec = number[];

function nelderMead(f: (x: Vec) => number, x0: Vec, step: Vec, maxIter = 1500): { x: Vec; fx: number } {
  const n = x0.length;
  let pts: Vec[] = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step[j] : v)))];
  let vals = pts.map(f);
  for (let it = 0; it < maxIter; it++) {
    const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map(i => pts[i]);
    vals = order.map(i => vals[i]);
    if (vals[n] - vals[0] <= 1e-16 + 1e-12 * vals[0]) break;
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
