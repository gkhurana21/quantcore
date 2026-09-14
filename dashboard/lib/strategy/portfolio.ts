import { bsGreeks, bsPrice, intrinsic } from '../quant/blackScholes';
import { atSpot, legSigma } from '../quant/volSurface';
import type { Greeks, Leg, Market } from '../quant/types';
import { CONTRACT_MULT as M, signedQty } from '../quant/types';

const EPS_T = 1e-9;

/** Advance every leg's clock by dtYears (expired legs sit at T = 0). */
export function shiftLegs(legs: Leg[], dtYears: number): Leg[] {
  if (!dtYears) return legs;
  return legs.map(l => ({ ...l, T: Math.max(0, l.T - dtYears) }));
}

/** $ mark-to-model value of the positions (excluding premium paid/received), each leg at its smile volatility. */
export function portfolioValue(legs: Leg[], m: Market): number {
  let v = 0;
  for (const l of legs) v += signedQty(l) * M * bsPrice(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q);
  return v;
}

/**
 * Aggregated position Greeks: price = $ value, delta = share-equivalents,
 * gamma = shares per $1, vega = $ per 1.00 vol, theta = $ per year.
 */
export function portfolioGreeks(legs: Leg[], m: Market): Greeks {
  const out: Greeks = { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of legs) {
    const g = bsGreeks(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q);
    const w = signedQty(l) * M;
    out.price += w * g.price;
    out.delta += w * g.delta;
    out.gamma += w * g.gamma;
    out.theta += w * g.theta;
    out.vega += w * g.vega;
  }
  return out;
}

/** Net premium in $: positive = net debit paid, negative = net credit received. */
export const netPremium = (legs: Leg[]): number =>
  legs.reduce((a, l) => a + signedQty(l) * M * l.premium, 0);

export const grossPremium = (legs: Leg[]): number =>
  legs.reduce((a, l) => a + l.qty * M * Math.abs(l.premium), 0);

export const pnlNow = (legs: Leg[], m: Market): number =>
  portfolioValue(legs, m) - netPremium(legs);

export const firstExpiry = (legs: Leg[]): number =>
  legs.length ? Math.min(...legs.map(l => Math.max(0, l.T))) : 0;

/**
 * P&L at the first expiry: legs expiring then pay intrinsic value, later legs
 * are still worth their Black-Scholes value with the remaining time.
 */
export function pnlAtFirstExpiry(legs: Leg[], m: Market): number {
  const t0 = firstExpiry(legs);
  let v = 0;
  for (const l of legs) {
    const tau = l.T - t0;
    const px = tau <= EPS_T ? intrinsic(l.call, m.S, l.K) : bsPrice(l.call, m.S, l.K, tau, legSigma(m, l.K, tau), m.r, m.q);
    v += signedQty(l) * M * (px - l.premium);
  }
  return v;
}

export interface PayoffAnalytics {
  maxProfit: number;             // +Infinity when unbounded
  maxLoss: number;               // −Infinity when unbounded (reported as a negative P&L)
  maxProfitUnbounded: boolean;
  maxLossUnbounded: boolean;
  breakevens: number[];
  exact: boolean;                // true = closed form (single expiry); false = numerical scan
  horizonT: number;              // the expiry the analytics refer to
}

export function payoffAnalytics(legs: Leg[], m: Market): PayoffAnalytics {
  const horizonT = firstExpiry(legs);
  if (!legs.length) {
    return { maxProfit: 0, maxLoss: 0, maxProfitUnbounded: false, maxLossUnbounded: false,
             breakevens: [], exact: true, horizonT };
  }
  const single = legs.every(l => Math.abs(l.T - legs[0].T) < EPS_T);
  return single ? exactPayoff(legs, horizonT) : numericPayoff(legs, m, horizonT);
}

// Single expiry: the payoff is piecewise linear with kinks at the strikes, so the
// extremes sit at S = 0, at a strike, or at infinity (decided by net call slope),
// and break-evens are the exact zero crossings of each linear segment.
function exactPayoff(legs: Leg[], horizonT: number): PayoffAnalytics {
  const f = (x: number) =>
    legs.reduce((a, l) => a + signedQty(l) * M * (intrinsic(l.call, x, l.K) - l.premium), 0);
  const xs = [0, ...Array.from(new Set(legs.map(l => l.K))).filter(k => k > 0).sort((a, b) => a - b)];
  const vals = xs.map(f);
  const slope = legs.reduce((a, l) => a + (l.call ? signedQty(l) * M : 0), 0);
  const tol = 1e-9, zero = 1e-7;

  const breakevens: number[] = [];
  const push = (x: number) => {
    if (x >= 0 && !breakevens.some(b => Math.abs(b - x) < 1e-6)) breakevens.push(x);
  };
  const sign = (v: number) => (v > zero ? 1 : v < -zero ? -1 : 0);

  // Walk the kinks left to right. A sign change inside a segment is interpolated.
  // P&L can also sit exactly at zero across one or more kinks (zero-cost collars,
  // risk reversals, free legs); when it leaves that zero run with the opposite sign
  // to the one it entered with, the break-even is the edge of the run next to the
  // loss region.
  let runStart: number | null = null;   // first kink of the current zero run
  let entrySign = 0;                     // P&L sign just before the zero run
  for (let i = 1; i < xs.length; i++) {
    const s0 = sign(vals[i - 1]), s1 = sign(vals[i]);
    if (s0 !== 0 && s1 !== 0 && s0 !== s1) {
      push(xs[i - 1] + (xs[i] - xs[i - 1]) * (-vals[i - 1] / (vals[i] - vals[i - 1])));
    } else if (s0 !== 0 && s1 === 0) {
      runStart = xs[i];
      entrySign = s0;
    } else if (s0 === 0 && s1 !== 0) {
      if (runStart != null && entrySign === -s1) push(entrySign < 0 ? runStart : xs[i - 1]);
      runStart = null;
      entrySign = 0;
    }
  }
  const last = vals[vals.length - 1], xL = xs[xs.length - 1];
  const tailSign = slope > tol ? 1 : slope < -tol ? -1 : 0;
  if (sign(last) !== 0 && tailSign === -sign(last)) push(xL - last / slope);
  else if (sign(last) === 0 && runStart != null && tailSign !== 0 && entrySign === -tailSign) {
    push(entrySign < 0 ? runStart : xL);
  }
  breakevens.sort((a, b) => a - b);

  return {
    maxProfitUnbounded: slope > tol,
    maxLossUnbounded: slope < -tol,
    maxProfit: slope > tol ? Infinity : Math.max(...vals),
    maxLoss: slope < -tol ? -Infinity : Math.min(...vals),
    breakevens, exact: true, horizonT,
  };
}

// Mixed expiries: scan the first-expiry P&L numerically over [0, 4·max(S, K)].
function numericPayoff(legs: Leg[], m: Market, horizonT: number): PayoffAnalytics {
  const hi = 4 * Math.max(m.S, ...legs.map(l => l.K));
  const N = 2400;
  const xs = new Float64Array(N + 1), vs = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    xs[i] = (hi * i) / N;
    vs[i] = pnlAtFirstExpiry(legs, atSpot(m, xs[i]));
  }
  const breakevens: number[] = [];
  for (let i = 1; i <= N; i++) {
    if ((vs[i - 1] < 0 && vs[i] > 0) || (vs[i - 1] > 0 && vs[i] < 0)) {
      breakevens.push(xs[i - 1] + (xs[i] - xs[i - 1]) * (-vs[i - 1] / (vs[i] - vs[i - 1])));
    }
  }
  const tailSlope = (vs[N] - vs[N - 1]) / (xs[N] - xs[N - 1]);
  let max = -Infinity, min = Infinity;
  for (let i = 0; i <= N; i++) { if (vs[i] > max) max = vs[i]; if (vs[i] < min) min = vs[i]; }
  return {
    maxProfitUnbounded: tailSlope > 0.5,
    maxLossUnbounded: tailSlope < -0.5,
    maxProfit: tailSlope > 0.5 ? Infinity : max,
    maxLoss: tailSlope < -0.5 ? -Infinity : min,
    breakevens, exact: false, horizonT,
  };
}
