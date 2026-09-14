// Web Worker for Monte Carlo on the WebAssembly build of the C++ core, so a
// multi-million-path run never blocks the page. The module loads once per worker.

import type { EngineMcRequest } from '../lib/engine/useEngine';
import type { QuantcoreWasm } from '../lib/engine/wasm';
import { loadQuantcore } from '../lib/engine/wasm';

interface McMessage { id: number; url: string; req: EngineMcRequest; }

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<McMessage>) => void) | null;
};

let loading: Promise<QuantcoreWasm> | null = null;

ctx.onmessage = async ({ data: { id, url, req } }) => {
  let w: QuantcoreWasm;
  try {
    loading ??= loadQuantcore(url);
    w = await loading;
  } catch (err) {
    loading = null;
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const t0 = performance.now();
  const res = w.mcPrice(req.call, req.S, req.K, req.r, req.sigma, req.T, req.paths, req.seed, req.q);
  const ms = performance.now() - t0;
  ctx.postMessage(res
    ? { id, ok: true, result: { ...res, ms } }
    : { id, ok: false, error: 'Monte Carlo inputs are outside the engine’s domain' });
};
