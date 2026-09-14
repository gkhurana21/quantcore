'use client';

// QuantCore terminal: Build → Price → Simulate → Stress → Risk.
// Orchestrates state, the local C++ engine connection and the views. All
// analytics live in lib/; components only compose and present them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bsGreeks } from '@/lib/quant/blackScholes';
import { legSigma } from '@/lib/quant/volSurface';
import type { Greeks, Leg, Market } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import { firstExpiry, netPremium, payoffAnalytics, portfolioGreeks } from '@/lib/strategy/portfolio';
import { legsKeyOf } from '@/lib/strategy/labels';
import { findInstrument } from '@/lib/market/instruments';
import type { EnginePortfolioResult } from '@/lib/engine/useEngine';
import { useEngine } from '@/lib/engine/useEngine';
import { useWasmEngine } from '@/lib/engine/useWasmEngine';
import { wasmLegGreeks } from '@/lib/engine/wasm';
import { days, usdSigned } from '@/lib/format';
import { cx, Panel, prefersReducedMotion, Segmented, tabId, tabPanelId, Tabs } from './ui/primitives';
import type { QuickAction, StepId } from './layout/TopBar';
import { TopBar } from './layout/TopBar';
import { MarketInputs } from './builder/MarketInputs';
import { StrategyBuilder } from './builder/StrategyBuilder';
import { PortfolioUpload } from './io/PortfolioUpload';
import type { CalcSource, TileQuote } from './analytics/SummaryTiles';
import { PositionFacts, SummaryTiles } from './analytics/SummaryTiles';
import { StrategyChart } from './analytics/StrategyChart';
import { PnlSurface } from './analytics/PnlSurface';
import { PricingLab } from './lab/PricingLab';
import { MonteCarloPanel } from './lab/MonteCarloPanel';
import { StressLab } from './stress/StressLab';
import { RiskPanel } from './risk/RiskPanel';
import { EnginePanel } from './engine/EnginePanel';
import type { TabId } from './terminal/useTerminalState';
import { CHART_MODES, isCanonicalPosition, TABS, useTerminalState } from './terminal/useTerminalState';
import { useLiveData } from './terminal/useLiveData';
import t from './terminal/terminal.module.css';

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
  // authoritative only for the markets it understands (q = 0, no smile).
  const engineHandlesQ = market.q === 0 || engine.info?.dividends === true;
  const engineHandlesSmile = !market.smile || (engine.info?.protocol ?? 0) >= 4;
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
      : !engineHandlesSmile ? 'smile — the native build predates per-leg volatility'
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

  // ── views, tabs and keyboard shortcuts ───────────────────────────────────
  const [scenarioId, setScenarioId] = useState('covid');
  const [varConf, setVarConf] = useState(0.95);
  const [varHorizon, setVarHorizon] = useState(1);
  const deckRef = useRef<HTMLElement | null>(null);

  const setTab = useCallback((tab: TabId) => dispatch({ type: 'tab', tab }), [dispatch]);
  const showTab = useCallback((tab: TabId) => {
    setTab(tab);
    requestAnimationFrame(() => deckRef.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }));
  }, [setTab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const i = Number(e.key) - 1;
      if (Number.isInteger(i) && i >= 0 && i < TABS.length) setTab(TABS[i].id);
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

  const onStep = (id: StepId) => {
    if (id === 'build') {
      const el = document.getElementById('builder');
      el?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    } else {
      showTab(id);
    }
  };

  const quick: QuickAction[] = [
    { id: 'condor', label: 'Iron Condor on NVDA', run: () => {
      const nvda = findInstrument('NVDA');
      if (nvda) dispatch({ type: 'instrument', instrument: nvda });
      dispatch({ type: 'preset', name: 'Iron Condor' });
      showTab('lab');
    } },
    { id: 'covid', label: 'COVID-style crash', run: () => { setScenarioId('covid'); showTab('stress'); } },
    { id: 'paths', label: '200k-path convergence', run: () => {
      setTab('lab');
      requestAnimationFrame(() => document.getElementById('convergence')?.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' }));
    } },
    { id: 'var99', label: '99% VaR', run: () => { setVarConf(0.99); showTab('risk'); } },
  ];

  // ── screen-reader summary (debounced) ────────────────────────────────────
  const [announce, setAnnounce] = useState('');
  const pnlRounded = Math.round(quote.pnl);
  useEffect(() => {
    const id = setTimeout(() => setAnnounce(`Position P and L ${usdSigned(pnlRounded)}`), 800);
    return () => clearTimeout(id);
  }, [pnlRounded]);

  const dollarDelta = (quote.perShare && legs.length === 1
    ? quote.greeks.delta * signedQty(legs[0]) * M : quote.greeks.delta) * market.S;

  return (
    <div className={t.app}>
      <a className={t.skip} href="#workspace">Skip to workspace</a>

      <TopBar instrument={state.instrument} market={market} horizonDays={days(firstExpiry(legs))} pnl={quote.pnl}
              dataMode={live.mode} engineStatus={engine.status} engineReason={engine.reason} wasmStatus={wasm.status}
              activeTab={state.tab} onStep={onStep} quick={quick} />

      <div className={t.body}>
        <aside className={t.rail} aria-label="Market, strategy and portfolio inputs">
          <Panel id="market" index="01" title="Market">
            <MarketInputs state={state} dispatch={dispatch} live={live} />
          </Panel>
          <Panel id="builder" index="02" title="Strategy Builder" meta={<span data-testid="builder-vol-model">{state.instrument.sym} · {market.smile ? 'SSVI smile' : 'flat σ'}</span>}>
            <StrategyBuilder state={state} dispatch={dispatch} live={live} />
          </Panel>
          <Panel id="upload" index="03" title="Portfolio Upload">
            <PortfolioUpload market={market} symbol={state.instrument.sym}
                             onApply={(imported, label) => dispatch({ type: 'importLegs', legs: imported, label })} />
          </Panel>
        </aside>

        <main id="workspace" className={t.main} tabIndex={-1}>
          <Panel title="Position & Greeks" flush meta={<SourceMeta quote={quote} />}>
            <SummaryTiles quote={quote} legs={legs} spot={market.S} />
            <PositionFacts legs={legs} analytics={analytics} spotDollarDelta={dollarDelta} />
          </Panel>

          <div className={t.row2}>
            <Panel title="Strategy Payoff"
                   meta={<Segmented size="sm" label="Chart mode" testid="chart-mode" value={state.chartMode}
                                    options={CHART_MODES.map(m => ({ value: m.id, label: m.label, title: m.title }))}
                                    onChange={mode => dispatch({ type: 'chartMode', mode })} />}>
              <StrategyChart legs={legs} market={market} anchorS={state.base.S} mode={state.chartMode} analytics={analytics} />
            </Panel>
            <Panel title="P&L Surface" meta={<span>spot × vol · USD</span>}>
              <PnlSurface legs={legs} market={market} />
            </Panel>
          </div>

          <section ref={deckRef} className={t.deck} aria-label="Research tools">
            <Tabs prefix="deck" label="Research tools" showKeys active={state.tab} onChange={setTab}
                  tabs={TABS.map(x => ({ id: x.id, label: x.label, badge: x.id === 'engine' && (engine.status === 'connected' || wasm.status === 'ready') }))} />
            {TABS.map(x => state.visited.includes(x.id) && (
              <div key={x.id} role="tabpanel" id={tabPanelId('deck', x.id)} aria-labelledby={tabId('deck', x.id)}
                   hidden={state.tab !== x.id} className={t.deckPanel} data-testid={`panel-${x.id}`}>
                {x.id === 'lab' && <PricingLab legs={legs} market={market} engine={engine} active={state.tab === 'lab'} />}
                {x.id === 'mc' && <MonteCarloPanel legs={legs} market={market} active={state.tab === 'mc'} />}
                {x.id === 'stress' && (
                  <StressLab legs={legs} market={market} scenarioId={scenarioId} onScenario={setScenarioId}
                             onApply={onStressApply} onRestore={() => dispatch({ type: 'stressRestore' })}
                             canRestore={state.stressBackup != null} />
                )}
                {x.id === 'risk' && (
                  <RiskPanel legs={legs} market={market} conf={varConf} horizon={varHorizon}
                             onConf={setVarConf} onHorizon={setVarHorizon} active={state.tab === 'risk'} />
                )}
                {x.id === 'engine' && <EnginePanel engine={engine} wasm={wasm} legs={legs} market={market} source={quote.source} />}
              </div>
            ))}
          </section>
        </main>
      </div>

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

      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}
