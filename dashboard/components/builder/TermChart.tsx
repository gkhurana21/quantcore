'use client';

import { memo } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { atmVol, TERM_PIVOT_T } from '@/lib/quant/volSurface';
import { pct } from '@/lib/format';
import b from './builder.module.css';

const W = 300, H = 92;
const PAD = { l: 34, r: 8, t: 8, b: 18 };
const N = 80;
const TICKS: [number, string][] = [[7 / 365, '1w'], [30 / 365, '1m'], [91 / 365, '3m'], [182 / 365, '6m'], [1, '1y'], [2, '2y']];

export interface TermPoint { T: number; vol: number; }

/**
 * At-the-money implied volatility by maturity on a square-root time axis, with σ's 30-day pivot, the legs'
 * expiries and, after a surface fit, the market's ATM volatility at each fitted expiry.
 */
export const TermChart = memo(function TermChart({ market: m, legs, points = [] }: {
  market: Market; legs: Leg[]; points?: TermPoint[];
}) {
  const legTs = Array.from(new Set(legs.map(l => l.T).filter(T => T > 0))).sort((a, b) => a - b);
  const tMax = Math.max(1, (legTs[legTs.length - 1] ?? 0) * 1.1, ...points.map(p => p.T * 1.05));
  const ts = Array.from({ length: N + 1 }, (_, i) => tMax * Math.max(1e-5, (i / N) ** 2));   // evenly spaced in √T
  const vols = ts.map(T => atmVol(m, T));
  const vMin = Math.min(...vols, ...points.map(p => p.vol));
  const vMax = Math.max(...vols, ...points.map(p => p.vol));
  const pad = Math.max((vMax - vMin) * 0.15, m.sigma * 0.05);
  const lo = vMin - pad, hi = vMax + pad;
  const X = (T: number) => PAD.l + Math.sqrt(Math.max(0, T) / tMax) * (W - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const d = ts.map((T, i) => `${i ? 'L' : 'M'}${X(T).toFixed(1)},${Y(vols[i]).toFixed(1)}`).join('');
  const week = atmVol(m, 7 / 365), month = atmVol(m, TERM_PIVOT_T), year = atmVol(m, 1);

  return (
    <figure className={b.smileFig}>
      <svg viewBox={`0 0 ${W} ${H}`} className={b.smileChart} role="img" data-testid="term-chart"
           data-week={week} data-month={month} data-year={year} data-points={points.length}
           data-first={legTs.length ? atmVol(m, legTs[0]) : month} data-last={legTs.length ? atmVol(m, legTs[legTs.length - 1]) : month}
           aria-label={`At-the-money implied volatility by expiry: ${pct(week, 1)} at one week, ${pct(month, 1)} at 30 days, ${pct(year, 1)} at one year`}>
        <line x1={X(TERM_PIVOT_T)} x2={X(TERM_PIVOT_T)} y1={PAD.t} y2={H - PAD.b} stroke="var(--line-2)" strokeDasharray="3 3" />
        <text x={X(TERM_PIVOT_T) + 4} y={PAD.t + 8} className={b.smileTick}>σ</text>
        {points.map(p => (
          <circle key={p.T} cx={X(p.T)} cy={Y(p.vol)} r={2.4} fill="none" stroke="var(--ink-2)" strokeWidth={1} />
        ))}
        <path d={d} fill="none" stroke="var(--amber-2)" strokeWidth={1.6} />
        <circle cx={X(TERM_PIVOT_T)} cy={Y(month)} r={2.6} fill="var(--amber-2)" />
        {legTs.map(T => (
          <circle key={T} cx={X(T)} cy={Y(atmVol(m, T))} r={3} fill="var(--blue)" stroke="var(--bg-raise)" strokeWidth={1} />
        ))}
        <text x={PAD.l - 5} y={PAD.t + 8} textAnchor="end" className={b.smileTick}>{pct(hi, 0)}</text>
        <text x={PAD.l - 5} y={H - PAD.b} textAnchor="end" className={b.smileTick}>{pct(lo, 0)}</text>
        {TICKS.filter(([T]) => T <= tMax * 1.001).map(([T, label]) => (
          <text key={label} x={X(T)} y={H - 4} textAnchor="middle" className={b.smileTick}>{label}</text>
        ))}
      </svg>
      <figcaption className={b.smileCap}>
        {m.term
          ? `ATM σ by expiry: ${pct(week, 1)} at 1 week · ${pct(month, 1)} at 30 days (σ) · ${pct(year, 1)} at 1 year · dots: the legs’ expiries${points.length ? ' · circles: market ATM vols' : ''}`
          : `Flat: every expiry at ATM σ ${pct(m.sigma, 1)}`}
      </figcaption>
    </figure>
  );
});
