'use client';

import { useState } from 'react';
import type { Dispatch } from 'react';
import { INSTRUMENTS, mkCustomInstrument } from '@/lib/market/instruments';
import type { Market, Smile } from '@/lib/quant/types';
import type { SmilePreset } from '@/lib/quant/volSurface';
import { clampSmile, SMILE_PRESETS } from '@/lib/quant/volSurface';
import { signedPct } from '@/lib/format';
import { Badge, Button, InfoTip, Segmented, SliderField } from '@/components/ui/primitives';
import { SmileChart } from './SmileChart';
import type { TerminalAction, TerminalState } from '@/components/terminal/useTerminalState';
import type { LiveData } from '@/components/terminal/useLiveData';
import b from './builder.module.css';

const snap = (v: number) => +v.toFixed(6);

/** Spot slider bounds: ±50% of the reference spot, aligned to the slider step so typed values land exactly. */
export function spotBounds(base: number, step: number): [number, number] {
  return [snap(Math.max(step, Math.floor((base * 0.5) / step) * step)), snap(Math.ceil((base * 1.5) / step) * step)];
}

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

const volPts = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d * 100).toFixed(1)} pts`;
const bps = (d: number) => `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d * 1e4).toFixed(0)} bp`;

const SMILE_CHOICES = ['Flat', 'Equity index', 'Single stock', 'Custom'] as const;
type SmileChoice = typeof SMILE_CHOICES[number];

/** Largest curvature on the slider grid that stays arbitrage-free for this skew: η ≤ 2 / (1 + |ρ|). */
const etaCap = (rho: number) => +(Math.floor(2 / (1 + Math.abs(rho)) / 0.05 + 1e-9) * 0.05).toFixed(2);

/** Slider-aligned smile parameters inside the arbitrage-free region. */
function snapSmile(s: Smile): Smile {
  const c = clampSmile({ rho: +s.rho.toFixed(2), eta: +s.eta.toFixed(2), gamma: s.gamma });
  return { ...c, eta: Math.min(c.eta, etaCap(c.rho)) };
}

export function MarketInputs({ state, dispatch, live }: {
  state: TerminalState; dispatch: Dispatch<TerminalAction>; live: LiveData;
}) {
  const { instrument: inst, market: m, base } = state;
  const [query, setQuery] = useState('');
  const [price, setPrice] = useState('');
  const [searchMsg, setSearchMsg] = useState('');
  const [searching, setSearching] = useState(false);
  const [lo, hi] = spotBounds(base.S, inst.step);
  const set = (patch: Partial<Market>) => dispatch({ type: 'market', patch });
  const changed = m.S !== base.S || m.sigma !== base.sigma || m.r !== base.r || m.q !== base.q;
  const all = [...INSTRUMENTS, ...state.searched];

  const [customSmile, setCustomSmile] = useState(false);
  const smile = m.smile;
  const presetName = smile
    ? (Object.keys(SMILE_PRESETS) as SmilePreset[]).find(k =>
        SMILE_PRESETS[k].rho === smile.rho && SMILE_PRESETS[k].eta === smile.eta && SMILE_PRESETS[k].gamma === smile.gamma)
    : undefined;
  const smileChoice: SmileChoice = !smile ? 'Flat' : customSmile || !presetName ? 'Custom' : presetName;
  const setSmile = (s: Smile | null) => set({ smile: s ? snapSmile(s) : null });
  const chooseSmile = (c: SmileChoice) => {
    setCustomSmile(c === 'Custom');
    if (c === 'Flat') setSmile(null);
    else if (c === 'Custom') setSmile(smile ?? { rho: -0.5, eta: 1, gamma: 0.45 });
    else setSmile(SMILE_PRESETS[c]);
  };

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
          : inst.custom
            ? <Badge tone="info" title="Price entered by you — no data feed">Manual price</Badge>
            : <Badge tone="muted" title="Indicative snapshot price — not a live quote">Snapshot</Badge>}
      </div>

      <form className={b.search} data-testid="ticker-form" onSubmit={async e => {
        e.preventDefault();
        const sym = query.trim().toUpperCase();
        if (live.mode === 'live') {
          setSearching(true);
          const err = await live.search(sym);
          setSearching(false);
          setSearchMsg(err ?? '');
          if (!err) setQuery('');
          return;
        }
        if (!TICKER_RE.test(sym)) { setSearchMsg('Enter a ticker symbol, e.g. AMD'); return; }
        const spot = parseFloat(price.replace(/[$,\s]/g, ''));
        if (!(spot > 0 && spot < 1_000_000)) { setSearchMsg(`Enter ${sym}’s current price (a positive number)`); return; }
        dispatch({ type: 'instrument', instrument: mkCustomInstrument(sym, spot) });
        setSearchMsg(''); setQuery(''); setPrice('');
      }}>
        <input className={b.searchInput} value={query} maxLength={10} data-testid="ticker-input"
               placeholder={live.mode === 'live' ? 'Any US ticker, e.g. AMD' : 'Any ticker, e.g. AMD'}
               aria-label="Ticker symbol" onChange={e => { setQuery(e.target.value); setSearchMsg(''); }} />
        {live.mode !== 'live' && (
          <input className={b.priceInput} value={price} inputMode="decimal" data-testid="ticker-price"
                 placeholder="Price" aria-label="Current price of the ticker"
                 onChange={e => { setPrice(e.target.value); setSearchMsg(''); }} />
        )}
        <Button size="sm" type="submit" data-testid="ticker-submit"
                disabled={searching || !query.trim() || (live.mode !== 'live' && !price.trim())}>
          {searching ? 'Loading…' : live.mode === 'live' ? 'Load' : 'Add'}
        </Button>
      </form>
      {searchMsg
        ? <p className={b.searchMsg} role="status" data-testid="ticker-msg">{searchMsg}</p>
        : <p className={b.searchHint}>
            {live.mode === 'live' ? 'Live quotes for any US ticker via the data proxy.'
              : 'Any ticker: enter its price — volatility starts at 30%, adjust below.'}
          </p>}

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
                     tip="Annualised implied volatility, flat across expiries. With a smile set below, this is the at-the-money volatility." />
        <SliderField label="Risk-free rate" symbol="r" value={m.r} min={0} max={0.15} step={0.0005}
                     format={v => `${(v * 100).toFixed(2)}%`} onChange={r => set({ r })}
                     testid="rate-input" displayTestid="rate-display" inputScale={100} inputDecimals={2}
                     delta={m.r !== base.r ? bps(m.r - base.r) : null} />
        <SliderField label="Dividend yield" symbol="q" value={m.q} min={0} max={0.08} step={0.0005}
                     format={v => `${(v * 100).toFixed(2)}%`} onChange={q => set({ q })}
                     testid="q-input" displayTestid="q-display" inputScale={100} inputDecimals={2}
                     delta={m.q !== base.q ? bps(m.q - base.q) : null}
                     tip="Continuous dividend yield (Black-Scholes-Merton). Used by the browser models and, when connected, by the C++ engine." />
      </div>

      <div className={b.smile} data-testid="smile-panel">
        <span className={b.smileTitle}>
          Volatility smile
          <InfoTip align="start" text="SSVI (Gatheral–Jacquier): every strike gets its own implied volatility, with parameters kept in the arbitrage-free region. σ above is the at-the-money volatility. Scenarios keep each strike's volatility when spot moves (sticky strike)." />
        </span>
        <Segmented size="sm" full label="Volatility smile" testid="smile" value={smileChoice}
                   options={SMILE_CHOICES.map(v => ({ value: v, label: v }))} onChange={chooseSmile} />
        {smile && (
          <div className={b.sliders} style={{ marginTop: 0 }}>
            <SliderField label="Skew" symbol="ρ" value={smile.rho} min={-0.95} max={0.95} step={0.05}
                         format={v => v.toFixed(2)} testid="smile-rho" displayTestid="smile-rho-display"
                         onChange={rho => { setCustomSmile(true); setSmile({ ...smile, rho }); }}
                         tip="Negative skew makes downside strikes richer than upside strikes, as in equity markets." />
            <SliderField label="Curvature" symbol="η" value={smile.eta} min={0.05} max={etaCap(smile.rho)} step={0.05}
                         format={v => v.toFixed(2)} testid="smile-eta" displayTestid="smile-eta-display"
                         onChange={eta => { setCustomSmile(true); setSmile({ ...smile, eta }); }}
                         tip="How fast volatility rises away from the money. Capped at 2 / (1 + |ρ|), the arbitrage-free limit." />
          </div>
        )}
        <SmileChart market={m} legs={state.legs} />
      </div>

      <div className={b.marketFoot}>
        <span className={b.subtle}>{changed ? 'Market moved from reference' : `Reference ${inst.sym} market`}</span>
        <Button size="sm" variant="ghost" disabled={!changed} data-testid="reset-market"
                onClick={() => dispatch({ type: 'resetMarket' })}>Reset</Button>
      </div>
    </div>
  );
}
