import { normalSampler } from './rng';
import type { Leg, Market } from './types';
import { CONTRACT_MULT as M, signedQty } from './types';
import { legSigma } from './volSurface';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface McCheckpoint { paths: number; price: number; se: number; }

export interface McResult {
  price: number;       // $ value of the portfolio
  se: number;          // standard error of that estimate
  paths: number;
  ms: number;
  antithetic: boolean;
  checkpoints: McCheckpoint[];
}

/**
 * Monte Carlo value of a European option portfolio under risk-neutral GBM.
 *
 * Each simulated path is a Brownian path observed at every distinct leg expiry,
 * so legs with different maturities are correctly correlated. The standard error
 * is computed on the per-path portfolio value — or on antithetic pair means when
 * antithetic variates are on — so it is the real sampling error of the estimate.
 * Optional checkpoints record the running estimate for convergence plots.
 */
export function mcPortfolio(legs: Leg[], m: Market, nPaths: number, seed: number,
                            antithetic = false, checkpoints: number[] = []): McResult {
  const t0 = now();
  const times = Array.from(new Set(legs.map(l => Math.max(0, l.T)))).sort((a, b) => a - b);
  const k = times.length;
  const incSd = new Float64Array(k);
  let prev = 0;
  for (let i = 0; i < k; i++) {
    incSd[i] = Math.sqrt(Math.max(times[i] - prev, 0));
    prev = times[i];
  }
  // Each leg is lognormal at its own smile volatility on the shared Brownian path, so its
  // expected payoff is the Black-Scholes value at that volatility. In a flat market every
  // leg has the same σ and this is the usual single-GBM simulation, number for number.
  const legTime = legs.map(l => times.indexOf(Math.max(0, l.T)));
  const legVol = legs.map(l => legSigma(m, l.K, l.T));
  const legDrift = legs.map((l, j) => (m.r - m.q - 0.5 * legVol[j] * legVol[j]) * Math.max(0, l.T));
  const weight = legs.map(l => Math.exp(-m.r * Math.max(0, l.T)) * signedQty(l) * M);
  const z = new Float64Array(k);
  const W = new Float64Array(k);
  const next = normalSampler(seed);

  const valueFor = (sign: number): number => {
    let w = 0;
    for (let i = 0; i < k; i++) {
      w += sign * incSd[i] * z[i];
      W[i] = w;
    }
    let pv = 0;
    for (let j = 0; j < legs.length; j++) {
      const l = legs[j], s = m.S * Math.exp(legDrift[j] + legVol[j] * W[legTime[j]]);
      pv += weight[j] * (l.call ? Math.max(s - l.K, 0) : Math.max(l.K - s, 0));
    }
    return pv;
  };

  const unit = antithetic ? 2 : 1;
  const units = Math.max(1, Math.floor(nPaths / unit));
  const cps = checkpoints.filter(c => c > 0).sort((a, b) => a - b);
  const out: McCheckpoint[] = [];
  let ci = 0, sum = 0, sumSq = 0;

  for (let n = 1; n <= units; n++) {
    for (let i = 0; i < k; i++) z[i] = next();
    const v = antithetic ? 0.5 * (valueFor(1) + valueFor(-1)) : valueFor(1);
    sum += v;
    sumSq += v * v;
    const pathsSoFar = n * unit;
    while (ci < cps.length && pathsSoFar >= cps[ci]) {
      const mean = sum / n;
      out.push({ paths: pathsSoFar, price: mean,
                 se: Math.sqrt(Math.max(sumSq / n - mean * mean, 0) / n) });
      ci++;
    }
  }
  const mean = sum / units;
  const se = Math.sqrt(Math.max(sumSq / units - mean * mean, 0) / units);
  return { price: mean, se, paths: units * unit, ms: now() - t0, antithetic, checkpoints: out };
}

/** Sample GBM price paths for visualisation (nSteps + 1 points each). */
export function samplePaths(m: Market, T: number, nPaths: number, nSteps: number,
                            seed: number): number[][] {
  const next = normalSampler(seed);
  const dt = Math.max(T, 0) / nSteps;
  const drift = (m.r - m.q - 0.5 * m.sigma * m.sigma) * dt;
  const vol = m.sigma * Math.sqrt(dt);
  const paths: number[][] = [];
  for (let p = 0; p < nPaths; p++) {
    const path = new Array<number>(nSteps + 1);
    let s = m.S;
    path[0] = s;
    for (let i = 1; i <= nSteps; i++) {
      s *= Math.exp(drift + vol * next());
      path[i] = s;
    }
    paths.push(path);
  }
  return paths;
}

export interface Bin { x0: number; x1: number; n: number; }

export interface TerminalDistribution {
  bins: Bin[];
  lo: number;
  hi: number;
  binWidth: number;
  mean: number;
  samples: number;
  pItm: number | null;   // empirical P(ITM) for the supplied strike, if any
}

/**
 * Histogram of simulated terminal prices S_T (central 99.6% of mass). `onSample`
 * sees every draw, so callers can compute path statistics on the same sample.
 */
export function terminalDistribution(m: Market, T: number, nSamples: number, nBins: number,
                                     seed: number,
                                     strike?: { K: number; call: boolean },
                                     onSample?: (s: number) => void): TerminalDistribution {
  const next = normalSampler(seed);
  const mu = (m.r - m.q - 0.5 * m.sigma * m.sigma) * Math.max(T, 0);
  const vol = m.sigma * Math.sqrt(Math.max(T, 0));
  const xs = new Float64Array(nSamples);
  let sum = 0, itm = 0;
  for (let i = 0; i < nSamples; i++) {
    const s = m.S * Math.exp(mu + vol * next());
    xs[i] = s;
    sum += s;
    if (strike && (strike.call ? s > strike.K : s < strike.K)) itm++;
    if (onSample) onSample(s);
  }
  const sorted = Float64Array.from(xs).sort();
  let lo = sorted[Math.floor(nSamples * 0.002)];
  let hi = sorted[Math.min(nSamples - 1, Math.floor(nSamples * 0.998))];
  if (!(hi > lo)) { lo = m.S * 0.9; hi = m.S * 1.1; }
  const binWidth = (hi - lo) / nBins;
  const bins: Bin[] = Array.from({ length: nBins }, (_, i) =>
    ({ x0: lo + i * binWidth, x1: lo + (i + 1) * binWidth, n: 0 }));
  for (let i = 0; i < nSamples; i++) {
    const b = Math.floor((xs[i] - lo) / binWidth);
    if (b >= 0 && b < nBins) bins[b].n++;
  }
  return { bins, lo, hi, binWidth, mean: sum / nSamples, samples: nSamples,
           pItm: strike ? itm / nSamples : null };
}

/** Risk-neutral lognormal density of S_T — overlaid on the simulated histogram. */
export function lognormalPdf(x: number, m: Market, T: number): number {
  if (!(x > 0) || !(T > 0) || !(m.sigma > 0)) return 0;
  const s2 = m.sigma * m.sigma * T;
  const mu = Math.log(m.S) + (m.r - m.q - 0.5 * m.sigma * m.sigma) * T;
  const z = Math.log(x) - mu;
  return Math.exp(-(z * z) / (2 * s2)) / (x * Math.sqrt(2 * Math.PI * s2));
}
