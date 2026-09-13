'use client';

import { useState } from 'react';
import type { Dispatch } from 'react';
import { INSTRUMENTS } from '@/lib/market/instruments';
import type { Market } from '@/lib/quant/types';
import { signedPct } from '@/lib/format';
import { Badge, Button, Segmented, SliderField } from '@/components/ui/primitives';
import type { TerminalAction, TerminalState } from '@/components/terminal/useTerminalState';
import type { LiveData } from '@/components/terminal/useLiveData';
import b from './builder.module.css';

const snap = (v: number) => +v.toFixed(6);

/** Spot slider bounds: ±50% of the reference spot, aligned to the slider step so typed values land exactly. */
export function spotBounds(base: number, step: number): [number, number] {
  return [snap(Math.max(step, Math.floor((base * 0.5) / step) * step)), snap(Math.ceil((base * 1.5) / step) * step)];
}

const volPts = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d * 100).toFixed(1)} pts`;
const bps = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d * 1e4).toFixed(0)} bp`;

export function MarketInputs({ state, dispatch, live }: {
  state: TerminalState; dispatch: Dispatch<TerminalAction>; live: LiveData;
}) {
  const { instrument: inst, market: m, base } = state;
  const [query, setQuery] = useState('');
  const [searchMsg, setSearchMsg] = useState('');
  const [searching, setSearching] = useState(false);
  const [lo, hi] = spotBounds(base.S, inst.step);
  const set = (patch: Partial<Market>) => dispatch({ type: 'market', patch });
  const changed = m.S !== base.S || m.sigma !== base.sigma || m.r !== base.r || m.q !== base.q;
  const all = [...INSTRUMENTS, ...state.searched];

  return (
    <div>
      <Segmented label="Underlying instrument" accent full testid="inst" value={inst.sym}
                 options={all.map(i => ({ value: i.sym, label: i.sym, title: i.name }))}
                 onChange={sym => {
                   const next = all.find(i => i.sym === sym);
                   if (next && sym !== inst.sym) dispatch({ type: 'instrument', instrument: next });
                 }} />
      <div className={b.instMeta}>
        <span className={b.instName} data-testid="instrument-name">{inst.name}</span>
        {live.mode === 'live' && inst.live
          ? <Badge tone="good" title="Live quote via the data proxy (Alpaca IEX) — indicative, not for execution">Live · IEX</Badge>
          : <Badge tone="muted" title="Indicative snapshot price — not a live quote">Snapshot</Badge>}
      </div>

      {live.mode === 'live' && (
        <form className={b.search} onSubmit={async e => {
          e.preventDefault();
          setSearching(true);
          const err = await live.search(query);
          setSearching(false);
          setSearchMsg(err ?? '');
          if (!err) setQuery('');
        }}>
          <input className={b.searchInput} value={query} maxLength={10} placeholder="Any US ticker, e.g. AMD"
                 aria-label="Load any US-listed ticker" onChange={e => { setQuery(e.target.value); setSearchMsg(''); }} />
          <Button size="sm" type="submit" disabled={searching || !query.trim()}>{searching ? 'Loading…' : 'Load'}</Button>
        </form>
      )}
      {searchMsg && <p className={b.searchMsg} role="status">{searchMsg}</p>}

      <div className={b.sliders}>
        <SliderField label="Spot" symbol="S" value={m.S} min={lo} max={hi} step={inst.step}
                     format={v => v.toFixed(2)} onChange={S => set({ S })}
                     testid="spot-input" displayTestid="spot-display" inputDecimals={2}
                     delta={m.S !== base.S ? signedPct(m.S / base.S - 1, 2) : null}
                     rangeLabels={[lo.toFixed(0), hi.toFixed(0)]} />
        <SliderField label="Volatility" symbol="σ" value={m.sigma} min={0.01} max={1.5} step={0.005}
                     format={v => `${(v * 100).toFixed(1)}%`} onChange={sigma => set({ sigma })}
                     testid="vol-input" displayTestid="vol-display" inputScale={100} inputDecimals={1}
                     delta={m.sigma !== base.sigma ? volPts(m.sigma - base.sigma) : null}
                     tip="Annualised implied volatility, flat across strikes and expiries (no skew)." />
        <SliderField label="Risk-free rate" symbol="r" value={m.r} min={0} max={0.15} step={0.0005}
                     format={v => `${(v * 100).toFixed(2)}%`} onChange={r => set({ r })}
                     testid="rate-input" displayTestid="rate-display" inputScale={100} inputDecimals={2}
                     delta={m.r !== base.r ? bps(m.r - base.r) : null} />
        <SliderField label="Dividend yield" symbol="q" value={m.q} min={0} max={0.08} step={0.0005}
                     format={v => `${(v * 100).toFixed(2)}%`} onChange={q => set({ q })}
                     testid="q-input" displayTestid="q-display" inputScale={100} inputDecimals={2}
                     delta={m.q !== base.q ? bps(m.q - base.q) : null}
                     tip="Continuous dividend yield (Merton). The C++ core prices without dividends, so q ≠ 0 moves all pricing to the browser." />
      </div>

      <div className={b.marketFoot}>
        <span className={b.subtle}>{changed ? 'Market moved from reference' : `Reference ${inst.sym} market`}</span>
        <Button size="sm" variant="ghost" disabled={!changed} data-testid="reset-market"
                onClick={() => dispatch({ type: 'resetMarket' })}>Reset</Button>
      </div>
    </div>
  );
}
