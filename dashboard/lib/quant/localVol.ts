// Dupire local volatility implied by the arbitrage-free SSVI surface (smile × ATM term structure),
// and a Monte Carlo that simulates it.
//
// In total implied variance w(k, T) at log-forward moneyness k = ln(K/F_T) (Gatheral, The Volatility
// Surface, eq. 1.10; deterministic rates and dividends):
//
//   σ_loc²(K, T) = ∂T w(k, T) / g(k, T)
//
// with ∂T taken at fixed k, and g Durrleman's function — positive exactly where the smile is free of
// butterfly arbitrage. For SSVI the smile parameters do not depend on T, so
//
//   ∂T w = ∂θ w · θ′(T),   ∂θ w = w/θ + (θ/2)·k·(ρ + (φk + ρ)/R)·φ′(θ),   φ′/φ = −γ/θ + (γ − 1)/(1 + θ)
//
// where R = √((φk + ρ)² + 1 − ρ²). Without a smile w = θ and g = 1, so σ_loc² = θ′(T): the forward
// variance of the term structure, and σ² when flat. A local-volatility process reprices every vanilla on
// the surface it was built from (Dupire, 1994); the tests check this with the Monte Carlo below.

import { normalSampler } from './rng';
import type { Leg, Market, TermStructure } from './types';
import { CONTRACT_MULT as M, signedQty } from './types';
import { atmVariance, hasVolSurface, MAX_SIGMA, phi, ssvi, TERM_PIVOT_T } from './volSurface';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Local volatility at t = 0 is its limit as t → 0; one hour stands in for it. */
const MIN_T = 1 / (365 * 24);
const G_FLOOR = 1e-10;
const MAX_VAR = MAX_SIGMA * MAX_SIGMA;

/** dW/dT of the term structure's normalised total variance (right derivative at listed expiries). */
export function termSlope(t: TermStructure, T: number): number {
  if (t.kind === 'curve') {
    const kappa = Math.LN2 / t.halfLife, c = t.ratio * t.ratio - 1;
    const A = (x: number) => x - (c * Math.expm1(-kappa * x)) / kappa;
    return (TERM_PIVOT_T * (1 + c * Math.exp(-kappa * T))) / A(TERM_PIVOT_T);
  }
  const { T: ts, w } = t, n = ts.length;
  if (T < ts[0]) return w[0] / ts[0];
  if (T >= ts[n - 1]) return w[n - 1] / ts[n - 1];
  let i = 1;
  while (ts[i] <= T) i++;
  return (w[i] - w[i - 1]) / (ts[i] - ts[i - 1]);
}

/** θ′(T): the forward variance of the ATM term structure. */
export const atmForwardVariance = (m: Market, T: number): number =>
  m.sigma * m.sigma * (m.term ? termSlope(m.term, T) : 1);

/** Per-time constants of the local-volatility function: everything that does not depend on the spot. */
interface Slice {
  theta: number; dTheta: number;   // ATM total variance and its maturity derivative
  p: number; dp: number;           // φ(θ) and φ′(θ)
  lnFs: number; lnFa: number;      // log forward of the smile's centre and of today's spot
}

function slice(m: Market, t: number): Slice {
  const T = Math.max(t, MIN_T);
  const theta = atmVariance(m, T);
  const s = m.smile;
  const p = s ? phi(theta, s) : 0;
  const carry = (m.r - m.q) * T;
  return {
    theta, dTheta: atmForwardVariance(m, T), p,
    dp: s ? p * (-s.gamma / theta + (s.gamma - 1) / (1 + theta)) : 0,
    lnFs: Math.log(m.smileSpot ?? m.S) + carry, lnFa: Math.log(m.S) + carry,
  };
}

/**
 * σ_loc² at log spot x from one time slice's constants, in plain numbers so the simulation loops can read them from
 * typed arrays. k is moneyness on the smile (whose centre may be a pre-scenario spot), kAct against the underlying's
 * own forward.
 */
function lvar(rho: number, th: number, dTheta: number, p: number, dp: number, lnFs: number, lnFa: number, x: number): number {
  const k = x - lnFs, kAct = x - lnFa;
  const y = p * k + rho;
  const R = Math.sqrt(y * y + 1 - rho * rho);
  const half = th / 2;
  const w = half * (1 + rho * p * k + R);
  const dw = half * (rho * p + (p * y) / R);
  const d2w = half * (p * p * (1 - rho * rho)) / (R * R * R);
  const dwdTheta = w / th + half * k * (rho + y / R) * dp;
  const a = 1 - (kAct * dw) / (2 * w);
  const g = a * a - ((dw * dw) / 4) * (1 / w + 0.25) + d2w / 2;
  const v = (dwdTheta * dTheta) / (g > G_FLOOR ? g : G_FLOOR);
  return v < MAX_VAR ? (v > 0 ? v : v <= 0 ? 0 : MAX_VAR) : MAX_VAR;   // NaN → the cap
}

/** σ_loc² at log spot x for one time slice; the market must carry a smile. */
const localVariance = (m: Market, c: Slice, x: number): number =>
  lvar(m.smile!.rho, c.theta, c.dTheta, c.p, c.dp, c.lnFs, c.lnFa, x);

/** Dupire local volatility at spot S and time t implied by the market's surface; σ when flat. */
export function localVol(m: Market, S: number, t: number): number {
  if (!hasVolSurface(m)) return m.sigma;
  const c = slice(m, t);
  const v = m.smile ? localVariance(m, c, Math.log(S)) : Math.min(c.dTheta, MAX_VAR);
  return Math.sqrt(v);
}

/** Simulation times: every leg expiry, with at most 1/stepsPerYear between consecutive times. */
export function timeGrid(expiries: number[], stepsPerYear: number): number[] {
  const out = [0];
  for (const T of Array.from(new Set(expiries.filter(e => e > 0))).sort((a, b) => a - b)) {
    const prev = out[out.length - 1];
    const n = Math.max(1, Math.ceil((T - prev) * stepsPerYear - 1e-9));
    for (let i = 1; i < n; i++) out.push(prev + ((T - prev) * i) / n);
    out.push(T);
  }
  return out;
}

export interface LocalVolMcResult { price: number; se: number; paths: number; steps: number; ms: number; }

/**
 * Monte Carlo value of a European portfolio under the market's local volatility: log-Euler steps with σ_loc read
 * at the step's start price and mid-time, whose weak error falls as O(Δt). Without a smile the local volatility
 * depends on time only and each step's variance is integrated exactly, so the simulation has no discretisation bias.
 *
 * Measured on a random surface (400k paths): at 52 steps a year the bias reached 7.7% of the price of a call 1.5
 * standard deviations out of the money at three months; at 365 steps a year it fell to about 1% (within 1.7 standard
 * errors). A (i/n)² grid refined towards t = 0 did not reduce it, and a predictor–corrector that reuses the step's
 * draw to pick the variance is biased by construction (the variance becomes correlated with the shock).
 */
export function mcLocalVol(legs: Leg[], m: Market, nPaths: number, seed: number, stepsPerYear = 365): LocalVolMcResult {
  const t0 = now();
  const times = timeGrid(legs.map(l => l.T), stepsPerYear);
  const nSteps = times.length - 1;
  const payAt = new Map<number, number>(times.map((t, i) => [t, i]));
  const legStep = legs.map(l => (l.T > 0 ? payAt.get(l.T)! : 0));
  const weight = legs.map(l => Math.exp(-m.r * Math.max(0, l.T)) * signedQty(l) * M);
  const dt = new Float64Array(nSteps), sqdt = new Float64Array(nSteps);
  // each step's slice constants, at mid-time, in typed arrays for the inner loop
  const TH = new Float64Array(nSteps), DTH = new Float64Array(nSteps), P = new Float64Array(nSteps);
  const DP = new Float64Array(nSteps), LFS = new Float64Array(nSteps), LFA = new Float64Array(nSteps);
  const varInc = new Float64Array(nSteps);   // exact integrated variance when there is no smile
  for (let i = 0; i < nSteps; i++) {
    dt[i] = times[i + 1] - times[i];
    sqdt[i] = Math.sqrt(dt[i]);
    const c = slice(m, 0.5 * (times[i] + times[i + 1]));
    TH[i] = c.theta; DTH[i] = c.dTheta; P[i] = c.p; DP[i] = c.dp; LFS[i] = c.lnFs; LFA[i] = c.lnFa;
    varInc[i] = Math.max(hasVolSurface(m) ? atmVariance(m, times[i + 1]) - atmVariance(m, times[i]) : m.sigma * m.sigma * dt[i], 0);
  }
  const smile = !!m.smile;
  const rho = m.smile?.rho ?? 0;
  const carry = m.r - m.q;
  const next = normalSampler(seed);
  const xAt = new Float64Array(nSteps + 1);
  const x0 = Math.log(m.S);
  let sum = 0, sumSq = 0;

  for (let n = 0; n < nPaths; n++) {
    let x = x0;
    xAt[0] = x;
    if (smile) {
      for (let i = 0; i < nSteps; i++) {
        const z = next();
        const v = lvar(rho, TH[i], DTH[i], P[i], DP[i], LFS[i], LFA[i], x);
        x += (carry - 0.5 * v) * dt[i] + Math.sqrt(v) * sqdt[i] * z;
        xAt[i + 1] = x;
      }
    } else {
      for (let i = 0; i < nSteps; i++) {
        const z = next();
        x += carry * dt[i] - 0.5 * varInc[i] + Math.sqrt(varInc[i]) * z;
        xAt[i + 1] = x;
      }
    }
    let pv = 0;
    for (let j = 0; j < legs.length; j++) {
      const l = legs[j], s = Math.exp(xAt[legStep[j]]);
      pv += weight[j] * (l.call ? Math.max(s - l.K, 0) : Math.max(l.K - s, 0));
    }
    sum += pv;
    sumSq += pv * pv;
  }
  const mean = sum / nPaths;
  return { price: mean, se: Math.sqrt(Math.max(sumSq / nPaths - mean * mean, 0) / nPaths), paths: nPaths, steps: nSteps, ms: now() - t0 };
}

/** Local-volatility price paths for display (nSteps + 1 points each, evenly spaced to T). */
export function sampleLocalVolPaths(m: Market, T: number, nPaths: number, nSteps: number, seed: number): number[][] {
  const next = normalSampler(seed);
  const h = Math.max(T, 0) / nSteps;
  const slices = Array.from({ length: nSteps }, (_, i) => slice(m, (i + 0.5) * h));
  const varInc = Array.from({ length: nSteps }, (_, i) => atmVariance(m, (i + 1) * h) - atmVariance(m, i * h));
  const carry = (m.r - m.q) * h, sq = Math.sqrt(h);
  const paths: number[][] = [];
  for (let p = 0; p < nPaths; p++) {
    let x = Math.log(m.S);
    const path = [m.S];
    for (let i = 0; i < nSteps; i++) {
      const z = next();
      if (m.smile) {
        const v = localVariance(m, slices[i], x);
        x += carry - 0.5 * v * h + Math.sqrt(v) * sq * z;
      } else {
        const dv = Math.max(varInc[i], 0);
        x += carry - 0.5 * dv + Math.sqrt(dv) * z;
      }
      path.push(Math.exp(x));
    }
    paths.push(path);
  }
  return paths;
}

export { ssvi };
