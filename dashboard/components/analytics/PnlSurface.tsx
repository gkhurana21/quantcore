'use client';

import { memo, useMemo } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { pnlSurface, SPOT_SHOCKS, VOL_SHOCKS } from '@/lib/risk/surface';
import { num, pct } from '@/lib/format';
import c from './analytics.module.css';

const label = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(0)}%`;

/** Spot × vol P&L grid by full revaluation (every leg repriced in every cell). */
export const PnlSurface = memo(function PnlSurface({ legs, market }: { legs: Leg[]; market: Market }) {
  const grid = useMemo(() => pnlSurface(legs, market), [legs, market]);
  const maxAbs = Math.max(1, ...grid.flat().map(Math.abs));

  return (
    <div>
      <div className={c.surfaceWrap}>
        <table data-testid="pnl-surface" className={c.surface}
               aria-label="P&L in dollars by spot shock (rows) and relative volatility shock (columns)">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Spot shock</span>ΔS \ Δσ</th>
              {VOL_SHOCKS.map(v => (
                <th key={v} scope="col" title={`σ = ${pct(market.sigma * (1 + v))}`}>{label(v)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SPOT_SHOCKS.map((ds, ri) => (
              <tr key={ds}>
                <th scope="row" title={`S = ${num(market.S * (1 + ds), 2)}`}>{label(ds)}</th>
                {VOL_SHOCKS.map((dv, ci) => {
                  const v = grid[ri][ci];
                  const mag = Math.min(1, Math.abs(v) / maxAbs);
                  const a = 0.05 + 0.6 * Math.sqrt(mag);
                  const bg = Math.abs(v) < 0.5 ? 'rgba(255,255,255,0.03)'
                    : v > 0 ? `rgba(76,203,141,${a.toFixed(3)})` : `rgba(240,106,110,${a.toFixed(3)})`;
                  const text = `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(0)}`;
                  return (
                    <td key={ci} data-testid={`pnl-${ri}-${ci}`}
                        className={ds === 0 && dv === 0 ? c.surfaceCenter : undefined}
                        style={{ background: bg, color: mag > 0.55 ? '#0b0c0e' : undefined, fontWeight: mag > 0.55 ? 650 : undefined }}
                        title={`Spot ${label(ds)} (S ${num(market.S * (1 + ds), 2)}), vol ${label(dv)} (σ ${pct(market.sigma * (1 + dv))}): ${text} USD`}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={c.surfaceFoot}>
        <span>loss</span><span className={c.surfaceScale} aria-hidden="true" /><span>gain</span>
        <span style={{ marginLeft: 'auto' }}>
          Full revaluation · vol shocks are relative to {market.term ? '30-day ATM ' : market.smile ? 'ATM ' : ''}σ {pct(market.sigma)}
          {market.smile && market.term ? ' (smile kept sticky strike, term structure scaled)'
            : market.smile ? ' (smile kept, sticky strike)' : market.term ? ' (term structure scaled)' : ''} · outlined cell = current
        </span>
      </div>
    </div>
  );
});
