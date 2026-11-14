'use client';

import { memo, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import type { PayoffAnalytics } from '@/lib/strategy/portfolio';
import { pnlAtFirstExpiry, pnlNow, portfolioGreeks } from '@/lib/strategy/portfolio';
import { atSpot } from '@/lib/quant/volSurface';
import { days, num, signed, signedPct, usdSigned } from '@/lib/format';
import type { ChartMode } from '@/components/terminal/useTerminalState';
import { linear, nearestIndex, niceTicks, numTick, pathD, strikeTick, usdTick } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import c from './analytics.module.css';

const SAMPLES = 260;
const LABEL_PX = 10.5 * 0.62;   // advance of one 10.5px mono character
const LABEL_H = 12;

interface Box { x0: number; x1: number; y0: number; y1: number; }
/** The box a label occupies (baseline y), given its anchor. */
const labelBox = (text: string, x: number, y: number, anchor: 'start' | 'middle' | 'end'): Box => {
  const w = text.length * LABEL_PX;
  const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
  return { x0, x1: x0 + w, y0: y - LABEL_H + 3, y1: y + 3 };
};
const hits = (a: Box, b: Box, gap = 3) => a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
/** First candidate position that fits inside `within` and touches no label already placed; else the first. */
function placeLabel(text: string, cands: [number, number, 'start' | 'middle' | 'end'][], placed: Box[], within: Box) {
  for (const [x, y, a] of cands) {
    const b = labelBox(text, x, y, a);
    if (b.x0 >= within.x0 && b.x1 <= within.x1 && b.y0 >= within.y0 && b.y1 <= within.y1 && !placed.some(p => hits(p, b))) {
      placed.push(b);
      return { x, y, anchor: a };
    }
  }
  const [x, y, a] = cands[0];
  placed.push(labelBox(text, x, y, a));
  return { x, y, anchor: a };
}

const MODE_META: Record<ChartMode, { unit: string; name: string }> = {
  pnl:   { unit: 'P&L ($)', name: 'profit and loss' },
  delta: { unit: 'Δ (shares)', name: 'net delta in shares' },
  gamma: { unit: 'Γ (Δ per $1)', name: 'net gamma' },
  vega:  { unit: 'Vega ($ / vol pt)', name: 'net vega per vol point' },
  theta: { unit: 'Θ ($ / day)', name: 'net theta per day' },
};

// Spot scenarios are sticky-strike: with a smile, every strike keeps its volatility as spot moves.
function valueAt(mode: ChartMode, legs: Leg[], x: number, m: Market): number {
  const at = atSpot(m, x);
  if (mode === 'pnl') return pnlNow(legs, at);
  const g = portfolioGreeks(legs, at);
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
export function spotRange(legs: Leg[], anchorS: number, S: number): [number, number] {
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
        expiry[i] = pnlAtFirstExpiry(legs, atSpot(market, xs[i]));
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

  // labels never collide: each is tried at a few positions around its anchor and takes the first free one
  const labels = (() => {
    const placed: Box[] = [];
    const within: Box = { x0: 2, x1: width - 2, y0: 0, y1: height };
    placed.push({ x0: pad.l, x1: pad.l + MODE_META[mode].unit.length * 6.2, y0: 2, y1: 17 });
    const strikeLabels = strikes.map((k, i) => {
      const crowded = i > 0 && X(k) - X(strikes[i - 1]) < 46;
      const text = `K ${strikeTick(k)}`;
      const y = pad.t - (crowded && i % 2 ? 16 : 6);
      placed.push(labelBox(text, X(k), y, 'middle'));
      return { text, x: X(k), y };
    });
    const maxP = mode === 'pnl' && !analytics.maxProfitUnbounded && analytics.maxProfit > data.yLo && analytics.maxProfit < data.yHi
      ? placeLabel(`max profit ${usdTick(analytics.maxProfit)}`, [[pad.l + plotW - 4, Y(analytics.maxProfit) - 5, 'end']], placed, within) : null;
    const maxL = mode === 'pnl' && !analytics.maxLossUnbounded && analytics.maxLoss > data.yLo && analytics.maxLoss < data.yHi
      ? placeLabel(`max loss ${usdTick(analytics.maxLoss)}`, [[pad.l + plotW - 4, Y(analytics.maxLoss) + 13, 'end']], placed, within) : null;
    const be = mode === 'pnl' ? analytics.breakevens.filter(b => b > lo && b < hi).map(b => {
      const text = `B/E ${num(b, b >= 100 ? 1 : 2)}`;
      const x = X(b), yBelow = Math.min(y0 + 16, pad.t + plotH - 4), yAbove = Math.max(pad.t + 10, y0 - 12);
      return { b, text, ...placeLabel(text, [[x, yBelow, 'middle'], [x, yAbove, 'middle'], [x, yBelow + 13, 'middle'],
        [x, yAbove - 13, 'middle']], placed, within) };
    }) : [];
    const spotText = fmtValue(mode, spotVal);
    const sx = X(market.S), sy = Y(spotVal), flip = sx > width - 150;
    const dx = flip ? -10 : 10, a = flip ? 'end' as const : 'start' as const;
    const spot = placeLabel(spotText, [
      [sx + dx, Math.max(pad.t + 10, sy - 10), a], [sx + dx, sy + 18, a], [sx - dx, Math.max(pad.t + 10, sy - 10), flip ? 'start' : 'end'],
      [sx - dx, sy + 18, flip ? 'start' : 'end'], [sx + dx, sy - 24, a], [sx + dx, sy + 32, a],
    ], placed, { ...within, y0: pad.t - 2, y1: pad.t + plotH + 14 });
    return { strikeLabels, maxP, maxL, be, spot, spotText };
  })();

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
                  stroke={t === 0 ? 'var(--line-3)' : 'var(--line)'} opacity={t === 0 ? 1 : 0.55} />
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

        {strikes.map((k, i) => (
          <g key={`k${k}`}>
            <line x1={X(k)} x2={X(k)} y1={pad.t} y2={pad.t + plotH} stroke="var(--ink-4)" strokeDasharray="2 4" opacity={0.7} />
            <text x={labels.strikeLabels[i].x} y={labels.strikeLabels[i].y} textAnchor="middle" className={c.markerText}
                  fill="var(--ink-3)">{labels.strikeLabels[i].text}</text>
          </g>
        ))}

        {mode === 'pnl' && !analytics.maxProfitUnbounded && analytics.maxProfit > data.yLo && analytics.maxProfit < data.yHi && (
          <g>
            <line x1={pad.l} x2={pad.l + plotW} y1={Y(analytics.maxProfit)} y2={Y(analytics.maxProfit)}
                  stroke="var(--green)" strokeDasharray="5 5" opacity={0.55} />
            {labels.maxP && <text x={labels.maxP.x} y={labels.maxP.y} textAnchor="end" className={c.markerText}
                  fill="var(--green)">max profit {usdTick(analytics.maxProfit)}</text>}
          </g>
        )}
        {mode === 'pnl' && !analytics.maxLossUnbounded && analytics.maxLoss > data.yLo && analytics.maxLoss < data.yHi && (
          <g>
            <line x1={pad.l} x2={pad.l + plotW} y1={Y(analytics.maxLoss)} y2={Y(analytics.maxLoss)}
                  stroke="var(--red)" strokeDasharray="5 5" opacity={0.55} />
            {labels.maxL && <text x={labels.maxL.x} y={labels.maxL.y} textAnchor="end" className={c.markerText}
                  fill="var(--red)">max loss {usdTick(analytics.maxLoss)}</text>}
          </g>
        )}

        <g clipPath={`url(#${clip}-plot)`}>
          {data.expiry && (
            <path d={expD} fill="none" stroke="var(--ink-3)" strokeWidth={1.4} strokeDasharray="5 4"
                  data-testid="chart-expiry-path" />
          )}
          <path d={mainD} fill="none" stroke="var(--amber)" strokeWidth={2.2} strokeLinejoin="round" className={c.dataPath}
                data-testid="chart-main-path" />
        </g>

        {labels.be.map(l => (
          <g key={`be${l.b}`}>
            <circle cx={X(l.b)} cy={y0} r={3.5} fill="var(--bg)" stroke="var(--ink)" strokeWidth={1.5} />
            <text x={l.x} y={l.y} textAnchor={l.anchor} className={c.markerText} fill="var(--ink-2)">{l.text}</text>
          </g>
        ))}

        {market.S >= lo && market.S <= hi && (
          <g>
            <line x1={X(market.S)} x2={X(market.S)} y1={pad.t} y2={pad.t + plotH} stroke="var(--amber-2)" opacity={0.35} />
            <circle cx={X(market.S)} cy={Y(spotVal)} r={5} fill="var(--amber-2)" className={c.spotPulse} aria-hidden="true" />
            <circle cx={X(market.S)} cy={Y(spotVal)} r={5} fill="var(--amber-2)" stroke="var(--bg)" strokeWidth={2} />
            {hx == null && (
              <text x={labels.spot.x} y={labels.spot.y} textAnchor={labels.spot.anchor} className={c.markerText}
                    fill="var(--ink)" fontWeight={650}>{labels.spotText}</text>
            )}
          </g>
        )}

        {hx != null && hi2 != null && (
          <g pointerEvents="none">
            <line x1={X(hx)} x2={X(hx)} y1={pad.t} y2={pad.t + plotH} stroke="var(--amber-2)" opacity={0.75} className={c.crosshair} />
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
