'use client';

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Greeks, Leg, Market } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import { atSpot } from '@/lib/quant/volSurface';
import { netPremium, pnlAtFirstExpiry, portfolioGreeks } from '@/lib/strategy/portfolio';
import { fixed, signed, usd, usdSigned } from '@/lib/format';
import type { ChartMode } from '@/components/terminal/useTerminalState';
import { cx, InfoTip } from '@/components/ui/primitives';
import c from './analytics.module.css';

export type CalcSourceKind = 'engine-stream' | 'engine-batch' | 'wasm' | 'browser';

export interface CalcSource { kind: CalcSourceKind; label: string; reason: string; }

export interface TileQuote {
  greeks: Greeks;      // per share for a single leg, aggregated $ / share-equivalents otherwise
  pnl: number;
  calcUs: number | null;
  perShare: boolean;
  source: CalcSource;
}

const SPARK_N = 28;

/** A 28-point sketch of each tile's quantity across the chart's spot range — the shape behind the number. */
function useSparks(legs: Leg[], market: Market, lo: number, hi: number) {
  return useMemo(() => {
    const pnl: number[] = [], delta: number[] = [], gamma: number[] = [], theta: number[] = [], vega: number[] = [];
    for (let i = 0; i <= SPARK_N; i++) {
      const S = lo + ((hi - lo) * i) / SPARK_N;
      const at = atSpot(market, S);
      const g = portfolioGreeks(legs, at);
      pnl.push(pnlAtFirstExpiry(legs, at));
      delta.push(g.delta);
      gamma.push(g.gamma);
      theta.push(g.theta / 365);
      vega.push(g.vega * 0.01);
    }
    return { pnl, delta, gamma, theta, vega };
  }, [legs, market, lo, hi]);
}

function Spark({ values, active }: { values: number[]; active: boolean }) {
  const lo = Math.min(...values, 0), hi = Math.max(...values, 0);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * 54 + 1;
  const y = (v: number) => 17 - ((v - lo) / span) * 15;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg width="56" height="19" viewBox="0 0 56 19" aria-hidden="true" className={c.tileSpark}>
      <line x1="0" x2="56" y1={y(0)} y2={y(0)} stroke="var(--line-2)" />
      <path d={d} fill="none" stroke={active ? 'var(--amber)' : 'var(--ink-4)'} strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function Tile({ label, testid, value, sub, tone, tip, raw, mode, active, onMode, spark }: {
  label: ReactNode; testid: string; value: string; sub?: string; tone?: 'pos' | 'neg'; tip?: string; raw: number;
  mode?: ChartMode; active?: boolean; onMode?: (m: ChartMode) => void; spark?: number[];
}) {
  const body = (
    <>
      <span className={c.tileLabel}>{label}{tip && <InfoTip text={tip} align="start" />}
        {spark && <Spark values={spark} active={!!active} />}
      </span>
      <span data-testid={testid} data-value={raw} className={cx(c.tileValue, tone)}>
        <span key={value} className="flash">{value}</span>
      </span>
      {sub && <span className={c.tileSub}>{sub}</span>}
    </>
  );
  if (!mode || !onMode) return <div className={c.tile}>{body}</div>;
  return (
    <button type="button" className={cx(c.tile, c.tileButton, active && c.tileActive)} aria-pressed={active}
            data-testid={`chart-mode-${mode}`} onClick={() => onMode(mode)}
            title={`Chart this across spot — ${typeof label === 'string' ? label : mode}`}>
      {body}
    </button>
  );
}

/**
 * Price and Greeks, and the switch for what the payoff chart draws: clicking Δ charts delta across
 * spot, clicking Vega charts vega. Each tile carries the shape of its own curve, so the row reads as
 * the position's whole profile rather than six unrelated numbers.
 */
export function SummaryTiles({ quote, legs, market, spotRange, mode, onMode }: {
  quote: TileQuote; legs: Leg[]; market: Market; spotRange: [number, number];
  mode: ChartMode; onMode: (m: ChartMode) => void;
}) {
  const g = quote.greeks;
  const spark = useSparks(legs, market, spotRange[0], spotRange[1]);
  const pnlTone = quote.pnl > 0.5 ? 'pos' : quote.pnl < -0.5 ? 'neg' : undefined;
  // whole dollars; `|| 0` turns a rounded −0 (a hair below zero) into 0 so it never renders as "-0"
  const pnlWhole = Math.round(quote.pnl) || 0;
  const single = quote.perShare && legs.length === 1 ? legs[0] : null;
  const w = single ? signedQty(single) * M : 1;

  return (
    <div className={c.tiles} role="group" aria-label="Price and Greeks — each tile charts its own curve">
      {single ? (
        <Tile label="Price" testid="price" value={fixed(g.price, 3)} raw={g.price}
              sub={`${single.side === 'buy' ? 'long' : 'short'} ${single.qty}× · ${usd(w * g.price)}`}
              tip="Black-Scholes value per share of the option. A contract is 100 shares." />
      ) : (
        <Tile label="Net value" testid="price" value={usd(g.price)} raw={g.price}
              sub={`${legs.length} legs · mark to model`}
              tip="Sum of signed leg values at the current market (qty × 100 × price)." />
      )}
      <Tile label="Delta Δ" testid="delta" mode="delta" active={mode === 'delta'} onMode={onMode} spark={spark.delta}
            value={single ? fixed(g.delta, 4) : `${signed(g.delta, 0)} sh`} raw={g.delta}
            sub={single ? `position ${signed(w * g.delta, 0)} sh` : `$Δ ${usdSigned(g.delta * market.S)}`}
            tip="Change in value per $1 move in spot; position delta is in share-equivalents." />
      <Tile label="Gamma Γ" testid="gamma" mode="gamma" active={mode === 'gamma'} onMode={onMode} spark={spark.gamma}
            value={single ? fixed(g.gamma, 5) : signed(g.gamma, 2)} raw={g.gamma}
            sub={single ? `position ${signed(w * g.gamma, 2)} / $1` : 'Δ shares per $1'}
            tip="Change in delta per $1 move in spot." />
      <Tile label="Theta / day" testid="theta" mode="theta" active={mode === 'theta'} onMode={onMode} spark={spark.theta}
            value={single ? fixed(g.theta / 365, 4) : usdSigned(g.theta / 365)} raw={g.theta / 365}
            sub={single ? `position ${usdSigned((w * g.theta) / 365)}/d` : 'calendar-day decay'}
            tip="Time decay per calendar day (annual theta ÷ 365)." />
      <Tile label={<>Vega <span className={c.tileSym}>ν</span></>} testid="vega" mode="vega" active={mode === 'vega'}
            onMode={onMode} spark={spark.vega}
            value={single ? fixed(g.vega, 3) : usdSigned(g.vega * 0.01)} raw={single ? g.vega : g.vega * 0.01}
            sub={single ? `position ${usdSigned(w * g.vega * 0.01)} / vol pt` : 'per +1 vol point'}
            tip="Change in value per 1 vol point of implied volatility." />
      <Tile label="P&L" testid="pnl" mode="pnl" active={mode === 'pnl'} onMode={onMode} spark={spark.pnl}
            value={single ? `${pnlWhole >= 0 ? '+' : ''}${pnlWhole}` : usdSigned(quote.pnl)} raw={quote.pnl} tone={pnlTone}
            sub={single ? `entry ${single.premium.toFixed(2)} / sh` : `net premium ${usdSigned(-netPremium(legs))}`}
            tip="Mark-to-model value minus the premium paid (or plus the premium received)." />
    </div>
  );
}
