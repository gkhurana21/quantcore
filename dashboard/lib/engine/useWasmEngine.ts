'use client';

// The C++ pricing core compiled to WebAssembly, loaded once per page.
//
// Status is reported honestly: 'ready' only after the module has been fetched,
// compiled, instantiated and has passed its ABI check. Pricing calls run on the main
// thread (microseconds per leg); Monte Carlo runs in a dedicated Web Worker so long
// simulations never block the page.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineMcRequest } from './useEngine';
import type { QuantcoreWasm, WasmManifest } from './wasm';
import { loadQuantcore, WASM_MANIFEST_PATH, WASM_PATH } from './wasm';

export type WasmStatus = 'loading' | 'ready' | 'unavailable';

export interface WasmMcRun { price: number; stdError: number; paths: number; ms: number; }

export interface WasmEngine {
  status: WasmStatus;
  module: QuantcoreWasm | null;
  manifest: WasmManifest | null;
  loadMs: number | null;
  error: string | null;
  runMc: (req: EngineMcRequest) => Promise<WasmMcRun>;
}

type WasmState = Omit<WasmEngine, 'runMc'>;

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
  const pendingRef = useRef(new Map<number, { resolve: (r: WasmMcRun) => void; reject: (e: Error) => void }>());
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

  const runMc = useCallback((req: EngineMcRequest) => new Promise<WasmMcRun>((resolve, reject) => {
    const pending = pendingRef.current;
    let w = workerRef.current;
    if (!w) {
      try {
        w = new Worker(new URL('../../workers/wasm.worker.ts', import.meta.url));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: WasmMcRun; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.ok && e.data.result) p.resolve(e.data.result);
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
    pending.set(id, { resolve, reject });
    w.postMessage({ id, url: new URL(WASM_PATH, window.location.href).href, req });
  }), []);

  return { ...state, runMc };
}
