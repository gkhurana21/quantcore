// Option chains for a whole-surface fit: listed expiries spread from about a week to a year and a
// half, loaded in parallel through the data proxy and reduced to out-of-the-money quotes.

import type { LiveChain } from './marketData';
import { fetchChain } from './marketData';
import type { SurfaceSliceInput } from '../quant/calibrate';
import { atmReferenceIv, otmQuotes, yearsToExpiry } from '../quant/calibrate';

/** Maturities (days) the fit aims for; each takes the listed expiry nearest it in log-time. */
export const SURFACE_TARGET_DAYS = [7, 14, 30, 60, 91, 182, 365, 547] as const;

/** Expiries closer than this carry too little time value for a stable implied volatility. */
const MIN_DAYS = 4;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Up to one listed expiry per target maturity, in date order. `include` (the expiry the legs use) is always
 * kept when listed, replacing the pick nearest to it.
 */
export function pickSurfaceExpiries(expirations: string[], include = '', now = Date.now()): string[] {
  const listed = Array.from(new Set(expirations.filter(e => DATE_RE.test(e))))
    .map(e => ({ e, d: yearsToExpiry(e, now) * 365 }));
  const usable = listed.filter(x => x.d >= MIN_DAYS);
  const gap = (d: number, target: number) => Math.abs(Math.log(d / target));
  const picks: { e: string; d: number }[] = [];
  if (usable.length) {
    for (const target of SURFACE_TARGET_DAYS) {
      const nearest = usable.reduce((a, x) => (gap(x.d, target) < gap(a.d, target) ? x : a));
      if (!picks.some(p => p.e === nearest.e)) picks.push(nearest);
    }
  }
  const inc = listed.find(x => x.e === include);
  if (inc && !picks.some(p => p.e === inc.e)) {
    if (picks.length >= SURFACE_TARGET_DAYS.length) {
      const closest = picks.reduce((a, p) => (gap(p.d, inc.d) < gap(a.d, inc.d) ? p : a));
      picks.splice(picks.indexOf(closest), 1);
    }
    picks.push(inc);
  }
  return picks.map(p => p.e).sort();
}

export interface SurfaceLoad { slices: SurfaceSliceInput[]; failed: string[]; }

/** Load each expiry's chain and keep its out-of-the-money quotes; expiries whose chain fails are listed. */
export async function loadSurfaceSlices(
  symbol: string, expiries: string[], S: number, r: number, q: number, now = Date.now(),
  getChain: (symbol: string, expiration: string) => Promise<LiveChain> = fetchChain,
): Promise<SurfaceLoad> {
  const settled = await Promise.allSettled(expiries.map(e => getChain(symbol, e)));
  const slices: SurfaceSliceInput[] = [];
  const failed: string[] = [];
  settled.forEach((res, i) => {
    const expiry = expiries[i];
    if (res.status !== 'fulfilled') { failed.push(expiry); return; }
    const T = yearsToExpiry(expiry, now);
    const forward = S * Math.exp((r - q) * T);
    const options = res.value.options;
    slices.push({ expiry, T, quotes: otmQuotes(options, forward, atmReferenceIv(options, forward)) });
  });
  return { slices, failed };
}
