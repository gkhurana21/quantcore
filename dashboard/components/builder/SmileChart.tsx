'use client';

import { memo } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { legSigma } from '@/lib/quant/volSurface';
import { firstExpiry } from '@/lib/strategy/portfolio';
import { days, pct } from '@/lib/format';
import b from './builder.module.css';

const W = 300, H = 92;
const PAD = { l: 34, r: 8, t: 8, b: 18 };
const LO = 0.7, HI = 1.3, N = 60;

export interface MarketIv { K: number; ivMarket: number; call: boolean; }

/**
 * Implied volatility across strikes from 70% to 130% of spot at the first expiry, with the legs' strikes marked
 * and, after a calibration, the market implied volatilities it was fitted to.
 */
export const SmileChart = memo(function SmileChart({ market: m, legs, quotes }: {
  market: Market; legs: Leg[]; quotes?: MarketIv[];
}) {
  const T = legs.length ? Math.max(firstExpiry(legs), 1 / 365) : 30 / 365;
  const at = (x: number) => legSigma(m, x * m.S, T);
  const xs = Array.from({ length: N + 1 }, (_, i) => LO + ((HI - LO) * i) / N);
  const vols = xs.map(at);
  const shownQuotes = (quotes ?? []).filter(p => p.K / m.S > LO && p.K / m.S < HI);
  const vMin = Math.min(...vols, ...shownQuotes.map(p => p.ivMarket));
  const vMax = Math.max(...vols, ...shownQuotes.map(p => p.ivMarket));
  const pad = Math.max((vMax - vMin) * 0.15, m.sigma * 0.05);
  const lo = vMin - pad, hi = vMax + pad;
  const X = (x: number) => PAD.l + ((x - LO) / (HI - LO)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(vols[i]).toFixed(1)}`).join('');
  const fwd = Math.exp((m.r - m.q) * T);   // the forward as a fraction of spot: where the smile's ATM volatility σ sits
  const down = at(0.9), atm = at(fwd), up = at(1.1);
  // legs at the first expiry sit on this curve; later expiries have their own slice of the surface
  const strikes = legs.filter(l => l.K / m.S > LO && l.K / m.S < HI && Math.abs(Math.max(l.T, 1 / 365) - T) < 1e-9);

  return (
    <figure className={b.smileFig}>
      <svg viewBox={`0 0 ${W} ${H}`} className={b.smileChart} role="img" data-testid="smile-chart"
           data-down={down} data-atm={atm} data-up={up} data-quotes={shownQuotes.length}
           aria-label={`Implied volatility at ${days(T)} days: ${pct(down, 1)} at 90% of spot, ${pct(atm, 1)} at the money (forward), ${pct(up, 1)} at 110% of spot`}>
        <line x1={X(fwd)} x2={X(fwd)} y1={PAD.t} y2={H - PAD.b} stroke="var(--line-2)" strokeDasharray="3 3" />
        <text x={X(fwd) + 4} y={PAD.t + 8} className={b.smileTick}>ATM</text>
        {shownQuotes.map(p => (
          <circle key={`${p.call ? 'c' : 'p'}${p.K}`} cx={X(p.K / m.S)} cy={Y(p.ivMarket)} r={2.2}
                  fill="none" stroke="var(--ink-2)" strokeWidth={1} />
        ))}
        <path d={d} fill="none" stroke="var(--amber-2)" strokeWidth={1.6} />
        {strikes.map(l => (
          <circle key={l.id} cx={X(l.K / m.S)} cy={Y(legSigma(m, l.K, T))} r={3}
                  fill={l.call ? 'var(--green)' : 'var(--red)'} stroke="var(--bg-raise)" strokeWidth={1} />
        ))}
        <text x={PAD.l - 5} y={PAD.t + 8} textAnchor="end" className={b.smileTick}>{pct(hi, 0)}</text>
        <text x={PAD.l - 5} y={H - PAD.b} textAnchor="end" className={b.smileTick}>{pct(lo, 0)}</text>
        {[0.8, 1, 1.2].map(x => (
          <text key={x} x={X(x)} y={H - 4} textAnchor="middle" className={b.smileTick}>{x === 1 ? 'spot' : `${Math.round(x * 100)}%`}</text>
        ))}
      </svg>
      <figcaption className={b.smileCap}>
        {m.smile
          ? `σ by strike at ${days(T)}d: ${pct(down, 1)} at 90% of spot · ${pct(atm, 1)} at the money (forward) · ${pct(up, 1)} at 110%${shownQuotes.length ? ' · circles: market implied vols' : ''}`
          : m.term ? `Flat across strikes: ${pct(atm, 1)} at ${days(T)}d, from the term structure below`
          : `Flat: every strike priced at σ ${pct(m.sigma, 1)}`}
      </figcaption>
    </figure>
  );
});
