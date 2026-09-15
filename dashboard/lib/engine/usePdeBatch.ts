'use client';

// Finite-difference solves in the WebAssembly worker for a view: requested when the inputs settle, latest request
// wins, and a result is reported with the key of the inputs it belongs to so a view never pairs new inputs with old
// numbers.

import { useEffect, useRef, useState } from 'react';
import type { Market } from '../quant/types';
import type { WasmEngine } from './useWasmEngine';
import type { PdeResult, PdeSpec } from './wasm';
import { PDE_GRID } from './wasm';

export interface PdeItem { spec: PdeSpec; market: Market; }

export interface PdeBatch {
  /** The latest completed batch and the inputs it belongs to. */
  result: { key: string; results: (PdeResult | null)[]; ms: number } | null;
  /** True when `result` belongs to the current inputs. */
  current: boolean;
  busy: boolean;
  error: string | null;
}

/** `items` null pauses the view (inactive tab); `key` identifies the inputs the items were built from. */
export function usePdeBatch(wasm: WasmEngine, items: PdeItem[] | null, key: string,
                            grid: { nodes: number; steps: number } = PDE_GRID, debounceMs = 150): PdeBatch {
  const [result, setResult] = useState<PdeBatch['result']>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const seq = useRef(0);
  const started = useRef<string | null>(null);
  const { runPde } = wasm;
  const ready = wasm.status === 'ready';
  const active = items != null;
  const { nodes, steps } = grid;

  useEffect(() => {
    if (!active || !ready || started.current === key) return;
    const timer = setTimeout(async () => {
      const list = itemsRef.current;
      if (!list) return;
      const id = ++seq.current;
      started.current = key;
      setBusy(true);
      setError(null);
      try {
        const res = list.length ? await runPde(list, nodes, steps) : { results: [], ms: 0 };
        if (id === seq.current) setResult({ key, results: res.results, ms: res.ms });
      } catch (err) {
        if (id !== seq.current) return;
        started.current = null;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [active, ready, key, runPde, nodes, steps, debounceMs]);

  return { result, current: result?.key === key, busy, error };
}
