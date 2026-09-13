import type { Leg, Market } from '../quant/types';
import { portfolioValue } from '../strategy/portfolio';

export const SPOT_SHOCKS = [-0.10, -0.05, 0, 0.05, 0.10];
export const VOL_SHOCKS = [-0.50, -0.25, 0, 0.25, 0.50];

/**
 * Spot × vol P&L surface by full revaluation: each cell reprices every leg at the
 * shocked spot and (relative) shocked vol and reports the change in $ value.
 */
export function pnlSurface(legs: Leg[], m: Market,
                           spotShocks = SPOT_SHOCKS, volShocks = VOL_SHOCKS): number[][] {
  const base = portfolioValue(legs, m.S, m.sigma, m.r, m.q);
  return spotShocks.map(ds => volShocks.map(dv =>
    portfolioValue(legs, m.S * (1 + ds), Math.max(1e-4, m.sigma * (1 + dv)), m.r, m.q) - base));
}
