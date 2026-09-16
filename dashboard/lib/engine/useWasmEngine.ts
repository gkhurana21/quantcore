'use client';

// The C++ pricing core compiled to WebAssembly, loaded once per page.
//
// Status is reported honestly: 'ready' only after the module has been fetched,
// compiled, instantiated and has passed its ABI check. Pricing calls run on the main
// thread (microseconds per leg); Monte Carlo runs in a dedicated Web Worker so long
// simulations never block the page.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExoticMcResult, ExoticSpec } from '../quant/exotics';
import type { Leg, Market } from '../quant/types';
import type { EngineMcRequest } from './useEngine';
import type { LsmResult, PdeResult, PdeSpec, QuantcoreWasm, WasmManifest } from './wasm';
import { loadQuantcore, PDE_GRID, WASM_MANIFEST_PATH, WASM_PATH } from './wasm';

export type WasmStatus = 'loading' | 'ready' | 'unavailable';

export interface WasmMcRun { price: number; stdError: number; paths: number; ms: number; }

export interface WasmLocalVolRun extends WasmMcRun { steps: number; fineBias: number | null; }

export interface WasmExoticRun extends ExoticMcResult { ms: number; }

/** One result per requested option, null where the inputs are outside the solver's domain; ms for the whole batch. */
export interface WasmPdeRun { results: (PdeResult | null)[]; ms: number; }

export interface WasmLsmRun extends LsmResult { ms: number; }

export interface WasmEngine {
  status: WasmStatus;
  module: QuantcoreWasm | null;
  manifest: WasmManifest | null;
  loadMs: number | null;
  error: string | null;
  runMc: (req: EngineMcRequest) => Promise<WasmMcRun>;
  /** The whole portfolio by Monte Carlo in the worker, each leg at its smile volatility ($ value). */
  runPortfolioMc: (legs: Leg[], market: Market, paths: number, seed: number, antithetic: boolean) => Promise<WasmMcRun>;
  /** The portfolio under the market's Dupire local volatility, in the worker ($ value). */
  runLocalVolMc: (legs: Leg[], market: Market, paths: number, seed: number, stepsPerYear: number,
                  extrapolate: boolean) => Promise<WasmLocalVolRun>;
  /** A barrier or Asian option under the market's local volatility, in the worker (per unit of underlying). */
  runExoticMc: (spec: ExoticSpec, market: Market, paths: number, seed: number, stepsPerYear: number,
                extrapolate: boolean) => Promise<WasmExoticRun>;
  /** Finite-difference solves (European, American, knock-out) under each item's market, in the worker. */
  runPde: (items: { spec: PdeSpec; market: Market }[], nodes?: number, steps?: number) => Promise<WasmPdeRun>;
  /** An American option by Longstaff–Schwartz under the market's local volatility, in the worker. */
  runLsm: (call: boolean, K: number, T: number, market: Market, policyPaths: number, valuePaths: number,
           seed: number, dates: number, stepsPerYear: number) => Promise<WasmLsmRun>;
}

type WasmState = Omit<WasmEngine, 'runMc' | 'runPortfolioMc' | 'runLocalVolMc' | 'runExoticMc' | 'runPde' | 'runLsm'>;
type WorkerKind = 'mc' | 'portfolio' | 'localvol' | 'exotic' | 'pde' | 'lsm';

let shared: Promise<{ module: QuantcoreWasm; loadMs: number }> | null = null;

function loadOnce() {
  if (!shared) {
    const t0 = performance.now();
    const p = loadQuantcore(WASM_PATH).then(module => ({ module, loadMs: performance.now() - t0 }));
    p.catch(() => { if (shared === p) shared = null; });
    shared = p;
  }
  return shared;
}

export function useWasmEngine(): WasmEngine {
  const [state, setState] = useState<WasmState>({ status: 'loading', module: null, manifest: null, loadMs: null, error: null });
  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef(new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>());
  const seqRef = useRef(0);

  useEffect(() => {
    let live = true;
    if (typeof WebAssembly === 'undefined') {
      setState(s => ({ ...s, status: 'unavailable', error: 'WebAssembly is not supported in this browser' }));
      return;
    }
    loadOnce()
      .then(({ module, loadMs }) => { if (live) setState(s => ({ ...s, status: 'ready', module, loadMs, error: null })); })
      .catch(err => { if (live) setState(s => ({ ...s, status: 'unavailable', error: err instanceof Error ? err.message : String(err) })); });
    fetch(WASM_MANIFEST_PATH)
      .then(r => (r.ok ? r.json() as Promise<WasmManifest> : null))
      .then(manifest => { if (live && manifest) setState(s => ({ ...s, manifest })); })
      .catch(() => { /* the manifest is informational */ });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      pending.forEach(p => p.reject(new Error('WebAssembly engine unmounted')));
      pending.clear();
    };
  }, []);

  // each kind resolves with its own result shape, to which the worker adds the run time in ms
  const call = useCallback(<T>(kind: WorkerKind, req: unknown) => new Promise<T>((resolve, reject) => {
    const pending = pendingRef.current;
    let w = workerRef.current;
    if (!w) {
      try {
        w = new Worker(new URL('../../workers/wasm.worker.ts', import.meta.url));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.ok && e.data.result !== undefined) p.resolve(e.data.result);
        else p.reject(new Error(e.data.error ?? 'WebAssembly Monte Carlo failed'));
      };
      w.onerror = e => {
        e.preventDefault();
        pending.forEach(p => p.reject(new Error('WebAssembly worker failed')));
        pending.clear();
        workerRef.current?.terminate();
        workerRef.current = null;
      };
      workerRef.current = w;
    }
    const id = ++seqRef.current;
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    w.postMessage({ id, url: new URL(WASM_PATH, window.location.href).href, kind, req });
  }), []);

  const runMc = useCallback((req: EngineMcRequest) => call<WasmMcRun>('mc', req), [call]);
  const runPortfolioMc = useCallback((legs: Leg[], market: Market, paths: number, seed: number, antithetic: boolean) =>
    call<WasmMcRun>('portfolio', { legs, market, paths, seed, antithetic }), [call]);
  const runLocalVolMc = useCallback((legs: Leg[], market: Market, paths: number, seed: number, stepsPerYear: number,
                                     extrapolate: boolean) =>
    call<WasmLocalVolRun>('localvol', { legs, market, paths, seed, stepsPerYear, extrapolate }), [call]);
  const runExoticMc = useCallback((spec: ExoticSpec, market: Market, paths: number, seed: number, stepsPerYear: number,
                                   extrapolate: boolean) =>
    call<WasmExoticRun>('exotic', { spec, market, paths, seed, stepsPerYear, extrapolate }), [call]);
  const runPde = useCallback((items: { spec: PdeSpec; market: Market }[], nodes: number = PDE_GRID.nodes,
                              steps: number = PDE_GRID.steps) =>
    call<WasmPdeRun>('pde', { items, nodes, steps }), [call]);
  const runLsm = useCallback((call_: boolean, K: number, T: number, market: Market, policyPaths: number,
                              valuePaths: number, seed: number, dates: number, stepsPerYear: number) =>
    call<WasmLsmRun>('lsm', { call: call_, K, T, market, policyPaths, valuePaths, seed, dates, stepsPerYear }), [call]);

  return { ...state, runMc, runPortfolioMc, runLocalVolMc, runExoticMc, runPde, runLsm };
}
