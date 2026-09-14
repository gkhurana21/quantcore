'use client';

import type { ReactNode } from 'react';
import type { Greeks, Leg } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import type { PayoffAnalytics } from '@/lib/strategy/portfolio';
import { grossPremium, netPremium } from '@/lib/strategy/portfolio';
import { days, fixed, num, signed, usd, usdSigned } from '@/lib/format';
import { InfoTip } from '@/components/ui/primitives';
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

function Tile({ label, testid, value, sub, tone, tip, raw }: {
  label: ReactNode; testid: string; value: string; sub?: string; tone?: 'pos' | 'neg'; tip?: string; raw: number;
}) {
  return (
    <div className={c.tile}>
      <div className={c.tileLabel}>{label}{tip && <InfoTip text={tip} align="start" />}</div>
      <div data-testid={testid} data-value={raw} className={`${c.tileValue} ${tone ?? ''}`}>
        <span key={value} className="flash">{value}</span>
      </div>
      {sub && <div className={c.tileSub}>{sub}</div>}
    </div>
  );
}

export function SummaryTiles({ quote, legs, spot }: { quote: TileQuote; legs: Leg[]; spot: number }) {
  const g = quote.greeks;
  const pnlTone = quote.pnl > 0.5 ? 'pos' : quote.pnl < -0.5 ? 'neg' : undefined;
  // whole dollars; `|| 0` turns a rounded −0 (a hair below zero) into 0 so it never renders as "-0"
  const pnlWhole = Math.round(quote.pnl) || 0;

  if (quote.perShare && legs.length === 1) {
    const l = legs[0], w = signedQty(l) * M;
    const pos = `${l.side === 'buy' ? 'long' : 'short'} ${l.qty}× `;
    return (
      <div className={c.tiles}>
        <Tile label="Price" testid="price" value={fixed(g.price, 3)} raw={g.price}
              sub={`${pos}· ${usd(w * g.price)}`}
              tip="Black-Scholes value per share of the option. A contract is 100 shares." />
        <Tile label="Delta Δ" testid="delta" value={fixed(g.delta, 4)} raw={g.delta}
              sub={`position ${signed(w * g.delta, 0)} sh`}
              tip="Change in option price per $1 move in spot. Position delta is in share-equivalents." />
        <Tile label="Gamma Γ" testid="gamma" value={fixed(g.gamma, 5)} raw={g.gamma}
              sub={`position ${signed(w * g.gamma, 2)} / $1`}
              tip="Change in delta per $1 move in spot." />
        <Tile label="Theta / day" testid="theta" value={fixed(g.theta / 365, 4)} raw={g.theta / 365}
              sub={`position ${usdSigned((w * g.theta) / 365)}/d`}
              tip="Time decay per calendar day (annual theta ÷ 365)." />
        <Tile label={<>Vega <span className={c.tileSym}>ν</span></>} testid="vega" value={fixed(g.vega, 3)} raw={g.vega}
              sub={`position ${usdSigned(w * g.vega * 0.01)} / vol pt`}
              tip="Change in price per 1.00 (100 vol points) change in volatility." />
        <Tile label="P&L" testid="pnl" value={`${pnlWhole >= 0 ? '+' : ''}${pnlWhole}`} raw={quote.pnl}
              tone={pnlTone} sub={`entry ${l.premium.toFixed(2)} / sh`}
              tip="Mark-to-model value minus premium paid (or plus premium received), in dollars." />
      </div>
    );
  }

  return (
    <div className={c.tiles}>
      <Tile label="Net value" testid="price" value={usd(g.price)} raw={g.price}
            sub={`${legs.length} legs · mark to model`}
            tip="Sum of signed leg values at the current market (qty × 100 × price)." />
      <Tile label="Net Δ" testid="delta" value={`${signed(g.delta, 0)} sh`} raw={g.delta}
            sub={`$Δ ${usdSigned(g.delta * spot)}`}
            tip="Portfolio delta in share-equivalents; $Δ = Δ × spot." />
      <Tile label="Net Γ" testid="gamma" value={signed(g.gamma, 2)} raw={g.gamma}
            sub="Δ shares per $1" tip="Change in portfolio delta per $1 move in spot." />
      <Tile label="Θ / day" testid="theta" value={usdSigned(g.theta / 365)} raw={g.theta / 365}
            sub="calendar-day decay" tip="Portfolio time decay per calendar day." />
      <Tile label="Vega / vol pt" testid="vega" value={usdSigned(g.vega * 0.01)} raw={g.vega * 0.01}
            sub="per +1 vol point" tip="Portfolio P&L for a 1 vol point rise in implied volatility." />
      <Tile label="P&L" testid="pnl" value={usdSigned(quote.pnl)} raw={quote.pnl} tone={pnlTone}
            sub={`net premium ${usdSigned(-netPremium(legs))}`}
            tip="Portfolio value minus net premium paid." />
    </div>
  );
}

export function PositionFacts({ legs, analytics, spotDollarDelta }: {
  legs: Leg[]; analytics: PayoffAnalytics; spotDollarDelta: number;
}) {
  const net = netPremium(legs);
  const be = analytics.breakevens;
  const dte = days(analytics.horizonT);
  return (
    <div className={c.facts}>
      <div className={c.fact}>
        <span className={c.factLabel}>{net >= 0 ? 'Net debit' : 'Net credit'}</span>
        <span className={c.factValue} data-testid="net-premium" data-value={net}>{usd(Math.abs(net))}</span>
      </div>
      <div className={c.fact}>
        <span className={c.factLabel}>Max profit</span>
        <span className={`${c.factValue} pos`} data-testid="max-profit"
              data-value={analytics.maxProfitUnbounded ? 'unbounded' : analytics.maxProfit}>
          {analytics.maxProfitUnbounded ? 'Unlimited' : usdSigned(analytics.maxProfit)}
        </span>
      </div>
      <div className={c.fact}>
        <span className={c.factLabel}>Max loss</span>
        <span className={`${c.factValue} neg`} data-testid="max-loss"
              data-value={analytics.maxLossUnbounded ? 'unbounded' : analytics.maxLoss}>
          {analytics.maxLossUnbounded ? 'Unlimited' : usdSigned(analytics.maxLoss)}
        </span>
      </div>
      <div className={c.fact}>
        <span className={c.factLabel}>Break-even{be.length === 1 ? '' : 's'}</span>
        <span className={c.factValue} data-testid="breakevens" data-count={be.length}>
          {be.length ? be.map(b => num(b, 2)).join(' · ') : '—'}
        </span>
      </div>
      <div className={c.fact}>
        <span className={c.factLabel}>$ delta</span>
        <span className={c.factValue}>{usdSigned(spotDollarDelta)}</span>
      </div>
      <div className={c.fact}>
        <span className={c.factLabel}>Gross premium</span>
        <span className={c.factValue}>{usd(grossPremium(legs))}</span>
      </div>
      <div className={c.fact}>
        <span className={c.factLabel}>{analytics.exact ? 'At expiry' : 'At first expiry'}</span>
        <span className={c.factValue}>{dte}d{analytics.exact ? '' : ' · later legs at model value'}</span>
      </div>
    </div>
  );
}
