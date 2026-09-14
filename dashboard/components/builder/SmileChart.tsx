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

/** Implied volatility across strikes from 70% to 130% of spot at the first expiry, with the legs' strikes marked. */
export const SmileChart = memo(function SmileChart({ market: m, legs }: { market: Market; legs: Leg[] }) {
  const T = legs.length ? Math.max(firstExpiry(legs), 1 / 365) : 30 / 365;
  const at = (x: number) => legSigma(m, x * m.S, T);
  const xs = Array.from({ length: N + 1 }, (_, i) => LO + ((HI - LO) * i) / N);
  const vols = xs.map(at);
  const vMin = Math.min(...vols), vMax = Math.max(...vols);
  const pad = Math.max((vMax - vMin) * 0.15, m.sigma * 0.05);
  const lo = vMin - pad, hi = vMax + pad;
  const X = (x: number) => PAD.l + ((x - LO) / (HI - LO)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(vols[i]).toFixed(1)}`).join('');
  const down = at(0.9), atm = at(1), up = at(1.1);
  const strikes = legs.filter(l => l.K / m.S > LO && l.K / m.S < HI);

  return (
    <figure className={b.smileFig}>
      <svg viewBox={`0 0 ${W} ${H}`} className={b.smileChart} role="img" data-testid="smile-chart"
           data-down={down} data-atm={atm} data-up={up}
           aria-label={`Implied volatility at ${days(T)} days: ${pct(down, 1)} at 90% of spot, ${pct(atm, 1)} at spot, ${pct(up, 1)} at 110%`}>
        <line x1={X(1)} x2={X(1)} y1={PAD.t} y2={H - PAD.b} stroke="var(--line-2)" strokeDasharray="3 3" />
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
          ? `σ by strike at ${days(T)}d: ${pct(down, 1)} · ${pct(atm, 1)} · ${pct(up, 1)} at 90 · 100 · 110% of spot`
          : `Flat: every strike priced at σ ${pct(m.sigma, 1)}`}
      </figcaption>
    </figure>
  );
});
