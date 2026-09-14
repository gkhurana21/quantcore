import { bsPrice } from '../quant/blackScholes';
import { legSigma } from '../quant/volSurface';
import type { Leg, Market, Side } from '../quant/types';
import type { Instrument } from '../market/instruments';
import { CANONICAL } from '../market/instruments';

export const PRESETS = [
  'Long Call', 'Long Put', 'Short Call', 'Short Put',
  'Long Straddle', 'Long Strangle', 'Bull Call Spread', 'Bear Put Spread', 'Iron Condor',
] as const;
export type PresetName = typeof PRESETS[number];

export const DEFAULT_T = CANONICAL.T;     // 0.129y ≈ 47 days
export const DEFAULT_QTY = 10;
export const MAX_LEGS = 8;

let seq = 0;
export const newLegId = (): string => `leg-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** The engine-priced default position: SPY 755 call ×10, entered at the canonical market. */
export function canonicalLeg(): Leg {
  return {
    id: 'canonical', call: true, side: 'buy', qty: CANONICAL.qty, K: CANONICAL.K, T: CANONICAL.T,
    premium: bsPrice(true, CANONICAL.S, CANONICAL.K, CANONICAL.T, CANONICAL.sigma, CANONICAL.r, 0),
  };
}

export const atmStrike = (S: number, kstep: number): number => Math.round(S / kstep) * kstep;

/** ~2.5% of spot, snapped to the strike grid. */
export const wingWidth = (S: number, kstep: number): number =>
  Math.max(kstep, Math.round((S * 0.025) / kstep) * kstep);

export const isCanonicalMarket = (sym: string, m: Market): boolean =>
  sym === CANONICAL.sym && m.S === CANONICAL.S && m.sigma === CANONICAL.sigma &&
  m.r === CANONICAL.r && m.q === 0 && !m.smile;

export function makeLeg(call: boolean, side: Side, K: number, T: number, qty: number, m: Market): Leg {
  return { id: newLegId(), call, side, qty, K, T, premium: bsPrice(call, m.S, K, T, legSigma(m, K, T), m.r, m.q) };
}

/** Build a preset centred on the current spot; premiums are model prices at the current market. */
export function buildPreset(name: PresetName, inst: Instrument, m: Market): Leg[] {
  if (name === 'Long Call' && isCanonicalMarket(inst.sym, m)) return [canonicalLeg()];
  const K = atmStrike(m.S, inst.kstep);
  const w = wingWidth(m.S, inst.kstep);
  const T = DEFAULT_T, n = DEFAULT_QTY;
  const leg = (call: boolean, side: Side, strike: number) => makeLeg(call, side, strike, T, n, m);
  switch (name) {
    case 'Long Call':        return [leg(true, 'buy', K)];
    case 'Long Put':         return [leg(false, 'buy', K)];
    case 'Short Call':       return [leg(true, 'sell', K)];
    case 'Short Put':        return [leg(false, 'sell', K)];
    case 'Long Straddle':    return [leg(true, 'buy', K), leg(false, 'buy', K)];
    case 'Long Strangle':    return [leg(true, 'buy', K + w), leg(false, 'buy', K - w)];
    case 'Bull Call Spread': return [leg(true, 'buy', K), leg(true, 'sell', K + w)];
    case 'Bear Put Spread':  return [leg(false, 'buy', K), leg(false, 'sell', K - w)];
    case 'Iron Condor':      return [leg(false, 'buy', K - 2 * w), leg(false, 'sell', K - w),
                                     leg(true, 'sell', K + w), leg(true, 'buy', K + 2 * w)];
  }
}
