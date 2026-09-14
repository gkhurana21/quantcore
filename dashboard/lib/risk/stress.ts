import { bsPrice } from '../quant/blackScholes';
import type { Leg, Market } from '../quant/types';
import { CONTRACT_MULT as M, signedQty } from '../quant/types';
import { grossPremium, netPremium, portfolioGreeks, portfolioValue, shiftLegs } from '../strategy/portfolio';
import { atSpot, legSigma } from '../quant/volSurface';
import { deltaNormalVaR } from './var';

/** An instantaneous market shock. Vol points are absolute (40 = +40 vol pts). */
export interface Shock {
  spotPct: number;   // % change in spot
  volPts: number;    // absolute change in vol, in points
  volMult: number;   // multiplicative vol change, applied before volPts
  rateBp: number;    // change in rate, basis points (rates floor at 0)
  days: number;      // calendar days elapsed (time decay)
}

export interface Scenario {
  id: string;
  name: string;
  tag: string;
  description: string;
  shock: Shock;
}

export const NO_SHOCK: Shock = { spotPct: 0, volPts: 0, volMult: 1, rateBp: 0, days: 0 };

// Illustrative shocks in the spirit of historical episodes — not calibrated replays.
export const SCENARIOS: Scenario[] = [
  { id: 'gfc', name: '2008-style Credit Crisis', tag: 'Crisis',
    description: 'Equity collapse, volatility regime shift and emergency rate cuts.',
    shock: { spotPct: -35, volPts: 40, volMult: 1, rateBp: -200, days: 0 } },
  { id: 'covid', name: 'COVID-style Crash', tag: 'Crash',
    description: 'Fast drawdown with an extreme volatility spike and rate cuts.',
    shock: { spotPct: -30, volPts: 55, volMult: 1, rateBp: -150, days: 0 } },
  { id: 'volspike', name: 'Volatility Spike', tag: 'Vol',
    description: 'Modest sell-off; implied vol reprices sharply higher.',
    shock: { spotPct: -5, volPts: 20, volMult: 1, rateBp: 0, days: 0 } },
  { id: 'rates', name: 'Rate Shock', tag: 'Rates',
    description: 'Hawkish repricing: +200bp with a mild equity sell-off.',
    shock: { spotPct: -3, volPts: 3, volMult: 1, rateBp: 200, days: 0 } },
  { id: 'meltup', name: 'Melt-up / Vol Crush', tag: 'Upside',
    description: 'Strong rally while implied vol collapses by 40%.',
    shock: { spotPct: 12, volPts: 0, volMult: 0.6, rateBp: 0, days: 0 } },
];

export function applyShock(m: Market, s: Shock): Market {
  return {
    S: m.S * (1 + s.spotPct / 100),
    sigma: Math.max(0.01, m.sigma * s.volMult + s.volPts / 100),
    r: Math.max(0, m.r + s.rateBp / 10_000),
    q: m.q,
    // sticky strike: the smile stays centred on the pre-shock spot; the vol shock moves its ATM level
    ...(m.smile ? { smile: m.smile, smileSpot: m.smileSpot ?? m.S } : {}),
    // the term structure keeps its shape: every expiry's ATM volatility scales with the shocked 30-day level
    ...(m.term ? { term: m.term } : {}),
  };
}

export interface StressMetrics {
  S: number; sigma: number; r: number;
  value: number; pnl: number;
  delta: number; gamma: number; vega: number; theta: number;
  var95: number;
}

export interface StressReport {
  base: Market;
  shocked: Market;
  shock: Shock;
  before: StressMetrics;
  after: StressMetrics;
  pnl: number;
  pnlPct: number | null;         // relative to gross premium
  pnlByLeg: number[];
  ladder: { spotPct: number; pnl: number }[];
}

function metrics(legs: Leg[], m: Market, days: number): StressMetrics {
  const ls = shiftLegs(legs, days / 365);
  const g = portfolioGreeks(ls, m);
  return {
    S: m.S, sigma: m.sigma, r: m.r,
    value: g.price, pnl: g.price - netPremium(legs),
    delta: g.delta, gamma: g.gamma, vega: g.vega, theta: g.theta,
    var95: deltaNormalVaR(ls, m, 0.95, 1),
  };
}

/** Full-revaluation stress test of the portfolio under one shock. */
export function stressReport(legs: Leg[], base: Market, shock: Shock): StressReport {
  const shocked = applyShock(base, shock);
  const before = metrics(legs, base, 0);
  const after = metrics(legs, shocked, shock.days);
  const shifted = shiftLegs(legs, shock.days / 365);
  const pnlByLeg = legs.map((l, i) => signedQty(l) * M * (
    bsPrice(l.call, shocked.S, l.K, shifted[i].T, legSigma(shocked, l.K, shifted[i].T), shocked.r, shocked.q) -
    bsPrice(l.call, base.S, l.K, l.T, legSigma(base, l.K, l.T), base.r, base.q)));
  const ladder: { spotPct: number; pnl: number }[] = [];
  for (let p = -40; p <= 40; p += 5) {
    ladder.push({ spotPct: p,
      pnl: portfolioValue(shifted, atSpot(shocked, base.S * (1 + p / 100))) - before.value });
  }
  const pnl = after.value - before.value;
  const gross = grossPremium(legs);
  return { base, shocked, shock, before, after, pnl,
           pnlPct: gross > 0 ? pnl / gross : null, pnlByLeg, ladder };
}
