'use client';

import type { Instrument } from '@/lib/market/instruments';
import type { EngineStatus, OfflineReason } from '@/lib/engine/useEngine';
import type { WasmStatus } from '@/lib/engine/useWasmEngine';
import type { DataMode } from '@/components/terminal/useLiveData';
import type { TabId } from '@/components/terminal/useTerminalState';
import { WORKSPACES } from '@/components/terminal/useTerminalState';
import { cx, tabId, tabPanelId } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import s from './layout.module.css';

/**
 * One bar, one navigation: the seven workspaces (and their number keys), the command palette, and
 * which engine is doing the arithmetic. Everything that used to live in a second row of steps and
 * quick actions is now either a workspace or a palette entry.
 */
export function TopBar({ instrument, dataMode, engineStatus, engineReason, wasmStatus, workspace, onWorkspace, onCommand }: {
  instrument: Instrument; dataMode: DataMode;
  engineStatus: EngineStatus; engineReason: OfflineReason; wasmStatus: WasmStatus;
  workspace: TabId; onWorkspace: (id: TabId) => void; onCommand: () => void;
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
      <div className={s.row}>
        <div className={s.brand}>
          <span className={s.logo} aria-hidden="true">Q</span>
          <h1 className={s.title}>QuantCore</h1>
        </div>

        <nav role="tablist" aria-label="Workspaces" className={s.nav}>
          {WORKSPACES.map((w, i) => (
            <button key={w.id} type="button" role="tab" id={tabId('ws', w.id)} aria-controls={tabPanelId('ws', w.id)}
                    aria-selected={w.id === workspace} tabIndex={w.id === workspace ? 0 : -1}
                    data-testid={`tab-${w.id}`} className={s.navItem} title={w.dek}
                    onClick={() => onWorkspace(w.id)}
                    onKeyDown={e => {
                      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                      if (!dir) return;
                      e.preventDefault();
                      const next = WORKSPACES[(i + dir + WORKSPACES.length) % WORKSPACES.length];
                      onWorkspace(next.id);
                      document.getElementById(tabId('ws', next.id))?.focus();
                    }}>
              {w.nav}
              <span className={s.navKey} aria-hidden="true">{i + 1}</span>
            </button>
          ))}
        </nav>

        <div className={s.right}>
          <button type="button" className={s.command} onClick={onCommand}
                  aria-label="Search tickers, presets, scenarios and actions — Command K">
            <Icon name="search" size={14} />
            <span className={s.commandText}>Tickers, presets, scenarios</span>
            <kbd className={s.navKey}>⌘K</kbd>
          </button>

          <button type="button" className={s.chip} onClick={() => onWorkspace('engine')}
                  aria-label="Compute engines — open the C++ Engine workspace">
            <span className={s.chipLabel}>COMPUTE</span>
            <span className={cx(s.chipSeg, s.p1)} title={wasmTitle}>
              <span className={cx(s.dot, wasmTone)} aria-hidden="true" />
              <span>WASM</span>
              <span data-testid="wasm-status" role="status" className={cx(s.statusText, wasmTone)}>{wasmText}</span>
            </span>
            <span className={cx(s.sep, s.p1)} aria-hidden="true" />
            <span className={s.chipSeg} title={engineTitle}>
              <span className={cx(engineStatus === 'connected' ? s.dot : s.ring, engineTone)} aria-hidden="true" />
              <span className={s.p2}>Native</span>
              <span data-testid="ws-status" role="status" className={cx(s.statusText, engineTone)}>{engineText}</span>
            </span>
          </button>

          <span className={s.chip} title={data.title}>
            <span className={cx(s.dot, data.tone)} aria-hidden="true" />
            <span data-testid="data-status" role="status">{data.text}</span>
          </span>

          <a className={s.link} href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">Source ↗</a>
        </div>
      </div>
    </header>
  );
}
