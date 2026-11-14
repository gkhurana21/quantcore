'use client';

// QuantCore terminal: one position, seven workspaces — Build, Price, Simulate, Exotics, Stress,
// Risk, Engine. The bar switches them, the strip carries the market and the position through all
// of them, and the analytics all live in lib/; components only compose and present them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bsGreeks } from '@/lib/quant/blackScholes';
import { hasVolSurface, legSigma } from '@/lib/quant/volSurface';
import type { Greeks, Leg, Market } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import { netPremium, payoffAnalytics, portfolioGreeks } from '@/lib/strategy/portfolio';
import { legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { findInstrument, INSTRUMENTS } from '@/lib/market/instruments';
import { PRESETS } from '@/lib/strategy/presets';
import { SCENARIOS } from '@/lib/risk/stress';
import { useWorkerTask } from '@/lib/compute/useWorkerTask';
import type { EnginePortfolioResult } from '@/lib/engine/useEngine';
import { useEngine } from '@/lib/engine/useEngine';
import { useWasmEngine } from '@/lib/engine/useWasmEngine';
import { wasmLegGreeks } from '@/lib/engine/wasm';
import { usdSigned } from '@/lib/format';
import { cx, prefersReducedMotion, tabId, tabPanelId } from './ui/primitives';
import { TopBar } from './layout/TopBar';
import { PositionStrip } from './layout/PositionStrip';
import { Sheet } from './layout/Sheet';
import type { Command } from './layout/CommandPalette';
import { CommandPalette } from './layout/CommandPalette';
import { MarketControls } from './builder/MarketControls';
import { SurfaceControls } from './builder/SurfaceControls';
import { ImportDialog } from './io/ImportDialog';
import { BuildWorkspace } from './build/BuildWorkspace';
import { WorkspaceView } from './workspace/WorkspaceView';
import type { CalcSource, TileQuote } from './analytics/SummaryTiles';
import { PricingLab } from './lab/PricingLab';
import { MonteCarloPanel } from './lab/MonteCarloPanel';
import { ExoticsPanel } from './exotics/ExoticsPanel';
import { StressLab } from './stress/StressLab';
import { RiskPanel } from './risk/RiskPanel';
import { EnginePanel } from './engine/EnginePanel';
import type { TabId } from './terminal/useTerminalState';
import { isCanonicalPosition, TABS, useTerminalState, WORKSPACES } from './terminal/useTerminalState';
import { useLiveData } from './terminal/useLiveData';
import t from './terminal/terminal.module.css';

const MC_VAR_SCENARIOS = 20_000;
const MC_VAR_SEED = 11;

function aggregate(legs: Leg[], perShare: Greeks[]): { greeks: Greeks; pnl: number; perShare: boolean } {
  if (legs.length === 1) {
    const g = perShare[0];
    return { greeks: g, pnl: signedQty(legs[0]) * M * (g.price - legs[0].premium), perShare: true };
  }
  const out: Greeks = { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  legs.forEach((l, i) => {
    const w = signedQty(l) * M, g = perShare[i];
    out.price += w * g.price; out.delta += w * g.delta; out.gamma += w * g.gamma;
    out.theta += w * g.theta; out.vega += w * g.vega;
  });
  return { greeks: out, pnl: out.price - netPremium(legs), perShare: false };
}

function SourceMeta({ quote }: { quote: TileQuote }) {
  return (
    <span className={t.source} title={quote.source.reason}>
      <span className={cx(t.sourceDot, quote.source.kind === 'browser' ? t.sourceBrowser
        : quote.source.kind === 'wasm' ? t.sourceWasm : t.sourceEngine)} aria-hidden="true" />
      <span className={t.sourceName} data-testid="calc-source" data-kind={quote.source.kind}>{quote.source.label}</span>
      <span>· {quote.source.reason} ·</span>
      <span><span data-testid="calc-us" className="mono">{quote.calcUs == null ? '—' : quote.calcUs.toFixed(1)}</span> µs</span>
    </span>
  );
}

export default function Dashboard() {
  const [state, dispatch] = useTerminalState();
  const engine = useEngine();
  const wasm = useWasmEngine();
  const live = useLiveData(state.instrument.sym, state.market.S, dispatch);
  const { market, legs } = state;
  const canonical = isCanonicalPosition(state);
  const legsKey = useMemo(() => legsKeyOf(legs), [legs]);
  const analytics = useMemo(() => payoffAnalytics(legs, market), [legs, market]);

  // ── browser pricing (always available) ────────────────────────────────────
  const browser = useMemo(() => {
    const per = legs.map(l => bsGreeks(l.call, market.S, l.K, l.T, legSigma(market, l.K, l.T), market.r, market.q));
    return aggregate(legs, per);
  }, [legs, market]);

  const [browserUs, setBrowserUs] = useState<number | null>(null);
  useEffect(() => {
    // timer resolution is coarse, so repeat the calculation and report the mean
    const run = () => (legs.length === 1
      ? bsGreeks(legs[0].call, market.S, legs[0].K, legs[0].T, legSigma(market, legs[0].K, legs[0].T), market.r, market.q)
      : portfolioGreeks(legs, market));
    const t0 = performance.now();
    let n = 0;
    do { run(); n++; } while (performance.now() - t0 < 0.6 && n < 20_000);
    setBrowserUs(((performance.now() - t0) / n) * 1000);
  }, [legs, market]);

  // ── C++ core compiled to WebAssembly (in this tab) ────────────────────────
  const wasmPer = useMemo(() => (wasm.module ? wasmLegGreeks(wasm.module, legs, market) : null), [wasm.module, legs, market]);
  const [wasmUs, setWasmUs] = useState<number | null>(null);
  useEffect(() => {
    const w = wasm.module;
    if (!w) return;
    const t0 = performance.now();
    let n = 0;
    do { wasmLegGreeks(w, legs, market); n++; } while (performance.now() - t0 < 0.6 && n < 20_000);
    setWasmUs(((performance.now() - t0) / n) * 1000);
  }, [wasm.module, legs, market]);

  // ── C++ engine: streaming canonical contract ──────────────────────────────
  const { sendUpdate, pricePortfolio } = engine;
  // An engine before protocol v3 ignores q, and one before v4 prices every leg at one σ, so each is
  // authoritative only for the markets it understands (q = 0, one volatility for every leg).
  const engineHandlesQ = market.q === 0 || engine.info?.dividends === true;
  const engineHandlesSmile = !hasVolSurface(market) || (engine.info?.protocol ?? 0) >= 4;
  useEffect(() => {
    if (engine.status === 'connected' && canonical && engineHandlesQ) sendUpdate(market);
  }, [engine.status, canonical, engineHandlesQ, market, sendUpdate]);

  // ── C++ engine: batch pricing for any other portfolio ─────────────────────
  const [batch, setBatch] = useState<{ legsKey: string; res: EnginePortfolioResult } | null>(null);
  const batchSeq = useRef(0);
  const batchAccepted = useRef(0);
  const batchEligible = engine.status === 'connected' && !canonical && engineHandlesQ && engineHandlesSmile;
  useEffect(() => {
    if (!batchEligible) return;
    const seq = ++batchSeq.current;
    const id = setTimeout(() => {
      pricePortfolio(legs, market)
        .then(res => {
          if (seq < batchAccepted.current) return;
          batchAccepted.current = seq;
          setBatch({ legsKey, res });
        })
        .catch(() => { /* browser values stay on screen */ });
    }, 20);
    return () => clearTimeout(id);
  }, [batchEligible, legs, legsKey, market, pricePortfolio]);

  // ── which numbers the tiles show, and why ────────────────────────────────
  let quote: TileQuote;
  if (engine.status === 'connected' && canonical && engineHandlesQ && engine.quote) {
    quote = { greeks: engine.quote, pnl: engine.quote.pnl, calcUs: engine.quote.calcUs, perShare: true,
              source: { kind: 'engine-stream', label: 'C++ engine', reason: 'bs_full over the WebSocket stream' } };
  } else if (batchEligible && batch && batch.legsKey === legsKey && batch.res.legs.length === legs.length) {
    quote = { ...aggregate(legs, batch.res.legs), calcUs: batch.res.calcUs,
              source: { kind: 'engine-batch', label: 'C++ engine', reason: 'batch_bs_full over WebSocket' } };
  } else if (wasmPer) {
    const why: string = engine.reason === 'hosted' ? 'native engine runs locally'
      : engine.status === 'connecting' ? 'connecting to the native engine…'
      : engine.status === 'offline' ? 'native engine offline'
      : !engineHandlesQ ? 'q ≠ 0 — the native build predates dividend support'
      : !engineHandlesSmile ? 'smile or term structure — the native build predates per-leg volatility'
      : 'awaiting the native engine';
    quote = { ...aggregate(legs, wasmPer), calcUs: wasmUs,
              source: { kind: 'wasm', label: 'C++ · WebAssembly', reason: `bsm_full in this tab · ${why}` } };
  } else {
    const reason: string = wasm.status === 'loading' ? 'loading the C++ WebAssembly engine…'
      : wasm.status === 'unavailable' ? 'WebAssembly engine unavailable'
      : 'a leg is outside the C++ model’s domain';
    const source: CalcSource = { kind: 'browser', label: 'Browser · TypeScript', reason };
    quote = { ...browser, calcUs: browserUs, source };
  }
  const positionValue = quote.perShare && legs.length === 1
    ? quote.greeks.price * signedQty(legs[0]) * M : quote.greeks.price;
  const dollarDelta = (quote.perShare && legs.length === 1
    ? quote.greeks.delta * signedQty(legs[0]) * M : quote.greeks.delta) * market.S;

  // ── workspaces ───────────────────────────────────────────────────────────
  const workspace = state.tab;
  const setTab = useCallback((tab: TabId) => dispatch({ type: 'tab', tab }), [dispatch]);
  const showTab = useCallback((tab: TabId) => {
    setTab(tab);
    requestAnimationFrame(() => {
      const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
      window.scrollTo({ top: 0, behavior });
      document.querySelector<HTMLElement>('[data-scroller]')?.scrollTo({ top: 0, behavior });   // the phone layout scrolls in here
    });
  }, [setTab]);

  // deep links: /#risk opens the Risk workspace, and switching keeps the address in step
  useEffect(() => {
    const id = window.location.hash.replace('#', '') as TabId;
    if (WORKSPACES.some(w => w.id === id)) setTab(id);
  }, [setTab]);
  useEffect(() => {
    const url = workspace === 'build' ? window.location.pathname + window.location.search : `#${workspace}`;
    window.history.replaceState(null, '', url);
  }, [workspace]);

  // ── sheets, palette and the importer ─────────────────────────────────────
  const [sheet, setSheet] = useState<{ which: 'market' | 'surface'; anchor: HTMLElement | null } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const closeSheet = useCallback(() => setSheet(null), []);
  const openMarket = useCallback((anchor: HTMLElement | null) => setSheet(s => (s?.which === 'market' ? null : { which: 'market', anchor })), []);
  const openSurface = useCallback((anchor: HTMLElement | null) => {
    // on Build the surface already has a panel in the rail: go to it rather than open a second copy
    if (state.tab === 'build') {
      const el = document.getElementById('surface');
      el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      el?.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true });
      return;
    }
    setSheet(s => (s?.which === 'surface' ? null : { which: 'surface', anchor }));
  }, [state.tab]);

  // ── research state shared across workspaces ──────────────────────────────
  const [scenarioId, setScenarioId] = useState('covid');
  const [varConf, setVarConf] = useState(0.95);
  const [varHorizon, setVarHorizon] = useState(1);
  const [seed, setSeed] = useState(42);
  const [antithetic, setAntithetic] = useState(false);

  // The Pricing Lab's models also answer the Build workspace's "do the models agree?" line, so the
  // task runs for both and switching between them shows a result that is already there.
  const labActive = workspace === 'build' || workspace === 'lab';
  const labKey = `${legsKey}|${marketKeyOf(market)}|${seed}|${antithetic ? 1 : 0}`;
  const lab = useWorkerTask('lab', labActive ? { legs, market, seed, antithetic } : null, labKey, 120);

  // Full-revaluation VaR for the glance column; the Risk workspace runs its own at its own confidence.
  const varKey = `${legsKey}|${marketKeyOf(market)}|glance`;
  const glanceVar = useWorkerTask('mcvar', workspace === 'build'
    ? { legs, market, conf: 0.95, hDays: 1, nScen: MC_VAR_SCENARIOS, seed: MC_VAR_SEED } : null, varKey, 200);

  // ── keyboard: number keys switch workspace, ⌘K opens the palette ─────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.repeat) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < WORKSPACES.length) setTab(WORKSPACES[i].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab]);

  // ── animated market moves (stress "apply") ───────────────────────────────
  const tweenRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tweenMarket = useCallback((from: Market, to: Market) => {
    if (tweenRef.current) clearInterval(tweenRef.current);
    if (prefersReducedMotion()) { dispatch({ type: 'market', patch: to }); return; }
    const t0 = performance.now(), dur = 650;
    tweenRef.current = setInterval(() => {
      const u = Math.min(1, (performance.now() - t0) / dur);
      if (u >= 1) {
        if (tweenRef.current) clearInterval(tweenRef.current);
        tweenRef.current = null;
        dispatch({ type: 'market', patch: to });
        return;
      }
      const e = 1 - Math.pow(1 - u, 3);
      dispatch({ type: 'market', patch: {
        S: from.S + (to.S - from.S) * e, sigma: from.sigma + (to.sigma - from.sigma) * e,
        r: from.r + (to.r - from.r) * e, q: to.q } });
    }, 16);
  }, [dispatch]);
  useEffect(() => () => { if (tweenRef.current) clearInterval(tweenRef.current); }, []);

  const onStressApply = (to: Market, shifted: Leg[], label: string) => {
    dispatch({ type: 'stressApply', market: market, legs: shifted, label });
    tweenMarket(market, to);
  };

  // ── everything the terminal can do, by name ──────────────────────────────
  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];
    for (const [i, w] of WORKSPACES.entries()) {
      out.push({ id: `ws-${w.id}`, group: 'Workspaces', glyph: String(i + 1), label: w.label,
                 meta: `key ${i + 1}`, keywords: w.nav, run: () => showTab(w.id) });
    }
    out.push(
      { id: 'quick-condor', group: 'Try', glyph: '↗', label: 'Iron Condor on NVDA', meta: 'Price',
        testid: 'quick-condor', keywords: 'example preset nvda',
        run: () => {
          const nvda = findInstrument('NVDA');
          if (nvda) dispatch({ type: 'instrument', instrument: nvda });
          dispatch({ type: 'preset', name: 'Iron Condor' });
          showTab('lab');
        } },
      { id: 'quick-covid', group: 'Try', glyph: '↘', label: 'COVID-style crash on this position', meta: 'Stress',
        testid: 'quick-covid', keywords: 'example scenario crash',
        run: () => { setScenarioId('covid'); showTab('stress'); } },
      { id: 'quick-paths', group: 'Try', glyph: '≈', label: '200k-path Monte Carlo convergence', meta: 'Price',
        testid: 'quick-paths', keywords: 'example monte carlo convergence',
        run: () => {
          setTab('lab');
          requestAnimationFrame(() => document.getElementById('convergence')?.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' }));
        } },
      { id: 'quick-var99', group: 'Try', glyph: '%', label: '99% Value at Risk', meta: 'Risk',
        testid: 'quick-var99', keywords: 'example var risk',
        run: () => { setVarConf(0.99); showTab('risk'); } },
    );
    for (const name of PRESETS) {
      out.push({ id: `preset-${name}`, group: 'Presets', glyph: '⌥', label: name, meta: 'build position',
                 keywords: 'strategy preset legs',
                 run: () => { dispatch({ type: 'preset', name }); showTab('build'); } });
    }
    for (const inst of [...INSTRUMENTS, ...state.searched]) {
      out.push({ id: `inst-${inst.sym}`, group: 'Tickers', glyph: inst.sym.slice(0, 2), label: inst.sym,
                 meta: inst.name, keywords: 'underlying instrument ticker',
                 run: () => { dispatch({ type: 'instrument', instrument: inst }); showTab('build'); } });
    }
    for (const sc of SCENARIOS) {
      out.push({ id: `scenario-${sc.id}`, group: 'Scenarios', glyph: '!', label: sc.name, meta: 'Stress',
                 keywords: `shock ${sc.tag}`,
                 run: () => { setScenarioId(sc.id); showTab('stress'); } });
    }
    out.push(
      { id: 'cmd-import', group: 'Actions', glyph: '↑', label: 'Import a portfolio file', meta: 'CSV · XLSX · XLS',
        testid: 'cmd-import', keywords: 'upload csv excel', run: () => setImportOpen(true) },
      { id: 'cmd-market', group: 'Actions', glyph: 'S', label: 'Market controls — spot, vol, rate, dividend',
        testid: 'cmd-market', keywords: 'spot volatility rate dividend ticker',
        run: () => setSheet({ which: 'market', anchor: null }) },
      { id: 'cmd-reset', group: 'Actions', glyph: '↺', label: 'Reset the market to its reference', testid: 'cmd-reset',
        keywords: 'undo restore', run: () => dispatch({ type: 'resetMarket' }) },
      { id: 'cmd-draw', group: 'Actions', glyph: '⟳', label: 'New Monte Carlo draw', testid: 'cmd-draw',
        keywords: 'seed reseed random', run: () => setSeed(Math.floor(Math.random() * 1_000_000)) },
    );
    return out;
  }, [dispatch, showTab, setTab, state.searched]);

  // ── screen-reader summary (debounced) ────────────────────────────────────
  const [announce, setAnnounce] = useState('');
  const pnlRounded = Math.round(quote.pnl);
  useEffect(() => {
    const id = setTimeout(() => setAnnounce(`Position P and L ${usdSigned(pnlRounded)}`), 800);
    return () => clearTimeout(id);
  }, [pnlRounded]);

  const volModel = market.smile && market.term ? 'SSVI surface' : market.smile ? 'SSVI smile'
    : market.term ? 'ATM term structure' : 'flat σ';

  return (
    <div className={t.app}>
      <a className={t.skip} href="#workspace">Skip to workspace</a>

      <TopBar instrument={state.instrument} dataMode={live.mode} engineStatus={engine.status} engineReason={engine.reason}
              wasmStatus={wasm.status} workspace={workspace} onWorkspace={setTab} onCommand={() => setPaletteOpen(true)} />

      <div className={t.scroller} data-scroller>
      <PositionStrip state={state} dispatch={dispatch} value={positionValue} pnl={quote.pnl} volModel={volModel}
                     onOpenMarket={openMarket} onOpenSurface={openSurface} />

      <Sheet open={sheet?.which === 'market'} onClose={closeSheet} title="Market" anchor={sheet?.anchor ?? null}
             meta={state.instrument.sym} testid="market-sheet">
        <MarketControls state={state} dispatch={dispatch} live={live} />
      </Sheet>
      {sheet?.which === 'surface' && (
        <Sheet open onClose={closeSheet} title="Volatility surface" anchor={sheet.anchor} meta={volModel} testid="surface-sheet">
          <SurfaceControls state={state} dispatch={dispatch} live={live} />
        </Sheet>
      )}

      <main id="workspace" className={t.main} tabIndex={-1}>
        {workspace === 'build' && (
          <div role="tabpanel" id={tabPanelId('ws', 'build')} aria-labelledby={tabId('ws', 'build')} data-testid="panel-build">
            <BuildWorkspace state={state} dispatch={dispatch} live={live} quote={quote} analytics={analytics}
                            source={<SourceMeta quote={quote} />} mcVar={glanceVar.result}
                            lab={lab.result} labCurrent={lab.resultKey === labKey}
                            onWorkspace={showTab} onScenario={setScenarioId} onImport={() => setImportOpen(true)} />
          </div>
        )}

        {TABS.map(x => state.visited.includes(x.id) && (
          <div key={x.id} role="tabpanel" id={tabPanelId('ws', x.id)} aria-labelledby={tabId('ws', x.id)}
               hidden={workspace !== x.id} data-testid={`panel-${x.id}`}>
            <WorkspaceView id={x.id}>
              {x.id === 'lab' && (
                <PricingLab legs={legs} market={market} engine={engine} wasm={wasm} active={workspace === 'lab'}
                            task={lab} taskKey={labKey} seed={seed} onSeed={setSeed}
                            antithetic={antithetic} onAntithetic={setAntithetic} />
              )}
              {x.id === 'mc' && <MonteCarloPanel legs={legs} market={market} active={workspace === 'mc'} />}
              {x.id === 'exotics' && <ExoticsPanel market={market} engine={engine} wasm={wasm} active={workspace === 'exotics'} />}
              {x.id === 'stress' && (
                <StressLab legs={legs} market={market} scenarioId={scenarioId} onScenario={setScenarioId}
                           onApply={onStressApply} onRestore={() => dispatch({ type: 'stressRestore' })}
                           canRestore={state.stressBackup != null} />
              )}
              {x.id === 'risk' && (
                <RiskPanel legs={legs} market={market} conf={varConf} horizon={varHorizon}
                           onConf={setVarConf} onHorizon={setVarHorizon} active={workspace === 'risk'} />
              )}
              {x.id === 'engine' && <EnginePanel engine={engine} wasm={wasm} legs={legs} market={market} source={quote.source} />}
            </WorkspaceView>
          </div>
        ))}
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ImportDialog open={importOpen} onOpen={() => setImportOpen(true)} onClose={() => setImportOpen(false)}
                    market={market} symbol={state.instrument.sym}
                    onApply={(imported, label) => dispatch({ type: 'importLegs', legs: imported, label })} />

      <footer className={t.footer}>
        <span>
          QuantCore — options pricing &amp; risk research terminal. Educational tool, not investment advice; snapshot prices
          are indicative.
        </span>
        <span>
          C++17 · WebAssembly · pybind11 · Apple Metal · FastAPI · Next.js ·{' '}
          <a href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">Source</a> ·{' '}
          <a href="https://gaurangkhurana.ca" target="_blank" rel="noopener noreferrer">Gaurang Khurana</a>
        </span>
      </footer>
      </div>

      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}
