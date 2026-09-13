'use client';

import { memo, useRef } from 'react';
import type { McCheckpoint } from '@/lib/quant/monteCarlo';
import { usd, usdSigned } from '@/lib/format';
import { linear, niceStep, niceTicks } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import { decimalsFor, fmtPaths, Z95 } from './labFormat';
import l from './lab.module.css';

/**
 * Running Monte Carlo estimate against the Black-Scholes reference on a log path axis.
 * Shaded: the estimate's own 95% confidence interval at each checkpoint.
 * Dashed: the theoretical ±1.96·σ̂/√N envelope implied by the final run's payoff dispersion.
 */
export const ConvergenceChart = memo(function ConvergenceChart({ checkpoints, reference, sigmaHat }: {
  checkpoints: McCheckpoint[]; reference: number; sigmaHat: number;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 560);
  const height = 236;
  const pad = { l: 82, r: 14, t: 14, b: 30 };

  if (checkpoints.length < 2) return <div ref={wrap} data-testid="convergence-chart" data-points={checkpoints.length} />;

  const n0 = checkpoints[0].paths, n1 = checkpoints[checkpoints.length - 1].paths;
  const X = linear(Math.log10(n0), Math.log10(n1), pad.l, width - pad.r);
  const xN = (n: number) => X(Math.log10(n));
  const env = (n: number) => (Z95 * sigmaHat) / Math.sqrt(n);
  let lo = reference - env(n0), hi = reference + env(n0);
  for (const c of checkpoints) {
    lo = Math.min(lo, c.price - Z95 * c.se);
    hi = Math.max(hi, c.price + Z95 * c.se);
  }
  const span = hi - lo || Math.abs(reference) * 0.01 || 1;
  lo -= span * 0.08; hi += span * 0.08;
  const Y = linear(lo, hi, height - pad.b, pad.t);
  const ticks = niceTicks(lo, hi, 4);
  const dec = decimalsFor(niceStep(hi - lo, 4));

  const grid = Array.from({ length: 48 }, (_, i) => n0 * Math.pow(n1 / n0, i / 47));
  const envPath = (sign: number) => grid.map((n, i) =>
    `${i ? 'L' : 'M'}${xN(n).toFixed(1)},${Y(reference + sign * env(n)).toFixed(1)}`).join('');
  const band = [
    ...checkpoints.map(c => `${xN(c.paths).toFixed(1)},${Y(c.price + Z95 * c.se).toFixed(1)}`),
    ...checkpoints.slice().reverse().map(c => `${xN(c.paths).toFixed(1)},${Y(c.price - Z95 * c.se).toFixed(1)}`),
  ].join(' ');
  const line = checkpoints.map((c, i) => `${i ? 'L' : 'M'}${xN(c.paths).toFixed(1)},${Y(c.price).toFixed(1)}`).join('');
  const last = checkpoints[checkpoints.length - 1];

  return (
    <div ref={wrap} data-testid="convergence-chart" data-points={checkpoints.length}>
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Monte Carlo estimate from ${fmtPaths(n0)} to ${fmtPaths(n1)} paths: final ${usd(last.price, 2)} plus or minus ${usd(Z95 * last.se, 2)} at 95% confidence, Black-Scholes ${usd(reference, 2)}.`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={l.axis}>{usd(t, dec)}</text>
          </g>
        ))}
        {checkpoints.map(c => (
          <text key={c.paths} x={xN(c.paths)} y={height - 10} textAnchor="middle" className={l.axis}>{fmtPaths(c.paths)}</text>
        ))}
        <polygon points={band} fill="var(--amber-soft)" />
        <path d={envPath(1)} fill="none" stroke="var(--ink-4)" strokeDasharray="3 4" />
        <path d={envPath(-1)} fill="none" stroke="var(--ink-4)" strokeDasharray="3 4" />
        <line x1={pad.l} x2={width - pad.r} y1={Y(reference)} y2={Y(reference)} stroke="var(--blue)" strokeWidth={1.4} />
        <text x={width - pad.r - 4} y={Y(reference) - 6} textAnchor="end" className={l.label} fill="var(--blue)">
          BS {usd(reference, Math.max(2, dec))}
        </text>
        <path d={line} fill="none" stroke="var(--amber)" strokeWidth={2} strokeLinejoin="round" />
        {checkpoints.map(c => (
          <circle key={c.paths} cx={xN(c.paths)} cy={Y(c.price)} r={3.2} fill="var(--amber-2)" stroke="var(--bg)" strokeWidth={1.5}>
            <title>{`${fmtPaths(c.paths)} paths: ${usd(c.price, 2)} ± ${usd(Z95 * c.se, 2)} (95% CI)`}</title>
          </circle>
        ))}
      </svg>
      <div className={l.legend} aria-hidden="true">
        <span><i className={l.sw} style={{ background: 'var(--amber)' }} />MC running estimate</span>
        <span><i className={l.swBand} />95% CI</span>
        <span><i className={l.swDash} />±1.96σ/√N envelope</span>
        <span><i className={l.sw} style={{ background: 'var(--blue)' }} />Black-Scholes</span>
      </div>
    </div>
  );
});

/**
 * CRR lattice error (CRR − BS) against step count. Odd and even lattices are drawn as separate lines:
 * they approach the closed form from opposite sides, which is the classic CRR odd/even oscillation.
 */
export const CrrChart = memo(function CrrChart({ curve }: { curve: { steps: number; error: number }[] }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 420);
  const height = 170;
  const pad = { l: 70, r: 14, t: 14, b: 28 };
  const pts = curve.filter(p => p.steps >= 4);
  if (pts.length < 2) return <div ref={wrap} data-testid="crr-chart" />;

  const X = linear(Math.log10(4), Math.log10(512), pad.l, width - pad.r);
  const view = Math.max(...curve.filter(p => p.steps >= 16).map(p => Math.abs(p.error)), 1e-9) * 1.2;
  const Y = linear(-view, view, height - pad.b, pad.t);
  const clampY = (v: number) => Y(Math.max(-view, Math.min(view, v)));
  const line = (subset: { steps: number; error: number }[]) => subset
    .map((p, i) => `${i ? 'L' : 'M'}${X(Math.log10(p.steps)).toFixed(1)},${clampY(p.error).toFixed(1)}`).join('');
  const even = pts.filter(p => p.steps % 2 === 0), odd = pts.filter(p => p.steps % 2 === 1);
  const ticks = niceTicks(-view, view, 4);
  const dec = decimalsFor(niceStep(2 * view, 4));
  const last = curve[curve.length - 1];

  return (
    <div ref={wrap} data-testid="crr-chart">
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Binomial lattice error versus steps; at ${last.steps} steps the error is ${usdSigned(last.error, 4)}.`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke={t === 0 ? 'var(--line-3)' : 'var(--line)'} />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={l.axis}>{usdSigned(t, dec)}</text>
          </g>
        ))}
        {[4, 8, 16, 32, 64, 128, 256, 512].map(n => (
          <text key={n} x={X(Math.log10(n))} y={height - 9} textAnchor="middle" className={l.axis}>{n}</text>
        ))}
        <path d={line(even)} fill="none" stroke="var(--violet)" strokeWidth={1.5} strokeLinejoin="round" />
        <path d={line(odd)} fill="none" stroke="var(--blue)" strokeWidth={1.5} strokeLinejoin="round" strokeDasharray="4 3" />
        <circle cx={X(Math.log10(last.steps))} cy={clampY(last.error)} r={3.5} fill="var(--violet)" stroke="var(--bg)" strokeWidth={1.5} />
      </svg>
      <div className={l.legend} aria-hidden="true">
        <span><i className={l.sw} style={{ background: 'var(--violet)' }} />even steps</span>
        <span><i className={l.swDash} style={{ borderColor: 'var(--blue)' }} />odd steps</span>
      </div>
    </div>
  );
});
