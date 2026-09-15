'use client';

import { useState } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { bsGreeks } from '@/lib/quant/blackScholes';
import type { Engine, EngineMcResult, EnginePortfolioResult } from '@/lib/engine/useEngine';
import type { WasmEngine } from '@/lib/engine/useWasmEngine';
import { BENCH_SOURCE, BENCHMARKS } from '@/lib/engine/benchmarks';
import { legLabel, legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { hasVolSurface, legSigma } from '@/lib/quant/volSurface';
import type { CalcSource, CalcSourceKind } from '@/components/analytics/SummaryTiles';
import { WasmPanel } from './WasmPanel';
import { Badge, Button, cx, Segmented, Sparkline, ui } from '@/components/ui/primitives';
import { fmtMs, fmtPaths, Z95 } from '@/components/lab/labFormat';
import e from './engine.module.css';

const GREEKS = ['price', 'delta', 'gamma', 'theta', 'vega'] as const;

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(q * (s.length - 1)))];
}

function Architecture({ connected, backend, source }: { connected: boolean; backend: string | null; source: CalcSourceKind }) {
  const edge = connected ? cx(e.edge, e.edgeLive) : e.edge;
  const wasmEdge = source === 'wasm' ? cx(e.edge, e.edgeLive) : e.edge;
  const node = (active: boolean) => cx(e.node, active && e.nodeActive);
  return (
    <div className={e.diagramWrap}>
      <svg viewBox="0 0 880 272" className={e.diagram} role="img" data-testid="engine-diagram" data-connected={connected}
           data-source={source}
           aria-label={connected
             ? 'Connected: browser sends JSON over WebSocket to FastAPI, which calls the native C++17 core through pybind11.'
             : source === 'wasm'
               ? 'In the browser: the page calls the C++17 core compiled to WebAssembly; the native engine is not connected.'
               : 'Offline: all figures are computed by the TypeScript models in the browser.'}>
        <rect x={10} y={82} width={170} height={74} rx={7} className={node(!connected)} />
        <text x={24} y={106} className={e.nodeTitle}>Browser</text>
        <text x={24} y={124} className={e.nodeSub}>Next.js · React</text>
        <text x={24} y={141} className={e.nodeSub}>TS models · Workers</text>

        <path d="M95 156 L95 196" className={wasmEdge} />
        <rect x={10} y={196} width={250} height={66} rx={7} className={node(source === 'wasm')} />
        <text x={24} y={220} className={e.nodeTitle}>C++17 core · WebAssembly</text>
        <text x={24} y={238} className={e.nodeSub}>BSM · MC · local vol · exotics</text>
        <text x={24} y={254} className={e.nodeSub}>Emscripten · standalone, no JS glue</text>

        <path d="M180 119 L290 119" className={edge} />
        <text x={235} y={108} textAnchor="middle" className={e.edgeLabel}>WS · JSON</text>

        <rect x={290} y={82} width={160} height={74} rx={7} className={node(connected)} />
        <text x={304} y={106} className={e.nodeTitle}>FastAPI · uvicorn</text>
        <text x={304} y={124} className={e.nodeSub}>ws_server.py</text>
        <text x={304} y={141} className={e.nodeSub}>protocol v7</text>

        <path d="M450 119 L500 119" className={edge} />

        <rect x={500} y={82} width={140} height={74} rx={7} className={node(connected)} />
        <text x={514} y={106} className={e.nodeTitle}>pybind11</text>
        <text x={514} y={124} className={e.nodeSub}>GIL released</text>
        <text x={514} y={141} className={e.nodeSub}>quantcore.so</text>

        <text x={690} y={14} className={e.groupLabel}>C++17 CORE</text>
        <path d="M640 119 C665 119 665 52 690 52" className={edge} />
        <path d="M640 119 L690 119" className={edge} />
        <path d="M640 119 C665 119 665 186 690 186" className={edge} />

        <rect x={690} y={24} width={180} height={56} rx={7} className={node(connected && !backend)} />
        <text x={704} y={47} className={e.nodeTitle}>BS + analytic Greeks</text>
        <text x={704} y={65} className={e.nodeSub}>bs_full · batch_bs_full</text>

        <rect x={690} y={91} width={180} height={56} rx={7} className={node(connected && backend === 'cpu-mt')} />
        <text x={704} y={114} className={e.nodeTitle}>SIMD CPU Monte Carlo</text>
        <text x={704} y={132} className={e.nodeSub}>mc_price_mt</text>

        <rect x={690} y={158} width={180} height={56} rx={7} className={node(connected && backend === 'metal')} />
        <text x={704} y={181} className={e.nodeTitle}>Metal GPU Monte Carlo</text>
        <text x={704} y={199} className={e.nodeSub}>mc_price_gpu · Philox</text>
      </svg>
    </div>
  );
}

export function EnginePanel({ engine, wasm, legs, market, source }: {
  engine: Engine; wasm: WasmEngine; legs: Leg[]; market: Market; source: CalcSource;
}) {
  const connected = engine.status === 'connected';
  const rtt = engine.stats.rtt;
  const aKey = `${legsKeyOf(legs)}|${marketKeyOf(market)}`;

  const [agree, setAgree] = useState<{ key: string; busy: boolean; res?: EnginePortfolioResult; error?: string } | null>(null);
  const runAgree = async () => {
    setAgree({ key: aKey, busy: true });
    try { setAgree({ key: aKey, busy: false, res: await engine.pricePortfolio(legs, market) }); }
    catch (err) { setAgree({ key: aKey, busy: false, error: err instanceof Error ? err.message : String(err) }); }
  };
  const agreeRows = agree?.res && agree.key === aKey && agree.res.legs.length === legs.length
    ? legs.map((l, i) => {
      const b = bsGreeks(l.call, market.S, l.K, l.T, legSigma(market, l.K, l.T), market.r, market.q);
      const g = agree.res!.legs[i];
      return { l, g, b, diff: Math.max(...GREEKS.map(k => Math.abs(g[k] - b[k]))) };
    }) : null;
  const maxDiff = agreeRows ? Math.max(...agreeRows.map(x => x.diff)) : null;

  const [legIdx, setLegIdx] = useState(0);
  const [paths, setPaths] = useState(1_000_000);
  const [mc, setMc] = useState<{ key: string; busy: boolean; res?: EngineMcResult; error?: string } | null>(null);
  const idx = Math.min(legIdx, legs.length - 1);
  const mKey = `${aKey}|${idx}|${paths}`;
  const runMc = async () => {
    const l = legs[idx];
    setMc({ key: mKey, busy: true });
    try {
      setMc({ key: mKey, busy: false, res: await engine.runMc({ call: l.call, S: market.S, K: l.K, r: market.r,
                                                                 sigma: legSigma(market, l.K, l.T), T: l.T, paths, seed: 42,
                                                                 q: market.q }) });
    } catch (err) {
      setMc({ key: mKey, busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const mcLeg = legs[idx];
  const mcRef = mcLeg ? bsGreeks(mcLeg.call, market.S, mcLeg.K, mcLeg.T, legSigma(market, mcLeg.K, mcLeg.T), market.r, market.q).price : 0;
  const mcShown = mc?.res && mc.key === mKey ? mc.res : null;

  const blocker = !connected
    ? (engine.reason === 'hosted' ? 'Runs on a local machine only — not available on the hosted site.' : 'Native engine offline.')
    : market.q !== 0 && !engine.info?.dividends ? 'This engine build predates dividend support — set q to 0% or rebuild the engine.'
    : hasVolSurface(market) && (engine.info?.protocol ?? 0) < 4 ? 'This engine build prices every leg at one volatility — set the smile and term structure to Flat or restart the engine.'
    : null;

  return (
    <div>
      <div className={e.sectionTitle} style={{ marginTop: 0 }}>WebAssembly engine · in this browser</div>
      <WasmPanel wasm={wasm} legs={legs} market={market} />

      <div className={e.sectionTitle}>Native engine · WebSocket</div>
      <div className={e.head}>
        <Badge tone={connected ? 'good' : engine.status === 'connecting' ? 'warn' : 'muted'} pulse={connected} testid="engine-status">
          {connected ? 'Connected' : engine.status === 'connecting' ? 'Connecting…' : 'Offline'}
        </Badge>
        <span className={e.url}>{engine.url}</span>
        {engine.info && (
          <span className={e.url}>
            protocol v{engine.info.protocol} · {engine.info.metal ? `Metal · ${engine.info.device}` : 'no Metal'} · {engine.info.cpuThreads} CPU threads
          </span>
        )}
        {!connected && engine.reason !== 'hosted' && engine.status !== 'connecting' && (
          <Button size="sm" onClick={engine.reconnect} data-testid="engine-reconnect">Reconnect</Button>
        )}
      </div>
      <p className={e.reason}>
        {connected
          ? 'The Greeks tiles are priced by the native C++17 core: the default SPY contract streams through subscribe/update, and any other portfolio (including a dividend yield) is sent as one batch_bs_full request. Charts, stress and VaR are computed in the browser.'
          : engine.reason === 'hosted'
            ? 'The native engine — Metal GPU Monte Carlo, Accelerate SIMD batch pricing and multithreaded CPU paths — runs as a local service, so the hosted site cannot reach it. The WebAssembly build above runs the same C++ pricing code in your browser instead. Run the engine locally to see the native path light up.'
            : 'No native engine answered at ws://localhost:8765, so the Greeks tiles are priced by the WebAssembly build above. Start the native engine with the commands below; its badge turns Connected by itself within a few seconds, or press Reconnect.'}
      </p>

      <dl className={e.stats}>
        <div className={e.stat}><dt>Greeks source</dt><dd data-testid="engine-source">{source.label}</dd></div>
        <div className={e.stat}><dt>Last calc</dt>
          <dd data-testid="engine-calc-us">{engine.stats.lastCalcUs == null ? '—' : `${engine.stats.lastCalcUs.toFixed(1)} µs`}</dd></div>
        <div className={e.stat}><dt>Round trip p50</dt>
          <dd data-testid="engine-rtt">{quantile(rtt, 0.5) == null ? '—' : fmtMs(quantile(rtt, 0.5)!)}</dd></div>
        <div className={e.stat}><dt>Round trip p95</dt><dd>{quantile(rtt, 0.95) == null ? '—' : fmtMs(quantile(rtt, 0.95)!)}</dd></div>
        <div className={e.stat}><dt>Messages</dt>
          <dd data-testid="engine-messages">{engine.stats.sent} ↑ · {engine.stats.received} ↓</dd></div>
      </dl>
      {rtt.length > 1 && (
        <div className={e.row} style={{ marginTop: 8 }}>
          <Sparkline values={rtt} width={260} height={30} label={`Recent round-trip times, last ${fmtMs(rtt[rtt.length - 1])}`} />
          <span className={ui.note}>last {rtt.length} round trips (pings every 2 s plus requests), measured in the browser</span>
        </div>
      )}

      <Architecture connected={connected} backend={mcShown?.backend ?? null} source={source.kind} />

      <div className={e.grid}>
        <div className={e.box}>
          <div className={e.boxHead}><span>Engine vs browser agreement</span><span>per share, all legs</span></div>
          {blocker ? <p className={ui.note}>{blocker}</p> : (
            <>
              <div className={e.row}>
                <Button size="sm" variant="primary" onClick={runAgree} disabled={agree?.busy} data-testid="engine-price-portfolio">
                  {agree?.busy ? 'Pricing…' : `Price ${legs.length} leg${legs.length > 1 ? 's' : ''} on engine`}
                </Button>
                {maxDiff != null && (
                  <span data-testid="engine-agreement" data-value={maxDiff}>
                    max |engine − browser| = <b className="mono">{maxDiff.toExponential(2)}</b>
                  </span>
                )}
              </div>
              {agree?.error && agree.key === aKey && <p className="neg" style={{ marginTop: 8 }}>{agree.error}</p>}
              {agreeRows && (
                <div className={ui.tableWrap} style={{ marginTop: 8 }}>
                  <table className={ui.table}>
                    <thead><tr><th>Leg</th><th className={ui.num}>Engine</th><th className={ui.num}>Browser</th><th className={ui.num}>Max |Δ| (5 Greeks)</th></tr></thead>
                    <tbody>
                      {agreeRows.map(x => (
                        <tr key={x.l.id}>
                          <td className="mono">{legLabel(x.l)}</td>
                          <td className={ui.num}>{x.g.price.toFixed(6)}</td>
                          <td className={ui.num}>{x.b.price.toFixed(6)}</td>
                          <td className={ui.num}>{x.diff.toExponential(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {agree?.res && <p className={ui.note} style={{ marginTop: 6 }}>batch_bs_full: {agree.res.calcUs.toFixed(1)} µs in C++ · {fmtMs(agree.res.rttMs)} round trip</p>}
                </div>
              )}
            </>
          )}
        </div>

        <div className={e.box}>
          <div className={e.boxHead}><span>Native Monte Carlo</span><span>one contract per run · seed 42</span></div>
          {blocker ? <p className={ui.note}>{blocker}</p> : (
            <>
              <div className={e.row}>
                {legs.length > 1 && (
                  <Segmented size="sm" label="Leg to simulate" value={idx} onChange={setLegIdx}
                             options={legs.map((_, i) => ({ value: i, label: `Leg ${i + 1}` }))} />
                )}
                <Segmented size="sm" label="Paths" value={paths} onChange={setPaths} testid="engine-paths"
                           options={[100_000, 1_000_000, 10_000_000].map(p => ({ value: p, label: fmtPaths(p) }))} />
                <Button size="sm" variant="primary" onClick={runMc} disabled={mc?.busy} data-testid="engine-run-mc">
                  {mc?.busy ? 'Simulating…' : 'Run'}
                </Button>
              </div>
              {mc?.error && mc.key === mKey && <p className="neg" style={{ marginTop: 8 }}>{mc.error}</p>}
              {mcShown && mcLeg && (
                <div className={e.result} data-testid="engine-mc-result" data-z={Math.abs(mcShown.price - mcRef) / mcShown.stdError}>
                  {legLabel(mcLeg)}<br />
                  MC {mcShown.price.toFixed(4)} ± {(Z95 * mcShown.stdError).toFixed(4)} (95%) · BS {mcRef.toFixed(4)} ·
                  |z| {(Math.abs(mcShown.price - mcRef) / mcShown.stdError).toFixed(2)}<br />
                  {fmtPaths(mcShown.paths)} paths in {fmtMs(mcShown.ms)} on {mcShown.backend === 'metal' ? 'Metal GPU' : 'CPU threads'} ({mcShown.device}) ·
                  {' '}{fmtMs(mcShown.rttMs)} round trip
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {!connected && (
        <>
          <div className={e.sectionTitle}>Run the engine locally</div>
          <pre className={e.cmd} data-testid="engine-offline-help">{`# Apple Silicon · CMake ≥ 3.21 · Python 3.9+ with pybind11 numpy fastapi uvicorn
git clone https://github.com/gkhurana21/quantcore && cd quantcore
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --parallel
python3 server/ws_server.py 8765

# second terminal
cd dashboard && npm install && npm run dev     # open http://localhost:3000`}</pre>
        </>
      )}

      <div className={e.sectionTitle}>Measured benchmarks</div>
      <div className={e.bench}>
        {BENCHMARKS.map(b => (
          <div key={b.label} className={e.benchCard}>
            <div className={e.benchValue}>{b.value}</div>
            <div className={e.benchLabel}>{b.label}</div>
            <div className={e.benchDetail}>{b.detail}</div>
          </div>
        ))}
      </div>
      <p className={ui.note} style={{ marginTop: 8 }}>{BENCH_SOURCE}</p>
    </div>
  );
}
