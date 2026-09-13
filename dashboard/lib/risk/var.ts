import { bsPrice } from '../quant/blackScholes';
import type { Bin } from '../quant/monteCarlo';
import { normInv } from '../quant/normal';
import { normalSampler } from '../quant/rng';
import type { Leg, Market } from '../quant/types';
import { CONTRACT_MULT as M, signedQty } from '../quant/types';
import { portfolioGreeks, portfolioValue } from '../strategy/portfolio';

export const TRADING_DAYS = 252;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface Exposures {
  value: number;
  deltaShares: number;
  dollarDelta: number;   // Δ · S
  gamma: number;         // shares per $1
  gammaPerPct: number;   // ½Γ(1%·S)² — P&L from gamma on a 1% move
  vega: number;
  vegaPerPt: number;     // $ per 1 vol point
  theta: number;
  thetaPerDay: number;
}

export function exposures(legs: Leg[], m: Market): Exposures {
  const g = portfolioGreeks(legs, m);
  const move = 0.01 * m.S;
  return {
    value: g.price, deltaShares: g.delta, dollarDelta: g.delta * m.S,
    gamma: g.gamma, gammaPerPct: 0.5 * g.gamma * move * move,
    vega: g.vega, vegaPerPt: g.vega * 0.01, theta: g.theta, thetaPerDay: g.theta / 365,
  };
}

/** σ scaled to the horizon: σ·√(h / 252). */
export const horizonVol = (sigma: number, hDays: number): number =>
  sigma * Math.sqrt(hDays / TRADING_DAYS);

/** Delta-normal VaR: z · |Δ · S| · σ√h. Linear, first-order. */
export function deltaNormalVaR(legs: Leg[], m: Market, conf = 0.95, hDays = 1): number {
  const g = portfolioGreeks(legs, m);
  return normInv(conf) * Math.abs(g.delta * m.S) * horizonVol(m.sigma, hDays);
}

/**
 * Delta-gamma VaR: worst quadratic P&L Δ·dS + ½Γ·dS² at dS = ±z·S·σ√h.
 * Captures convexity that delta-normal misses; still an approximation.
 */
export function deltaGammaVaR(legs: Leg[], m: Market, conf = 0.95, hDays = 1): number {
  const g = portfolioGreeks(legs, m);
  const dS = normInv(conf) * m.S * horizonVol(m.sigma, hDays);
  const loss = (x: number) => -(g.delta * x + 0.5 * g.gamma * x * x);
  return Math.max(loss(dS), loss(-dS), 0);
}

export interface McVarResult {
  var: number;
  es: number;          // expected shortfall beyond VaR
  scenarios: number;
  mean: number;
  ms: number;
  bins: Bin[];
  lo: number;
  hi: number;
}

/**
 * Monte Carlo full-revaluation VaR and Expected Shortfall. Simulates the horizon
 * move under zero-drift lognormal dynamics, reprices every leg with its time to
 * expiry reduced by the horizon (so theta is included), and reads the loss
 * quantile off the sorted P&L distribution.
 */
export function mcVaR(legs: Leg[], m: Market, conf: number, hDays: number,
                      nScen: number, seed: number): McVarResult {
  const t0 = now();
  const h = hDays / TRADING_DAYS;
  const base = portfolioValue(legs, m.S, m.sigma, m.r, m.q);
  const next = normalSampler(seed);
  const vol = m.sigma * Math.sqrt(h), drift = -0.5 * m.sigma * m.sigma * h;
  const pnl = new Float64Array(nScen);
  let sum = 0;
  for (let i = 0; i < nScen; i++) {
    const S = m.S * Math.exp(drift + vol * next());
    let v = 0;
    for (const l of legs) v += signedQty(l) * M * bsPrice(l.call, S, l.K, l.T - h, m.sigma, m.r, m.q);
    pnl[i] = v - base;
    sum += pnl[i];
  }
  pnl.sort();
  const k = Math.max(0, Math.min(nScen - 1, Math.floor((1 - conf) * nScen)));
  const VaR = Math.max(0, -pnl[k]);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += pnl[i];
  const es = Math.max(0, -tail / (k + 1));

  let lo = pnl[Math.floor(nScen * 0.002)], hi = pnl[Math.min(nScen - 1, Math.floor(nScen * 0.998))];
  if (!(hi > lo)) { lo -= 1; hi += 1; }
  const nb = 44, bw = (hi - lo) / nb;
  const bins: Bin[] = Array.from({ length: nb }, (_, i) => ({ x0: lo + i * bw, x1: lo + (i + 1) * bw, n: 0 }));
  for (let i = 0; i < nScen; i++) {
    const b = Math.floor((pnl[i] - lo) / bw);
    if (b >= 0 && b < nb) bins[b].n++;
  }
  return { var: VaR, es, scenarios: nScen, mean: sum / nScen, ms: now() - t0, bins, lo, hi };
}
