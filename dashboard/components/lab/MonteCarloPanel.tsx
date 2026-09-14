'use client';

import { memo, useEffect, useRef, useState } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import type { McVizResult } from '@/lib/compute/tasks';
import { useWorkerTask } from '@/lib/compute/useWorkerTask';
import { legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { days, num, pct, usdSigned } from '@/lib/format';
import { linear, niceTicks, numTick, strikeTick } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import { Button, cx, Segmented } from '@/components/ui/primitives';
import { SeedInput } from './SeedInput';
import { fmtMs } from './labFormat';
import l from './lab.module.css';

const N_PATHS = 100, N_STEPS = 60, HIST_SAMPLES = 50_000, BINS = 40;

const dateIn = (d: number) =>
  new Date(Date.now() + d * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const PathsChart = memo(function PathsChart({ v, legs, visible, replay }: {
  v: McVizResult; legs: Leg[]; visible: number; replay: number;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 640);
  const height = 300;
  const pad = { l: 56, r: 74, t: 26, b: 30 };
  const paths = v.paths.slice(0, visible);
  const s0 = v.paths[0]?.[0] ?? 0;

  let lo = s0, hi = s0;
  for (const p of paths) for (const s of p) { if (s < lo) lo = s; if (s > hi) hi = s; }
  for (const k of v.strikes) { lo = Math.min(lo, k); hi = Math.max(hi, k); }
  const span = hi - lo || s0 * 0.1 || 1;
  lo -= span * 0.05; hi += span * 0.05;

  const steps = Math.max(1, (paths[0]?.length ?? 2) - 1);
  const X = linear(0, v.horizonT, pad.l, width - pad.r);
  const Y = linear(lo, hi, height - pad.b, pad.t);
  const dt = v.horizonT / steps;
  const single = legs.length === 1 ? legs[0] : null;
  const horizonDays = days(v.horizonT);
  const dTicks = niceTicks(0, horizonDays, width < 520 ? 3 : 6).filter(d => d >= 0 && d <= horizonDays);
  const animKey = `${replay}|${paths.length}|${v.horizonT}|${v.paths[0]?.[1] ?? 0}`;
  // Draw-in animation for a new set of paths. The class is dropped once the animation should be
  // over, so paths always settle fully drawn even if the browser throttles animations (hidden tab).
  const [drawnKey, setDrawnKey] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setDrawnKey(animKey), 2600);
    return () => clearTimeout(id);
  }, [animKey]);
  const animating = drawnKey !== animKey;
  // keep the S₀ label clear of a strike label sitting at almost the same height
  const nearK = v.strikes.reduce<number | null>((best, k) =>
    best == null || Math.abs(Y(k) - Y(s0)) < Math.abs(Y(best) - Y(s0)) ? k : best, null);
  const s0LabelY = nearK != null && Math.abs(Y(nearK) - Y(s0)) < 13
    ? Y(nearK) + 3.5 + (Y(s0) >= Y(nearK) ? 13 : -13)
    : Y(s0) + 3.5;

  return (
    <div ref={wrap} data-testid="mc-paths-chart" data-count={paths.length}>
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`${paths.length} simulated price paths over ${horizonDays} days starting at ${num(s0, 2)}${v.strikes.length ? `, strikes ${v.strikes.join(', ')}` : ''}.`}>
        {niceTicks(lo, hi, 5).map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={l.axis}>{numTick(t)}</text>
          </g>
        ))}
        {dTicks.map(d => (
          <text key={d} x={X(d / 365)} y={height - 10} textAnchor="middle" className={l.axis}>{d}d</text>
        ))}

        {single && single.K > lo && single.K < hi && (
          <g>
            <rect x={pad.l} width={Math.max(0, X(v.firstT) - pad.l)}
                  y={single.call ? pad.t : Y(single.K)}
                  height={single.call ? Math.max(0, Y(single.K) - pad.t) : Math.max(0, height - pad.b - Y(single.K))}
                  fill="var(--green-soft)" />
            <text x={pad.l + 6} y={single.call ? pad.t + 13 : height - pad.b - 6} className={l.label} fill="var(--green)">
              ITM ({single.call ? 'S > K' : 'S < K'})
            </text>
          </g>
        )}

        {v.strikes.filter(k => k > lo && k < hi).map(k => (
          <g key={k}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(k)} y2={Y(k)} stroke="var(--ink-3)" strokeDasharray="4 4" />
            <text x={width - pad.r + 6} y={Y(k) + 3.5} className={l.label} fill="var(--ink-2)">K {strikeTick(k)}</text>
          </g>
        ))}
        <line x1={pad.l} x2={width - pad.r} y1={Y(s0)} y2={Y(s0)} stroke="var(--blue)" strokeDasharray="2 3" opacity={0.8} />
        <text x={width - pad.r + 6} y={s0LabelY} className={l.label} fill="var(--blue)">S₀ {numTick(s0)}</text>

        {v.expiries.filter(e => e > 0).map((e, i) => (
          <g key={e}>
            <line x1={X(e)} x2={X(e)} y1={pad.t} y2={height - pad.b} stroke="var(--amber-2)" opacity={0.5} />
            <text x={X(e)} y={pad.t - (i % 2 ? 14 : 6)} textAnchor={X(e) > width - pad.r - 40 ? 'end' : 'middle'}
                  className={l.label} fill="var(--amber-2)">expiry {days(e)}d · {dateIn(days(e))}</text>
          </g>
        ))}

        <g key={animKey}>
          {paths.map((p, i) => (
            <path key={i} data-mc-path="" className={animating ? l.path : undefined} pathLength={1}
                  d={p.map((s, j) => `${j ? 'L' : 'M'}${X(j * dt).toFixed(1)},${Y(s).toFixed(1)}`).join('')}
                  fill="none" stroke={i % 10 === 0 ? 'var(--amber-2)' : 'var(--amber)'}
                  strokeOpacity={i % 10 === 0 ? 0.95 : 0.3} strokeWidth={i % 10 === 0 ? 1.4 : 0.8}
                  style={{ animationDelay: `${Math.min(i * 14, 1000)}ms` }} />
          ))}
        </g>
      </svg>
    </div>
  );
});

const HistChart = memo(function HistChart({ v, legs }: { v: McVizResult; legs: Leg[] }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 460);
  const height = 300;
  const pad = { l: 12, r: 12, t: 26, b: 30 };
  const { dist } = v;
  const X = linear(dist.lo, dist.hi, pad.l, width - pad.r);
  const maxN = Math.max(1, ...dist.bins.map(b => b.n), ...v.pdf.map(p => p.y), ...v.pdfLognormal.map(p => p.y));
  const Y = linear(0, maxN * 1.1, height - pad.b, pad.t);
  const single = legs.length === 1 ? legs[0] : null;
  const s0 = v.paths[0]?.[0] ?? dist.mean;
  const pdfD = v.pdf.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const flatD = v.pdfLognormal.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
  const smileDensity = v.density === 'smile';
  const animKey = `${dist.lo}|${dist.hi}|${dist.mean}`;
  const [grownKey, setGrownKey] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => setGrownKey(animKey), 1100);
    return () => clearTimeout(id);
  }, [animKey]);
  const animating = grownKey !== animKey;
  const inRange = (x: number) => x > dist.lo && x < dist.hi;

  return (
    <div ref={wrap} data-testid="mc-hist" data-bins={dist.bins.length} data-density={v.density}>
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Histogram of ${dist.samples} simulated prices at ${days(v.firstT)} days, mean ${num(dist.mean, 2)}, with the ${smileDensity ? 'smile-implied' : 'lognormal'} density overlaid.`}>
        <g key={animKey}>
          {dist.bins.map((b, i) => {
            const mid = (b.x0 + b.x1) / 2;
            const itm = single ? (single.call ? mid > single.K : mid < single.K) : false;
            return (
              <rect key={i} data-mc-bar="" className={animating ? l.bar : undefined} x={X(b.x0) + 0.5} y={Y(b.n)}
                    width={Math.max(1, X(b.x1) - X(b.x0) - 1)} height={Math.max(0, Y(0) - Y(b.n))} rx={1}
                    fill={itm ? 'rgba(76,203,141,0.6)' : 'rgba(229,169,71,0.45)'}
                    style={{ animationDelay: `${i * 10}ms` }} />
            );
          })}
        </g>
        {flatD && <path d={flatD} fill="none" stroke="var(--ink-3)" strokeWidth={1.2} strokeDasharray="4 3" />}
        <path d={pdfD} fill="none" stroke="var(--blue)" strokeWidth={1.6} />
        {v.strikes.filter(inRange).map(k => (
          <g key={k}>
            <line x1={X(k)} x2={X(k)} y1={pad.t} y2={height - pad.b} stroke="var(--ink-2)" strokeDasharray="4 4" />
            <text x={X(k)} y={pad.t - 6} textAnchor="middle" className={l.label} fill="var(--ink-2)">K {strikeTick(k)}</text>
          </g>
        ))}
        {inRange(s0) && <line x1={X(s0)} x2={X(s0)} y1={pad.t} y2={height - pad.b} stroke="var(--blue)" strokeDasharray="2 3" />}
        {inRange(v.forward) && <line x1={X(v.forward)} x2={X(v.forward)} y1={pad.t + 10} y2={height - pad.b} stroke="var(--amber-2)" opacity={0.7} />}
        {niceTicks(dist.lo, dist.hi, width < 420 ? 3 : 5).map(t => (
          <text key={t} x={X(t)} y={height - 10} textAnchor="middle" className={l.axis}>{numTick(t)}</text>
        ))}
      </svg>
      <div className={l.legend} aria-hidden="true">
        <span><i className={l.sw} style={{ background: 'var(--blue)', height: 2 }} />{smileDensity ? 'Smile-implied density' : 'Lognormal density'}</span>
        {smileDensity && <span><i className={l.swDash} style={{ borderColor: 'var(--ink-3)' }} />Lognormal at ATM σ</span>}
        {single && <span><i className={l.swBand} style={{ background: 'rgba(76,203,141,.4)', borderColor: 'rgba(76,203,141,.6)' }} />In the money</span>}
        <span><i className={l.sw} style={{ background: 'var(--amber-2)' }} />Forward</span>
        <span><i className={l.swDash} style={{ borderColor: 'var(--blue)' }} />Spot</span>
      </div>
    </div>
  );
});

export function MonteCarloPanel({ legs, market, active }: { legs: Leg[]; market: Market; active: boolean }) {
  const [visible, setVisible] = useState(50);
  const [seed, setSeed] = useState(7);
  const [replay, setReplay] = useState(0);
  const key = `${legsKeyOf(legs)}|${marketKeyOf(market)}|${seed}`;
  const task = useWorkerTask('mcviz', active
    ? { legs, market, seed, nPaths: N_PATHS, nSteps: N_STEPS, histSamples: HIST_SAMPLES, bins: BINS } : null, key, 150);
  const v = task.result;
  const single = legs.length === 1;

  return (
    <div>
      <p className={l.intro}>
        Risk-neutral geometric Brownian motion, dS = (r − q)·S·dt + σ·S·dW, simulated from today to the last expiry.
        The histogram is a separate {HIST_SAMPLES.toLocaleString('en-US')}-sample draw of the price at the first expiry,
        checked against its analytic {market.smile ? 'smile-implied' : 'lognormal'} density.
        {market.smile && v && ` With the smile on, that draw comes from the distribution the smile implies (Breeden–Litzenberger), so P(ITM), P(profit) and expected P&L agree with smile prices; the paths are still GBM at ${single ? "this leg's volatility" : 'the at-the-money volatility'}, σ ${pct(v.pathSigma, 1)}.`}
      </p>
      <div className={l.controls}>
        <Segmented size="sm" label="Visible paths" testid="mc-visible" value={visible}
                   options={[25, 50, 100].map(n => ({ value: n, label: `${n} paths` }))} onChange={setVisible} />
        <SeedInput value={seed} onChange={setSeed} testid="mc-seed" />
        <Button size="sm" variant="ghost" data-testid="mc-reseed"
                onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}>New draw</Button>
        <Button size="sm" data-testid="mc-replay" onClick={() => setReplay(x => x + 1)}>↻ Replay</Button>
        <span className={l.status}>
          {task.running ? <><span className={l.spinner} aria-hidden="true" />Simulating…</>
            : v ? `${fmtMs(v.ms)} · ${task.mode === 'worker' ? 'Web Worker' : 'main thread'}` : ''}
        </span>
      </div>

      {!v ? (
        <p className={l.intro}>Simulating paths…</p>
      ) : (
        <div className={cx(task.running && l.stale)}>
          <div className={l.mcGrid}>
            <div className={l.card}>
              <div className={l.cardHead}>
                <span className={l.cardTitle}>Simulated price paths</span>
                <span className={l.cardMeta}>{visible} of {N_PATHS} shown · {N_STEPS} steps · seed {seed}</span>
              </div>
              <PathsChart v={v} legs={legs} visible={visible} replay={replay} />
            </div>
            <div className={l.card}>
              <div className={l.cardHead}>
                <span className={l.cardTitle}>Price distribution at {days(v.firstT)}d</span>
                <span className={l.cardMeta}>{v.dist.samples.toLocaleString('en-US')} samples · {BINS} bins</span>
              </div>
              <HistChart v={v} legs={legs} />
            </div>
          </div>

          <dl className={l.mcStats}>
            <div className={l.mcStat}>
              <dt>Horizon</dt><dd>{days(v.firstT)}d</dd>
              <dd className={l.statSub}>{v.expiries.length > 1 ? `paths run to ${days(v.horizonT)}d` : dateIn(days(v.firstT))}</dd>
            </div>
            <div className={l.mcStat}>
              <dt>Mean simulated S</dt><dd>{num(v.dist.mean, 2)}</dd>
              <dd className={l.statSub}>forward F = {num(v.forward, 2)}</dd>
            </div>
            {single && v.analyticItm != null && (
              <div className={l.mcStat}>
                <dt>P(in the money)</dt>
                <dd data-testid="mc-pitm" data-value={v.dist.pItm ?? ''}>{pct(v.dist.pItm ?? 0, 2)}</dd>
                <dd className={l.statSub}>{v.density === 'smile' ? 'smile-implied' : 'analytic N(d₂)'} = {pct(v.analyticItm, 2)}</dd>
              </div>
            )}
            <div className={l.mcStat}>
              <dt>P(profit)</dt><dd data-testid="mc-pprofit" data-value={v.pProfit}>{pct(v.pProfit, 1)}</dd>
              <dd className={l.statSub}>risk-neutral, at {days(v.firstT)}d</dd>
            </div>
            <div className={l.mcStat}>
              <dt>Expected P&amp;L</dt><dd>{usdSigned(v.expectedPnl)}</dd>
              <dd className={l.statSub}>risk-neutral, undiscounted</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
