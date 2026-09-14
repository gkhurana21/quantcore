'use client';

import { Fragment } from 'react';
import type { Instrument } from '@/lib/market/instruments';
import type { Market } from '@/lib/quant/types';
import type { EngineStatus, OfflineReason } from '@/lib/engine/useEngine';
import type { WasmStatus } from '@/lib/engine/useWasmEngine';
import { num, pct, usdSigned } from '@/lib/format';
import type { DataMode } from '@/components/terminal/useLiveData';
import type { TabId } from '@/components/terminal/useTerminalState';
import { cx } from '@/components/ui/primitives';
import s from './layout.module.css';

export type StepId = 'build' | 'lab' | 'mc' | 'stress' | 'risk';

const STEPS: { id: StepId; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'lab', label: 'Price' },
  { id: 'mc', label: 'Simulate' },
  { id: 'stress', label: 'Stress' },
  { id: 'risk', label: 'Risk' },
];

export interface QuickAction { id: string; label: string; run: () => void; }

export function TopBar({ instrument, market, horizonDays, pnl, dataMode, engineStatus, engineReason, wasmStatus, activeTab, onStep, quick }: {
  instrument: Instrument; market: Market; horizonDays: number; pnl: number; dataMode: DataMode;
  engineStatus: EngineStatus; engineReason: OfflineReason; wasmStatus: WasmStatus; activeTab: TabId;
  onStep: (id: StepId) => void; quick: QuickAction[];
}) {
  const data = instrument.custom
    ? { text: 'Manual price', tone: s.info, title: `${instrument.sym} is priced from the price you entered — no data feed` }
    : dataMode === 'live'
      ? { text: 'Live data · IEX', tone: s.good, title: 'Live quotes via the data proxy (Alpaca IEX / indicative options) — not for execution' }
      : dataMode === 'checking'
        ? { text: 'Data…', tone: s.muted, title: 'Checking the data proxy' }
        : { text: 'Snapshot · indicative', tone: s.muted, title: 'Indicative snapshot prices — no live data feed on this build' };
  const engineText = engineStatus === 'connected' ? 'Connected' : engineStatus === 'connecting' ? 'Connecting…' : 'Offline';
  const engineTone = engineStatus === 'connected' ? s.good : engineStatus === 'connecting' ? s.warn : s.muted;
  const engineTitle = engineStatus === 'connected'
    ? 'Native C++ engine connected over WebSocket (ws://localhost:8765): Metal GPU and SIMD CPU Monte Carlo'
    : engineReason === 'hosted'
      ? 'The native engine (Metal GPU, SIMD) runs as a local service, so it is not reachable from the hosted site.'
      : 'No native engine answering at ws://localhost:8765.';
  const wasmText = wasmStatus === 'ready' ? 'Ready' : wasmStatus === 'loading' ? 'Loading…' : 'Unavailable';
  const wasmTone = wasmStatus === 'ready' ? s.good : wasmStatus === 'loading' ? s.warn : s.muted;
  const wasmTitle = wasmStatus === 'ready'
    ? 'The C++ pricing core compiled to WebAssembly, running in this tab'
    : wasmStatus === 'loading' ? 'Loading the C++ core compiled to WebAssembly'
    : 'WebAssembly engine unavailable — pricing falls back to the TypeScript models';

  return (
    <header className={s.bar}>
      <div className={cx(s.row, s.top)}>
        <div className={s.brand}>
          <span className={s.logo} aria-hidden="true">Q</span>
          <div>
            <h1 className={s.title}>QuantCore</h1>
            <div className={s.subtitle}>Options Pricing &amp; Risk Research Terminal</div>
          </div>
        </div>

        <dl className={s.tape} aria-label="Current market">
          <div className={s.tapeItem}><dt className="sr-only">Underlying</dt><dd className={s.tapeSym}>{instrument.sym}</dd></div>
          <div className={s.tapeItem}><dt className={s.tapeLabel}>S</dt><dd className={s.tapeValue}>{num(market.S, 2)}</dd></div>
          <div className={s.tapeItem}><dt className={s.tapeLabel}>σ</dt><dd className={s.tapeValue}>{pct(market.sigma, 1)}</dd></div>
          <div className={cx(s.tapeItem, s.p2)}><dt className={s.tapeLabel}>r</dt><dd className={s.tapeValue}>{pct(market.r, 2)}</dd></div>
          <div className={cx(s.tapeItem, s.p3)}><dt className={s.tapeLabel}>q</dt><dd className={s.tapeValue}>{pct(market.q, 2)}</dd></div>
          <div className={cx(s.tapeItem, s.p3)}><dt className={s.tapeLabel}>T₁</dt><dd className={s.tapeValue}>{horizonDays}d</dd></div>
          <div className={s.tapeItem}><dt className={s.tapeLabel}>P&amp;L</dt>
            <dd className={cx(s.tapeValue, pnl > 0.5 ? 'pos' : pnl < -0.5 ? 'neg' : undefined)}>{usdSigned(pnl)}</dd></div>
        </dl>

        <div className={s.right}>
          <span className={s.pill} title={data.title}>
            <span className={cx(s.dot, data.tone)} aria-hidden="true" />
            <span data-testid="data-status" role="status">{data.text}</span>
          </span>
          <span className={cx(s.pill, s.engine)}>
            <span className={s.pillLabel}>C++ ENGINE</span>
            <span className={s.seg} title={wasmTitle}>
              <span>WebAssembly</span>
              <span className={cx(s.dot, wasmTone)} aria-hidden="true" />
              <span data-testid="wasm-status" role="status" className={cx(s.statusText, wasmTone)}>{wasmText}</span>
            </span>
            <span className={s.sep} aria-hidden="true" />
            <span className={s.seg} title={engineTitle}>
              <span>Native</span>
              <span className={cx(s.dot, engineTone)} aria-hidden="true" />
              <span data-testid="ws-status" role="status" className={cx(s.statusText, engineTone)}>{engineText}</span>
            </span>
          </span>
          <a className={s.link} href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        </div>
      </div>

      <div className={cx(s.row, s.sub)}>
        <nav className={s.steps} aria-label="Workflow">
          {STEPS.map((st, i) => (
            <Fragment key={st.id}>
              {i > 0 && <span className={s.stepArrow} aria-hidden="true">→</span>}
              <button type="button" className={s.step} data-testid={`step-${st.id}`}
                      aria-current={st.id !== 'build' && activeTab === st.id ? 'step' : undefined}
                      onClick={() => onStep(st.id)}>
                <span className={s.stepNum} aria-hidden="true">{i + 1}</span>{st.label}
              </button>
            </Fragment>
          ))}
        </nav>
        <div className={s.quick}>
          <span className={s.quickLabel}>Try</span>
          {quick.map(q => (
            <button key={q.id} type="button" className={s.quickBtn} data-testid={`quick-${q.id}`} onClick={q.run}>{q.label}</button>
          ))}
        </div>
      </div>
    </header>
  );
}
