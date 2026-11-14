'use client';

// QuantCore terminal: one position, seven workspaces — Build, Price, Simulate, Exotics, Stress,
// Risk, Engine. The bar switches them, the strip carries the market and the position through all
// of them, and the analytics all live in lib/; components only compose and present them.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { introHiddenNow, setIntroHidden } from '@/lib/intro';
import type { ShortcutAction } from '@/lib/shortcuts';
import { isTypingTarget, keyHint, overlayIsOpen, readSingleKeys, resolveShortcut, stepIndex, writeSingleKeys } from '@/lib/shortcuts';
import { cx, prefersReducedMotion, tabId, tabPanelId } from './ui/primitives';
import { TopBar } from './layout/TopBar';
import { PositionStrip } from './layout/PositionStrip';
import { Sheet } from './layout/Sheet';
import { ShortcutsDialog } from './layout/ShortcutsDialog';
import type { ToastMessage } from './layout/Toast';
import { Toast } from './layout/Toast';
import type { Command } from './layout/CommandPalette';
import { CommandPalette } from './layout/CommandPalette';
import { MarketControls } from './builder/MarketControls';
import { SurfaceControls } from './builder/SurfaceControls';
import { ImportDialog } from './io/ImportDialog';
import { BuildWorkspace } from './build/BuildWorkspace';
import { IntroBand } from './build/IntroBand';
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
  const [paletteQuery, setPaletteQuery] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openPalette = useCallback((query = '') => { setPaletteQuery(query); setPaletteOpen(true); }, []);
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

  // ── the intro band, the undo toast and the single-key switch ──────────────
  // The band is always in the markup; a script in <head> hides it from <html data-intro="off"> before paint, and
  // this reads the same attribute so React and the stylesheet agree (see lib/intro.ts).
  const [introOn, setIntroOn] = useState(true);
  useLayoutEffect(() => { if (introHiddenNow()) setIntroOn(false); }, []);
  const dismissIntro = useCallback(() => { setIntroHidden(true); setIntroOn(false); }, []);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const clearToast = useCallback(() => setToast(null), []);
  const [singleKeys, setSingleKeys] = useState(true);
  useEffect(() => { setSingleKeys(readSingleKeys()); }, []);
  const changeSingleKeys = useCallback((on: boolean) => { setSingleKeys(on); writeSingleKeys(on); }, []);

  const resetWithUndo = useCallback(() => {
    const before = { S: market.S, sigma: market.sigma, r: market.r, q: market.q };
    const moved = before.S !== state.base.S || before.sigma !== state.base.sigma || before.r !== state.base.r || before.q !== state.base.q;
    if (!moved) { setToast({ id: Date.now(), text: 'The market is already at its reference' }); return; }
    dispatch({ type: 'resetMarket' });
    setToast({ id: Date.now(), text: 'Market reset to its reference', undo: () => dispatch({ type: 'market', patch: before }) });
  }, [market, state.base, dispatch]);

  // `t`, the palette and the intro's own link all land on Build with the band showing and the dismissal forgotten
  const showIntro = useCallback(() => { setIntroHidden(false); setIntroOn(true); showTab('build'); }, [showTab]);

  // ── guided examples: the palette's "Try" group and the intro band run the same four ──
  const examples = useMemo(() => [
    { id: 'quick-condor', short: 'Iron condor on NVDA', label: 'Iron Condor on NVDA', meta: 'Price', glyph: '↗', keywords: 'example strategy nvda',
      run: () => {
        const nvda = findInstrument('NVDA');
        if (nvda) dispatch({ type: 'instrument', instrument: nvda });
        dispatch({ type: 'preset', name: 'Iron Condor' });
        showTab('lab');
      } },
    { id: 'quick-covid', short: 'COVID-style crash', label: 'COVID-style crash on this position', meta: 'Stress', glyph: '↘', keywords: 'example scenario crash',
      run: () => { setScenarioId('covid'); showTab('stress'); } },
    { id: 'quick-paths', short: '200k-path Monte Carlo', label: '200k-path Monte Carlo convergence', meta: 'Price', glyph: '≈', keywords: 'example monte carlo convergence',
      run: () => {
        setTab('lab');
        requestAnimationFrame(() => document.getElementById('convergence')?.scrollIntoView({
          behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' }));
      } },
    { id: 'quick-var99', short: '99% VaR', label: '99% Value at Risk', meta: 'Risk', glyph: '%', keywords: 'example var risk',
      run: () => { setVarConf(0.99); showTab('risk'); } },
  ], [dispatch, showTab, setTab]);

  // ── everything the terminal can do, by name ──────────────────────────────
  const commands: Command[] = useMemo(() => {
    const out: Command[] = [];
    for (const [i, w] of WORKSPACES.entries()) {
      out.push({ id: `ws-${w.id}`, group: 'Workspaces', glyph: String(i + 1), label: w.label,
                 hotkey: String(i + 1), keywords: w.nav, run: () => showTab(w.id) });
    }
    for (const x of examples) {
      out.push({ id: x.id, group: 'Try', glyph: x.glyph, label: x.label, meta: x.meta, testid: x.id, keywords: x.keywords, run: x.run });
    }
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
      { id: 'cmd-import', group: 'Actions', glyph: '↑', label: 'Import a portfolio file', meta: 'CSV · XLSX · XLS', hotkey: keyHint('import'),
        testid: 'cmd-import', keywords: 'upload csv excel', run: () => setImportOpen(true) },
      { id: 'cmd-market', group: 'Actions', glyph: 'S', label: 'Market controls — spot, vol, rate, dividend', hotkey: keyHint('market'),
        testid: 'cmd-market', keywords: 'spot volatility rate dividend ticker',
        run: () => setSheet({ which: 'market', anchor: null }) },
      { id: 'cmd-surface', group: 'Actions', glyph: 'σ', label: 'Volatility surface — smile and term structure', hotkey: keyHint('surface'),
        testid: 'cmd-surface', keywords: 'smile skew term structure ssvi', run: () => openSurface(null) },
      { id: 'cmd-reset', group: 'Actions', glyph: '↺', label: 'Reset the market to its reference', hotkey: keyHint('reset'), testid: 'cmd-reset',
        keywords: 'undo restore', run: resetWithUndo },
      { id: 'cmd-draw', group: 'Actions', glyph: '⟳', label: 'New Monte Carlo draw', hotkey: keyHint('draw'), testid: 'cmd-draw',
        keywords: 'seed reseed random', run: () => setSeed(Math.floor(Math.random() * 1_000_000)) },
      { id: 'cmd-intro', group: 'Actions', glyph: 'i', label: 'Show the introduction and examples', hotkey: keyHint('intro'), testid: 'cmd-intro',
        keywords: 'welcome help about tour', run: showIntro },
      { id: 'cmd-shortcuts', group: 'Actions', glyph: '?', label: 'Keyboard shortcuts', hotkey: keyHint('shortcuts'), testid: 'cmd-shortcuts',
        keywords: 'keys hotkeys help single-key', run: () => setShortcutsOpen(true) },
    );
    return out;
  }, [dispatch, showTab, state.searched, examples, openSurface, resetWithUndo, showIntro]);

  // ── keyboard: one table (lib/shortcuts.ts) says which key does what and when it is ignored ──
  const runShortcut = (a: ShortcutAction) => {
    switch (a.type) {
      case 'workspace': showTab(WORKSPACES[a.index].id); break;
      case 'step': showTab(WORKSPACES[stepIndex(WORKSPACES.findIndex(w => w.id === workspace), a.dir, WORKSPACES.length)].id); break;
      case 'palette': openPalette(a.query); break;
      case 'shortcuts': setShortcutsOpen(true); break;
      case 'market': setSheet({ which: 'market', anchor: null }); break;
      case 'surface': openSurface(null); break;
      case 'import': setImportOpen(true); break;
      case 'resetMarket': resetWithUndo(); break;
      case 'newDraw': setSeed(Math.floor(Math.random() * 1_000_000)); break;
      case 'intro':
        if (workspace === 'build' && introOn) dismissIntro();
        else showIntro();
        break;
    }
  };
  const latestShortcut = useRef(runShortcut);
  useEffect(() => { latestShortcut.current = runShortcut; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveShortcut(e, { typing: isTypingTarget(e.target as Element | null), overlayOpen: overlayIsOpen(), singleKeys });
      if (!action) return;
      e.preventDefault();
      latestShortcut.current(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [singleKeys]);

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
              wasmStatus={wasm.status} workspace={workspace} onWorkspace={setTab} onCommand={() => openPalette()} />

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
            {introOn && <IntroBand examples={examples} onDismiss={dismissIntro} />}
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

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} initialQuery={paletteQuery} />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} singleKeys={singleKeys} onSingleKeys={changeSingleKeys} />
      <Toast toast={toast} onDone={clearToast} />
      <ImportDialog open={importOpen} onOpen={() => setImportOpen(true)} onClose={() => setImportOpen(false)}
                    market={market} symbol={state.instrument.sym}
                    onApply={(imported, label) => dispatch({ type: 'importLegs', legs: imported, label })} />

      <footer className={t.footer}>
        <span>
          QuantCore — options pricing &amp; risk research terminal. Educational tool, not investment advice; snapshot prices
          are indicative.
        </span>
        <span>
          <button type="button" className={t.footerKeys} onClick={() => setShortcutsOpen(true)} data-testid="footer-shortcuts">
            Keyboard shortcuts <kbd>{keyHint('shortcuts')}</kbd>
          </button>{' · '}
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
