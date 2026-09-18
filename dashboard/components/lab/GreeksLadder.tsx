'use client';

// Greeks by strike, solved on the terminal's own surface.
//
// The card exists for one contrast. The solver's vega bumps the whole surface's level, so the smile rides along and
// every strike's implied volatility moves with it; Black-Scholes vega at a strike's own σ(K, T) assumes that strike
// moves alone. Under a skewed surface those are different shapes: the ratio falls away with strike, largest in the
// downside wing where the skew is steepest and smallest where the smile has flattened out of the money. How far it
// travels, and whether it crosses 1 at all, depends on the expiry — so the card reports what it measured rather than
// asserting a shape. With no skew the two coincide, which is what shows the difference belongs to the surface rather
// than to the bump; the C++ gate pins that flat case against the closed form.

import { memo, useMemo, useRef } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { bsGreeks } from '@/lib/quant/blackScholes';
import { hasVolSurface, legSigma } from '@/lib/quant/volSurface';
import type { PdeItem } from '@/lib/engine/usePdeBatch';
import { usePdeBatch } from '@/lib/engine/usePdeBatch';
import { PDE_GRID } from '@/lib/engine/wasm';
import type { WasmEngine } from '@/lib/engine/useWasmEngine';
import { marketKeyOf } from '@/lib/strategy/labels';
import { num, pct } from '@/lib/format';
import { linear, niceTicks } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import { cx, ui } from '@/components/ui/primitives';
import { fmtMs } from '@/components/lab/labFormat';
import l from '@/components/lab/lab.module.css';

/** Strikes across the ladder. Each carries a vega, so each point is three solves. */
const POINTS = 16;
/** Half-width in standard deviations, and the share of spot it is clamped to at very short and very long expiries. */
const SPAN_SD = 2.5;
const SPAN_CLAMP = { min: 0.08, max: 0.45 };
/** A point counts towards the headline ratio only if its vega is this share of the ladder's largest. */
const MATERIAL = 0.02;

interface Point {
  K: number; sigmaK: number;
  model: number;      // ∂V/∂σ with the whole surface shifting
  bs: number;         // Black-Scholes vega at this strike's own implied volatility
  delta: number; gamma: number;
}

/**
 * Strikes spanning a few standard deviations either side of spot rather than a fixed share of it: at 47 days a fixed
 * ±30% reaches five standard deviations out, where both vegas are numerically zero and their ratio is noise.
 */
function strikesFor(S: number, sd: number): number[] {
  const span = Math.min(SPAN_CLAMP.max, Math.max(SPAN_CLAMP.min, SPAN_SD * sd));
  const lo = S * (1 - span), hi = S * (1 + span);
  return Array.from({ length: POINTS }, (_, i) => lo + ((hi - lo) * i) / (POINTS - 1));
}

const LadderChart = memo(function LadderChart({ points, spot, surface }: {
  points: Point[]; spot: number; surface: boolean;
}) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 640);
  const height = 230;
  const pad = { l: 60, r: 16, t: 14, b: 32 };
  const lo = points[0].K, hi = points[points.length - 1].K;
  const top = Math.max(...points.flatMap(p => [p.model, p.bs])) * 1.08 || 1;
  const X = linear(lo, hi, pad.l, width - pad.r);
  const Y = linear(0, top, height - pad.b, pad.t);
  const path = (pick: (p: Point) => number) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${X(p.K).toFixed(1)},${Y(pick(p)).toFixed(1)}`).join('');

  return (
    <div ref={wrap} data-testid="lab-ladder-chart" data-points={points.length}>
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Vega by strike from ${pct(lo / spot, 0)} to ${pct(hi / spot, 0)} of spot: the value's sensitivity to the whole surface shifting, against Black-Scholes vega at each strike's own implied volatility. ${surface ? 'Under the skewed surface the two differ in shape, the ratio falling away as the strike rises.' : 'With no skew the two coincide.'}`}>
        {niceTicks(0, top, 4).map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={l.axis}>{num(t, 0)}</text>
          </g>
        ))}
        {niceTicks((lo / spot) * 100, (hi / spot) * 100, 5).map(t => (
          <text key={t} x={X((t / 100) * spot)} y={height - 10} textAnchor="middle" className={l.axis}>
            {t === 100 ? 'spot' : `${t}%`}
          </text>
        ))}
        <line x1={X(spot)} x2={X(spot)} y1={pad.t} y2={height - pad.b} stroke="var(--ink-4)" strokeDasharray="2 3" />
        <path d={path(p => p.bs)} fill="none" stroke="var(--blue)" strokeWidth={1.4} strokeDasharray="5 3" />
        <path d={path(p => p.model)} fill="none" stroke="var(--amber-2)" strokeWidth={1.8} />
      </svg>
      <div className={l.legend} aria-hidden="true">
        <span><i className={l.sw} style={{ background: 'var(--amber-2)' }} />Surface shifts (solver)</span>
        <span><i className={l.swDash} style={{ borderColor: 'var(--blue)' }} />Black-Scholes at σ(K, T)</span>
        <span>x: strike as a share of spot · y: ∂V/∂σ per 1.00 of volatility</span>
      </div>
    </div>
  );
});

export function GreeksLadder({ legs, market, wasm, active }: {
  legs: Leg[]; market: Market; wasm: WasmEngine; active: boolean;
}) {
  const surface = hasVolSurface(market);
  const leg = legs.find(x => x.T > 0 && x.K > 0) ?? null;
  const T = leg?.T ?? 0;
  const strikes = useMemo(
    () => (T > 0 ? strikesFor(market.S, legSigma(market, market.S, T) * Math.sqrt(T)) : []),
    [T, market]);

  // one European call per strike, each asking for vega: three solves apiece, so the ladder is the card's whole cost
  const items = useMemo((): PdeItem[] => strikes.map(K => ({
    spec: { kind: 'european', call: true, K, T, vega: true }, market,
  })), [strikes, T, market]);
  const key = `ladder|${T}|${marketKeyOf(market)}`;
  const batch = usePdeBatch(wasm, active && T > 0 ? items : null, key);
  const { result: batchResult, current: batchCurrent } = batch;

  const points = useMemo((): Point[] => {
    const res = batchCurrent ? batchResult?.results : undefined;
    if (!res) return [];
    return strikes.flatMap((K, i): Point[] => {
      const r = res[i];
      if (!r) return [];
      const sigmaK = legSigma(market, K, T);
      return [{ K, sigmaK, model: r.vega, delta: r.delta, gamma: r.gamma,
                bs: bsGreeks(true, market.S, K, T, sigmaK, market.r, market.q).vega }];
    });
  }, [batchCurrent, batchResult, strikes, market, T]);

  // Far enough out of the money both vegas go to zero, and their ratio is then noise over a vanishing denominator.
  // Only points carrying real vega say anything about the two definitions, so only they set the headline's range.
  const peak = points.reduce((a, p) => Math.max(a, p.bs), 0);
  const material = (p: Point) => p.bs > MATERIAL * peak;
  const scored = points.filter(material).map(p => ({ p, r: p.model / p.bs }));
  const loPt = scored.reduce((a, b) => (b.r < a.r ? b : a), scored[0]);
  const hiPt = scored.reduce((a, b) => (b.r > a.r ? b : a), scored[0]);
  const lo = scored.length ? loPt.r : 0;
  const hi = scored.length ? hiPt.r : 0;
  // Which end travels further from 1 is a property of the surface and the expiry — at 47 days it is the upside, at
  // six months the whole ladder can sit above 1 — so the headline reads it off the ladder instead of claiming a wing.
  const far = scored.length ? (Math.abs(1 - lo) > Math.abs(1 - hi) ? loPt.p : hiPt.p) : null;
  const status = wasm.status === 'loading' ? 'Loading the C++ WebAssembly engine…'
    : wasm.status === 'unavailable' ? 'WebAssembly could not load, so the finite-difference solver is unavailable.'
    : batch.error ? `Finite differences failed: ${batch.error}` : null;

  if (!leg) return null;

  return (
    <div className={l.card} style={{ marginTop: 14 }} data-testid="lab-ladder">
      <div className={l.cardHead}>
        <span className={l.cardTitle}>Vega by strike · {Math.round(T * 365)} days</span>
        <span className={l.cardMeta}>
          {batch.busy ? 'solving…'
            : batch.result ? `C++ WebAssembly · BDF2 ${PDE_GRID.nodes} × ${PDE_GRID.steps} · ${batch.result.results.length * 3} solves in ${fmtMs(batch.result.ms)}`
            : ''}
        </span>
      </div>
      {status ? <p className={ui.note}>{status}</p> : !points.length ? (
        <p className={ui.note}>Solving a ladder of strikes on a finite-difference grid…</p>
      ) : (
        <div className={cx(!batch.current && l.stale)}>
          <div className={l.headline}>
            <span data-testid="lab-ladder-headline" data-ratio-lo={lo} data-ratio-hi={hi}>
              {surface
                ? <>Shifting the whole surface a volatility point is worth between <b className="mono">{num(lo, 2)}×</b> and{' '}
                    <b className="mono">{num(hi, 2)}×</b> what Black-Scholes vega at each strike’s own implied volatility
                    suggests — the level carries the smile with it, and the two part company most at{' '}
                    <b className="mono">{far ? pct(far.K / market.S, 0) : '—'}</b> of spot.</>
                : <>With no skew the two definitions coincide: the ratio stays within{' '}
                    <b className="mono">{num(Math.max(Math.abs(1 - lo), Math.abs(1 - hi)), 4)}</b> of 1 across the ladder.</>}
            </span>
          </div>
          <LadderChart points={points} spot={market.S} surface={surface} />
          <div className={ui.tableWrap} style={{ marginTop: 10 }}>
            <table className={ui.table} data-testid="lab-ladder-table">
              <thead>
                <tr>
                  <th>Strike</th>
                  <th className={ui.num}>σ(K, T)</th>
                  <th className={ui.num}>ν · surface shifts</th>
                  <th className={ui.num}>ν · Black-Scholes</th>
                  <th className={ui.num}>Ratio</th>
                  <th className={ui.num}>Δ</th>
                  <th className={ui.num}>Γ</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => (
                  <tr key={p.K} data-testid={`lab-ladder-row-${i}`} data-model={p.model} data-bs={p.bs}>
                    <td className="mono">{num(p.K, 2)}<span className={l.valueSub}>{pct(p.K / market.S, 1)} of spot</span></td>
                    <td className={ui.num}>{pct(p.sigmaK, 2)}</td>
                    <td className={ui.num}>{num(p.model, 3)}</td>
                    <td className={ui.num}>{num(p.bs, 3)}</td>
                    <td className={ui.num}>{material(p) ? `${num(p.model / p.bs, 3)}×` : '—'}</td>
                    <td className={ui.num}>{num(p.delta, 4)}</td>
                    <td className={ui.num}>{num(p.gamma, 5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={ui.note} style={{ marginTop: 8 }}>
            Every point is a European call at that strike on the leg’s expiry, solved by finite differences on the
            surface. Vega is not a grid derivative: it is the price re-solved with the surface’s level bumped either
            side, so the smile and term structure move with it. Black-Scholes vega instead holds the surface still and
            moves one strike’s volatility alone, which is why the two only agree when there is no skew.
          </p>
        </div>
      )}
    </div>
  );
}
