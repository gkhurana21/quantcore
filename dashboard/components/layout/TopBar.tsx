'use client';

import { Fragment } from 'react';
import type { Instrument } from '@/lib/market/instruments';
import type { Market } from '@/lib/quant/types';
import type { EngineStatus, OfflineReason } from '@/lib/engine/useEngine';
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

export function TopBar({ instrument, market, horizonDays, pnl, dataMode, engineStatus, engineReason, activeTab, onStep, quick }: {
  instrument: Instrument; market: Market; horizonDays: number; pnl: number; dataMode: DataMode;
  engineStatus: EngineStatus; engineReason: OfflineReason; activeTab: TabId;
  onStep: (id: StepId) => void; quick: QuickAction[];
}) {
  const engineText = engineStatus === 'connected' ? 'Connected' : engineStatus === 'connecting' ? 'Connecting…' : 'Offline';
  const engineTone = engineStatus === 'connected' ? s.good : engineStatus === 'connecting' ? s.warn : s.muted;
  const engineTitle = engineStatus === 'connected'
    ? 'Local C++ engine connected over WebSocket (ws://localhost:8765)'
    : engineReason === 'hosted'
      ? 'The C++ engine runs on a local machine; this hosted build computes everything in the browser.'
      : 'No engine answering at ws://localhost:8765 — pricing runs in the browser.';

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
          <div className={s.tapeItem}><dt className={s.tapeLabel}>r</dt><dd className={s.tapeValue}>{pct(market.r, 2)}</dd></div>
          <div className={s.tapeItem}><dt className={s.tapeLabel}>q</dt><dd className={s.tapeValue}>{pct(market.q, 2)}</dd></div>
          <div className={s.tapeItem}><dt className={s.tapeLabel}>T₁</dt><dd className={s.tapeValue}>{horizonDays}d</dd></div>
          <div className={s.tapeItem}><dt className={s.tapeLabel}>P&amp;L</dt>
            <dd className={cx(s.tapeValue, pnl > 0.5 ? 'pos' : pnl < -0.5 ? 'neg' : undefined)}>{usdSigned(pnl)}</dd></div>
        </dl>

        <div className={s.right}>
          <span className={s.pill} title={dataMode === 'live'
            ? 'Live quotes via the data proxy (Alpaca IEX / indicative options) — not for execution'
            : 'Indicative snapshot prices — no live data feed on this build'}>
            <span className={cx(s.dot, dataMode === 'live' ? s.good : s.muted)} aria-hidden="true" />
            <span data-testid="data-status" role="status">
              {dataMode === 'live' ? 'Live data · IEX' : dataMode === 'checking' ? 'Data…' : 'Snapshot · indicative'}
            </span>
          </span>
          <span className={s.pill} title={engineTitle}>
            <span className={s.pillLabel}>ENGINE</span>
            <span>C++ / WebSocket</span>
            <span className={cx(s.dot, engineTone)} aria-hidden="true" />
            <span data-testid="ws-status" role="status" className={cx(s.statusText, engineTone)}>{engineText}</span>
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
