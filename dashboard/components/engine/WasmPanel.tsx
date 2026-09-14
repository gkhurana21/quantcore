'use client';

import { useMemo, useState } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { bsGreeks } from '@/lib/quant/blackScholes';
import type { WasmEngine, WasmMcRun } from '@/lib/engine/useWasmEngine';
import { wasmLegGreeks } from '@/lib/engine/wasm';
import { legLabel, legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { legSigma } from '@/lib/quant/volSurface';
import { Badge, Button, Segmented, ui } from '@/components/ui/primitives';
import { fmtMs, fmtPaths, Z95 } from '@/components/lab/labFormat';
import e from './engine.module.css';

const GREEKS = ['price', 'delta', 'gamma', 'theta', 'vega'] as const;
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** The C++ core compiled to WebAssembly: build facts, agreement with TypeScript, and Monte Carlo in a worker. */
export function WasmPanel({ wasm, legs, market }: { wasm: WasmEngine; legs: Leg[]; market: Market }) {
  const ready = wasm.status === 'ready' && wasm.module != null;

  const agreement = useMemo(() => {
    if (!wasm.module) return null;
    const per = wasmLegGreeks(wasm.module, legs, market);
    if (!per) return null;
    let worst = 0;
    legs.forEach((l, i) => {
      const b = bsGreeks(l.call, market.S, l.K, l.T, legSigma(market, l.K, l.T), market.r, market.q);
      for (const k of GREEKS) worst = Math.max(worst, Math.abs(per[i][k] - b[k]));
    });
    return worst;
  }, [wasm.module, legs, market]);

  const [legIdx, setLegIdx] = useState(0);
  const [paths, setPaths] = useState(1_000_000);
  const idx = Math.min(legIdx, legs.length - 1);
  const key = `${legsKeyOf(legs)}|${marketKeyOf(market)}|${idx}|${paths}`;
  const [mc, setMc] = useState<{ key: string; busy: boolean; res?: WasmMcRun; error?: string } | null>(null);
  const run = async () => {
    const l = legs[idx];
    setMc({ key, busy: true });
    try {
      const res = await wasm.runMc({ call: l.call, S: market.S, K: l.K, r: market.r, sigma: legSigma(market, l.K, l.T), T: l.T,
                                     paths, seed: 42, q: market.q });
      setMc({ key, busy: false, res });
    } catch (err) {
      setMc({ key, busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };
  const leg = legs[idx];
  const ref = leg ? bsGreeks(leg.call, market.S, leg.K, leg.T, legSigma(market, leg.K, leg.T), market.r, market.q).price : 0;
  const shown = mc?.res && mc.key === key ? mc.res : null;
  const z = shown && shown.stdError > 0 ? Math.abs(shown.price - ref) / shown.stdError : null;

  return (
    <div data-testid="wasm-panel">
      <div className={e.head}>
        <Badge tone={ready ? 'good' : wasm.status === 'loading' ? 'warn' : 'muted'} testid="engine-wasm-status">
          {ready ? 'Ready' : wasm.status === 'loading' ? 'Loading…' : 'Unavailable'}
        </Badge>
        <span className={e.url}>C++17 core → WebAssembly · runs in this tab</span>
        {wasm.manifest && (
          <span className={e.url} data-testid="wasm-build">
            {kb(wasm.manifest.bytes)} · Emscripten {wasm.manifest.emscripten} · ABI {wasm.manifest.abi}
            {wasm.loadMs != null && ` · loaded in ${fmtMs(wasm.loadMs)}`}
          </span>
        )}
      </div>
      <p className={e.reason}>
        {ready
          ? <>The same <code>black_scholes.cpp</code> and <code>monte_carlo.cpp</code> that build the native library, compiled
              with Emscripten into a standalone module with no JavaScript glue. It prices the Greeks tiles whenever the native
              engine is not connected, including on the hosted site. It is single-threaded and portable: the Metal GPU kernel
              and Accelerate SIMD paths exist only in the native build.</>
          : wasm.status === 'loading'
            ? 'Loading the WebAssembly module…'
            : `The WebAssembly module could not be loaded${wasm.error ? ` (${wasm.error})` : ''}, so pricing falls back to the TypeScript models.`}
      </p>

      {ready && (
        <div className={e.grid}>
          <div className={e.box}>
            <div className={e.boxHead}><span>WebAssembly vs TypeScript</span><span>per share, all legs</span></div>
            {agreement == null
              ? <p className={ui.note}>A leg is outside the model’s domain (expiry or volatility not positive).</p>
              : (
                <p data-testid="wasm-agreement" data-value={agreement}>
                  max |C++ − TypeScript| across {legs.length} leg{legs.length > 1 ? 's' : ''} × 5 Greeks ={' '}
                  <b className="mono">{agreement.toExponential(2)}</b>
                </p>
              )}
            <p className={ui.note} style={{ marginTop: 6 }}>
              Two independent implementations of the same formulas: the C++ core uses the C library’s erfc, the TypeScript
              models a double-precision Hart/West normal CDF.
            </p>
          </div>

          <div className={e.box}>
            <div className={e.boxHead}><span>Monte Carlo in WebAssembly</span><span>mt19937_64 · seed 42 · Web Worker</span></div>
            <div className={e.row}>
              {legs.length > 1 && (
                <Segmented size="sm" label="Leg to simulate" value={idx} onChange={setLegIdx}
                           options={legs.map((_, i) => ({ value: i, label: `Leg ${i + 1}` }))} />
              )}
              <Segmented size="sm" label="WebAssembly paths" value={paths} onChange={setPaths} testid="wasm-paths"
                         options={[100_000, 1_000_000, 10_000_000].map(p => ({ value: p, label: fmtPaths(p) }))} />
              <Button size="sm" variant="primary" onClick={run} disabled={mc?.busy} data-testid="wasm-run-mc">
                {mc?.busy ? 'Simulating…' : 'Run'}
              </Button>
            </div>
            {mc?.error && mc.key === key && <p className="neg" style={{ marginTop: 8 }}>{mc.error}</p>}
            {shown && leg && (
              <div className={e.result} data-testid="wasm-mc-result" data-z={z ?? ''} data-price={shown.price}>
                {legLabel(leg)}<br />
                MC {shown.price.toFixed(4)} ± {(Z95 * shown.stdError).toFixed(4)} (95%) · BS {ref.toFixed(4)} ·
                |z| {z == null ? '—' : z.toFixed(2)}<br />
                {fmtPaths(shown.paths)} paths in {fmtMs(shown.ms)} · single-threaded WebAssembly
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
