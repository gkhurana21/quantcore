'use client';

import { memo, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import type { PayoffAnalytics } from '@/lib/strategy/portfolio';
import { pnlAtFirstExpiry, pnlNow, portfolioGreeks } from '@/lib/strategy/portfolio';
import { days, num, signed, signedPct, usdSigned } from '@/lib/format';
import type { ChartMode } from '@/components/terminal/useTerminalState';
import { linear, nearestIndex, niceTicks, numTick, pathD, strikeTick, usdTick } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import c from './analytics.module.css';

const SAMPLES = 260;

const MODE_META: Record<ChartMode, { unit: string; name: string }> = {
  pnl:   { unit: 'P&L ($)', name: 'profit and loss' },
  delta: { unit: 'Δ (shares)', name: 'net delta in shares' },
  gamma: { unit: 'Γ (Δ per $1)', name: 'net gamma' },
  vega:  { unit: 'Vega ($ / vol pt)', name: 'net vega per vol point' },
  theta: { unit: 'Θ ($ / day)', name: 'net theta per day' },
};

function valueAt(mode: ChartMode, legs: Leg[], x: number, m: Market): number {
  if (mode === 'pnl') return pnlNow(legs, x, m.sigma, m.r, m.q);
  const g = portfolioGreeks(legs, { ...m, S: x });
  switch (mode) {
    case 'delta': return g.delta;
    case 'gamma': return g.gamma;
    case 'vega':  return g.vega * 0.01;
    case 'theta': return g.theta / 365;
  }
}

const fmtValue = (mode: ChartMode, v: number): string =>
  mode === 'pnl' || mode === 'vega' || mode === 'theta' ? usdSigned(v)
    : mode === 'delta' ? `${signed(v, 0)} sh` : signed(v, 3);

const fmtTick = (mode: ChartMode, v: number): string =>
  mode === 'pnl' || mode === 'vega' || mode === 'theta' ? usdTick(v) : numTick(v);

/** Spot axis range: anchored on the instrument's reference spot and the strikes, so it holds still while spot moves. */
function spotRange(legs: Leg[], anchorS: number, S: number): [number, number] {
  const ks = legs.map(l => l.K);
  let lo = Math.min(anchorS * 0.8, ...ks.map(k => k * 0.93));
  let hi = Math.max(anchorS * 1.2, ...ks.map(k => k * 1.07));
  if (S < lo + (hi - lo) * 0.04) lo = S - (hi - lo) * 0.08;
  if (S > hi - (hi - lo) * 0.04) hi = S + (hi - lo) * 0.08;
  return [Math.max(0, lo), hi];
}

export const StrategyChart = memo(function StrategyChart({ legs, market, anchorS, mode, analytics }: {
  legs: Leg[]; market: Market; anchorS: number; mode: ChartMode; analytics: PayoffAnalytics;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrapRef, 760);
  const height = Math.round(Math.min(360, Math.max(240, width * 0.44)));
  const pad = { l: width < 480 ? 50 : 60, r: 18, t: 30, b: 30 };
  const clip = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);

  const [lo, hi] = useMemo(() => spotRange(legs, anchorS, market.S), [legs, anchorS, market.S]);

  const data = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i <= SAMPLES; i++) pts.push(lo + ((hi - lo) * i) / SAMPLES);
    for (const l of legs) if (l.K > lo && l.K < hi) pts.push(l.K);
    for (const b of analytics.breakevens) if (b > lo && b < hi) pts.push(b);
    pts.push(Math.min(hi, Math.max(lo, market.S)));
    const xs = Float64Array.from(new Set(pts)).sort();
    const main = new Float64Array(xs.length);
    const expiry = mode === 'pnl' ? new Float64Array(xs.length) : null;
    let yLo = 0, yHi = 0;
    for (let i = 0; i < xs.length; i++) {
      main[i] = valueAt(mode, legs, xs[i], market);
      if (main[i] < yLo) yLo = main[i];
      if (main[i] > yHi) yHi = main[i];
      if (expiry) {
        expiry[i] = pnlAtFirstExpiry(legs, xs[i], market.sigma, market.r, market.q);
        if (expiry[i] < yLo) yLo = expiry[i];
        if (expiry[i] > yHi) yHi = expiry[i];
      }
    }
    const span = Math.max(yHi - yLo, Math.abs(yHi) * 0.1, 1e-6);
    return { xs, main, expiry, yLo: yLo - span * 0.1, yHi: yHi + span * 0.12 };
  }, [legs, market, mode, lo, hi, analytics.breakevens]);

  const plotW = Math.max(10, width - pad.l - pad.r), plotH = height - pad.t - pad.b;
  const X = linear(lo, hi, pad.l, pad.l + plotW);
  const Y = linear(data.yLo, data.yHi, pad.t + plotH, pad.t);
  const y0 = Y(0);

  const mainD = pathD(data.xs, data.main, X, Y);
  const expD = data.expiry ? pathD(data.xs, data.expiry, X, Y) : '';
  const areaD = data.expiry ? `${expD}L${X(hi).toFixed(1)},${y0.toFixed(1)}L${X(lo).toFixed(1)},${y0.toFixed(1)}Z` : '';

  const yTicks = niceTicks(data.yLo, data.yHi, height < 280 ? 4 : 5);
  const xTicks = niceTicks(lo, hi, width < 520 ? 4 : 7);
  const strikes = Array.from(new Set(legs.map(l => l.K))).filter(k => k > lo && k < hi).sort((a, b) => a - b);
  const spotIdx = nearestIndex(data.xs, market.S);
  const spotVal = valueAt(mode, legs, market.S, market);
  const t1 = days(analytics.horizonT);

  const hi2 = hover != null && hover >= 0 && hover < data.xs.length ? hover : null;
  const hx = hi2 != null ? data.xs[hi2] : null;

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const v = lo + ((e.clientX - rect.left - pad.l) / plotW) * (hi - lo);
    setKeyboard(false);
    setHover(nearestIndex(data.xs, Math.min(hi, Math.max(lo, v))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const n = data.xs.length;
    const cur = hi2 ?? spotIdx;
    const stepN = e.shiftKey ? 20 : 2;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + stepN);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - stepN);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') { setHover(null); return; }
    if (next == null) return;
    e.preventDefault();
    setKeyboard(true);
    setHover(next);
  };

  const summary = `${MODE_META[mode].name} across spot ${num(lo, 0)} to ${num(hi, 0)} for ${legs.length} leg${legs.length > 1 ? 's' : ''}. ` +
    `At spot ${num(market.S, 2)}: ${fmtValue(mode, spotVal)}.` +
    (mode === 'pnl' && analytics.breakevens.length ? ` Break-even at ${analytics.breakevens.map(b => num(b, 2)).join(' and ')}.` : '') +
    ' Use left and right arrow keys to move the crosshair.';

  const tipLeft = hx != null ? Math.min(Math.max(X(hx) + 14, 0), width - 168) : 0;
  const tipFlip = hx != null && X(hx) > width - 190;

  return (
    <div ref={wrapRef} className={c.chartWrap} data-testid="strategy-chart" data-mode={mode}>
      <svg className={c.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
           role="img" aria-label={summary} tabIndex={0}
           onPointerMove={onPointer} onPointerLeave={() => { if (!keyboard) setHover(null); }}
           onKeyDown={onKey} onBlur={() => setHover(null)}>
        <defs>
          <clipPath id={`${clip}-pos`}><rect x={pad.l} y={0} width={plotW} height={Math.max(0, y0)} /></clipPath>
          <clipPath id={`${clip}-neg`}><rect x={pad.l} y={y0} width={plotW} height={Math.max(0, height - y0)} /></clipPath>
          <clipPath id={`${clip}-plot`}><rect x={pad.l} y={pad.t - 4} width={plotW} height={plotH + 8} /></clipPath>
        </defs>

        <text x={pad.l} y={14} className={c.axisUnit}>{MODE_META[mode].unit}</text>

        {yTicks.map(t => (
          <g key={`y${t}`}>
            <line x1={pad.l} x2={pad.l + plotW} y1={Y(t)} y2={Y(t)}
                  stroke={t === 0 ? 'var(--line-3)' : 'var(--line)'} />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={c.axisText}>{fmtTick(mode, t)}</text>
          </g>
        ))}
        {xTicks.map(t => (
          <text key={`x${t}`} x={X(t)} y={height - 10} textAnchor="middle" className={c.axisText}>{numTick(t)}</text>
        ))}

        {data.expiry && (
          <g clipPath={`url(#${clip}-plot)`}>
            <path d={areaD} fill="var(--green-soft)" clipPath={`url(#${clip}-pos)`} />
            <path d={areaD} fill="var(--red-soft)" clipPath={`url(#${clip}-neg)`} />
          </g>
        )}

        {strikes.map((k, i) => {
          const px = X(k);
          const crowded = i > 0 && px - X(strikes[i - 1]) < 46;
          return (
            <g key={`k${k}`}>
              <line x1={px} x2={px} y1={pad.t} y2={pad.t + plotH} stroke="var(--ink-4)" strokeDasharray="2 4" />
              <text x={px} y={pad.t - (crowded && i % 2 ? 16 : 6)} textAnchor="middle" className={c.markerText}
                    fill="var(--ink-3)">K {strikeTick(k)}</text>
            </g>
          );
        })}

        {mode === 'pnl' && !analytics.maxProfitUnbounded && analytics.maxProfit > data.yLo && analytics.maxProfit < data.yHi && (
          <g>
            <line x1={pad.l} x2={pad.l + plotW} y1={Y(analytics.maxProfit)} y2={Y(analytics.maxProfit)}
                  stroke="var(--green)" strokeDasharray="5 5" opacity={0.55} />
            <text x={pad.l + plotW - 4} y={Y(analytics.maxProfit) - 5} textAnchor="end" className={c.markerText}
                  fill="var(--green)">max profit {usdTick(analytics.maxProfit)}</text>
          </g>
        )}
        {mode === 'pnl' && !analytics.maxLossUnbounded && analytics.maxLoss > data.yLo && analytics.maxLoss < data.yHi && (
          <g>
            <line x1={pad.l} x2={pad.l + plotW} y1={Y(analytics.maxLoss)} y2={Y(analytics.maxLoss)}
                  stroke="var(--red)" strokeDasharray="5 5" opacity={0.55} />
            <text x={pad.l + plotW - 4} y={Y(analytics.maxLoss) + 13} textAnchor="end" className={c.markerText}
                  fill="var(--red)">max loss {usdTick(analytics.maxLoss)}</text>
          </g>
        )}

        <g clipPath={`url(#${clip}-plot)`}>
          {data.expiry && (
            <path d={expD} fill="none" stroke="var(--ink-3)" strokeWidth={1.4} strokeDasharray="5 4"
                  data-testid="chart-expiry-path" />
          )}
          <path d={mainD} fill="none" stroke="var(--amber)" strokeWidth={2.2} strokeLinejoin="round"
                data-testid="chart-main-path" />
        </g>

        {mode === 'pnl' && analytics.breakevens.filter(b => b > lo && b < hi).map(b => (
          <g key={`be${b}`}>
            <circle cx={X(b)} cy={y0} r={3.5} fill="var(--bg)" stroke="var(--ink)" strokeWidth={1.5} />
            <text x={X(b)} y={Math.min(y0 + 16, pad.t + plotH - 4)} textAnchor="middle" className={c.markerText}
                  fill="var(--ink-2)">B/E {num(b, b >= 100 ? 1 : 2)}</text>
          </g>
        ))}

        {market.S >= lo && market.S <= hi && (
          <g>
            <line x1={X(market.S)} x2={X(market.S)} y1={pad.t} y2={pad.t + plotH} stroke="var(--amber-2)" opacity={0.35} />
            <circle cx={X(market.S)} cy={Y(spotVal)} r={5} fill="var(--amber-2)" stroke="var(--bg)" strokeWidth={2} />
            {hx == null && (
              <text x={X(market.S) + (X(market.S) > width - 150 ? -10 : 10)} y={Math.max(pad.t + 10, Y(spotVal) - 10)}
                    textAnchor={X(market.S) > width - 150 ? 'end' : 'start'} className={c.markerText}
                    fill="var(--ink)" fontWeight={650}>{fmtValue(mode, spotVal)}</text>
            )}
          </g>
        )}

        {hx != null && hi2 != null && (
          <g pointerEvents="none">
            <line x1={X(hx)} x2={X(hx)} y1={pad.t} y2={pad.t + plotH} stroke="var(--ink-2)" opacity={0.5} />
            <circle cx={X(hx)} cy={Y(data.main[hi2])} r={4} fill="var(--ink)" />
            {data.expiry && <circle cx={X(hx)} cy={Y(data.expiry[hi2])} r={3} fill="var(--ink-3)" />}
          </g>
        )}
      </svg>

      {hx != null && hi2 != null && (
        <div className={c.tooltip} style={{ left: tipFlip ? Math.max(0, X(hx) - 176) : tipLeft }} aria-hidden="true">
          <div className={c.tooltipHead}>S = {num(hx, 2)} <span style={{ color: 'var(--ink-4)' }}>({signedPct(hx / market.S - 1)})</span></div>
          {mode === 'pnl' ? (
            <>
              <div className={c.tooltipRow}><span>P&amp;L now</span><span>{usdSigned(data.main[hi2])}</span></div>
              <div className={c.tooltipRow}><span>At {t1}d expiry</span><span>{usdSigned(data.expiry![hi2])}</span></div>
            </>
          ) : (
            <div className={c.tooltipRow}><span>{MODE_META[mode].unit}</span><span>{fmtValue(mode, data.main[hi2])}</span></div>
          )}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {keyboard && hx != null && hi2 != null ? `Spot ${num(hx, 2)}: ${fmtValue(mode, data.main[hi2])}` : ''}
      </p>

      <div className={c.legend} aria-hidden="true">
        <span className={c.legendItem}><span className={c.swatchLine} />{mode === 'pnl' ? 'P&L now (model value)' : `Net ${MODE_META[mode].unit}`}</span>
        {mode === 'pnl' && <span className={c.legendItem}><span className={c.swatchDash} />At first expiry · {t1}d</span>}
        {mode === 'pnl' && <span className={c.legendItem}><span className={c.swatchBox} style={{ background: 'var(--green-soft)', border: '1px solid rgba(76,203,141,.4)' }} />Profit zone</span>}
        <span className={c.legendItem}><span className={c.swatchDot} />Spot {num(market.S, 2)}</span>
        <span className={c.legendItem}>Hover or focus + ← → to inspect</span>
      </div>
    </div>
  );
});
