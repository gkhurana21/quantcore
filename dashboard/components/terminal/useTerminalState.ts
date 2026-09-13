'use client';

// Terminal state: underlying, market inputs, strategy legs and view selection.
// Derived analytics are computed from this state with useMemo in the views, so
// the reducer holds only user intent.

import { useReducer } from 'react';
import { bsPrice } from '@/lib/quant/blackScholes';
import type { Leg, Market } from '@/lib/quant/types';
import type { Instrument } from '@/lib/market/instruments';
import { CANONICAL, INSTRUMENTS } from '@/lib/market/instruments';
import type { PresetName } from '@/lib/strategy/presets';
import {
  atmStrike, buildPreset, canonicalLeg, DEFAULT_QTY, DEFAULT_T, makeLeg, MAX_LEGS,
} from '@/lib/strategy/presets';

export const TABS = [
  { id: 'lab', label: 'Pricing Models Lab' },
  { id: 'mc', label: 'Monte Carlo' },
  { id: 'stress', label: 'Stress Lab' },
  { id: 'risk', label: 'Risk / VaR' },
  { id: 'engine', label: 'C++ Engine' },
] as const;
export type TabId = typeof TABS[number]['id'];

export const CHART_MODES = [
  { id: 'pnl', label: 'P&L', title: 'Profit and loss ($)' },
  { id: 'delta', label: 'Δ', title: 'Delta (share-equivalents)' },
  { id: 'gamma', label: 'Γ', title: 'Gamma (Δ shares per $1 move)' },
  { id: 'vega', label: 'Vega', title: 'Vega ($ per 1 vol point)' },
  { id: 'theta', label: 'Θ', title: 'Theta ($ per calendar day)' },
] as const;
export type ChartMode = typeof CHART_MODES[number]['id'];

export type PresetId = PresetName | 'Custom';

export interface LegsSource { kind: 'preset' | 'custom' | 'import' | 'stress'; label: string; }

export interface StressBackup { market: Market; legs: Leg[]; preset: PresetId; source: LegsSource; }

export interface TerminalState {
  instrument: Instrument;
  searched: Instrument[];        // tickers loaded through the live data proxy
  base: Market;                  // market at instrument selection — "reset" target
  market: Market;
  legs: Leg[];
  preset: PresetId;
  source: LegsSource;
  tab: TabId;
  visited: TabId[];
  chartMode: ChartMode;
  stressBackup: StressBackup | null;
}

export type TerminalAction =
  | { type: 'instrument'; instrument: Instrument }
  | { type: 'liveQuote'; instrument: Instrument }
  | { type: 'market'; patch: Partial<Market> }
  | { type: 'resetMarket' }
  | { type: 'preset'; name: PresetName }
  | { type: 'updateLeg'; id: string; patch: Partial<Omit<Leg, 'id'>> }
  | { type: 'addLeg' }
  | { type: 'removeLeg'; id: string }
  | { type: 'setExpiry'; T: number }
  | { type: 'importLegs'; legs: Leg[]; label: string }
  | { type: 'tab'; tab: TabId }
  | { type: 'chartMode'; mode: ChartMode }
  | { type: 'stressApply'; market: Market; legs: Leg[]; label: string }
  | { type: 'stressRestore' };

const reprice = (l: Leg, m: Market): Leg =>
  ({ ...l, premium: bsPrice(l.call, m.S, l.K, l.T, m.sigma, m.r, m.q) });

export function initialTerminalState(): TerminalState {
  const spy = INSTRUMENTS[0];
  const market: Market = { S: CANONICAL.S, sigma: CANONICAL.sigma, r: CANONICAL.r, q: 0 };
  return {
    instrument: spy, searched: [], base: market, market,
    legs: [canonicalLeg()], preset: 'Long Call', source: { kind: 'preset', label: 'Long Call' },
    tab: 'lab', visited: ['lab'], chartMode: 'pnl', stressBackup: null,
  };
}

function selectInstrument(st: TerminalState, inst: Instrument): TerminalState {
  const market: Market = { S: inst.spot, sigma: inst.vol, r: st.market.r, q: inst.q };
  const preset: PresetName = st.preset === 'Custom' ? 'Long Call' : st.preset;
  const searched = (inst.live || inst.custom) && !INSTRUMENTS.some(i => i.sym === inst.sym)
    ? [...st.searched.filter(i => i.sym !== inst.sym), inst] : st.searched;
  return {
    ...st, instrument: inst, searched, base: market, market,
    legs: buildPreset(preset, inst, market), preset,
    source: { kind: 'preset', label: preset }, stressBackup: null,
  };
}

export function terminalReducer(st: TerminalState, a: TerminalAction): TerminalState {
  switch (a.type) {
    case 'instrument':
      return selectInstrument(st, a.instrument);

    case 'liveQuote': {
      if (a.instrument.sym !== st.instrument.sym) return st;
      if (st.preset === 'Custom') {
        const market = { ...st.market, S: a.instrument.spot };
        return { ...st, instrument: a.instrument, base: { ...st.base, S: a.instrument.spot }, market };
      }
      return selectInstrument(st, a.instrument);
    }

    case 'market':
      return { ...st, market: { ...st.market, ...a.patch } };

    case 'resetMarket':
      return { ...st, market: { ...st.base } };

    case 'preset':
      return { ...st, legs: buildPreset(a.name, st.instrument, st.market), preset: a.name,
               source: { kind: 'preset', label: a.name }, stressBackup: null };

    case 'updateLeg': {
      const legs = st.legs.map(l => {
        if (l.id !== a.id) return l;
        const next: Leg = { ...l, ...a.patch };
        const terms = 'call' in a.patch || 'K' in a.patch || 'T' in a.patch;
        return terms && !('premium' in a.patch) ? reprice(next, st.market) : next;
      });
      return { ...st, legs, preset: 'Custom', source: { kind: 'custom', label: 'Custom' } };
    }

    case 'addLeg': {
      if (st.legs.length >= MAX_LEGS) return st;
      const last = st.legs[st.legs.length - 1];
      const leg = makeLeg(true, 'buy', atmStrike(st.market.S, st.instrument.kstep),
                          last?.T ?? DEFAULT_T, last?.qty ?? DEFAULT_QTY, st.market);
      return { ...st, legs: [...st.legs, leg], preset: 'Custom', source: { kind: 'custom', label: 'Custom' } };
    }

    case 'removeLeg':
      if (st.legs.length <= 1) return st;
      return { ...st, legs: st.legs.filter(l => l.id !== a.id), preset: 'Custom',
               source: { kind: 'custom', label: 'Custom' } };

    case 'setExpiry':
      return { ...st, legs: st.legs.map(l => reprice({ ...l, T: a.T }, st.market)),
               preset: st.preset, source: st.source.kind === 'preset' ? st.source : { kind: 'custom', label: 'Custom' } };

    case 'importLegs':
      return { ...st, legs: a.legs.slice(0, MAX_LEGS), preset: 'Custom',
               source: { kind: 'import', label: a.label }, stressBackup: null };

    case 'tab':
      return { ...st, tab: a.tab, visited: st.visited.includes(a.tab) ? st.visited : [...st.visited, a.tab] };

    case 'chartMode':
      return { ...st, chartMode: a.mode };

    case 'stressApply':
      return {
        ...st,
        stressBackup: st.stressBackup ?? { market: st.market, legs: st.legs, preset: st.preset, source: st.source },
        market: a.market, legs: a.legs, source: { kind: 'stress', label: a.label },
      };

    case 'stressRestore':
      if (!st.stressBackup) return st;
      return { ...st, market: st.stressBackup.market, legs: st.stressBackup.legs,
               preset: st.stressBackup.preset, source: st.stressBackup.source, stressBackup: null };
  }
}

export function useTerminalState() {
  return useReducer(terminalReducer, undefined, initialTerminalState);
}

/** The exact state in which the C++ engine's streaming subscription is authoritative. */
export function isCanonicalPosition(st: Pick<TerminalState, 'instrument' | 'legs' | 'market'>): boolean {
  if (st.instrument.sym !== CANONICAL.sym || st.legs.length !== 1) return false;
  const l = st.legs[0], c = canonicalLeg();
  return l.call && l.side === 'buy' && l.K === c.K && Math.abs(l.T - c.T) < 1e-12 &&
         l.qty === c.qty && Math.abs(l.premium - c.premium) < 1e-9;
}
