// Web Worker for Monte Carlo on the WebAssembly build of the C++ core — one contract, a whole
// portfolio, or a portfolio under local volatility — so a long run never blocks the page. The
// module loads once per worker.

import type { EngineMcRequest } from '../lib/engine/useEngine';
import type { QuantcoreWasm } from '../lib/engine/wasm';
import { loadQuantcore } from '../lib/engine/wasm';
import type { Leg, Market } from '../lib/quant/types';

export interface PortfolioMcRequest { legs: Leg[]; market: Market; paths: number; seed: number; antithetic: boolean; }

export interface LocalVolMcRequest {
  legs: Leg[]; market: Market; paths: number; seed: number; stepsPerYear: number; extrapolate: boolean;
}

type McMessage =
  | { id: number; url: string; kind: 'mc'; req: EngineMcRequest }
  | { id: number; url: string; kind: 'portfolio'; req: PortfolioMcRequest }
  | { id: number; url: string; kind: 'localvol'; req: LocalVolMcRequest };

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<McMessage>) => void) | null;
};

let loading: Promise<QuantcoreWasm> | null = null;

ctx.onmessage = async ({ data: msg }) => {
  let w: QuantcoreWasm;
  try {
    loading ??= loadQuantcore(msg.url);
    w = await loading;
  } catch (err) {
    loading = null;
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const t0 = performance.now();
  const res = msg.kind === 'portfolio'
    ? w.mcPortfolio(msg.req.legs, msg.req.market, msg.req.paths, msg.req.seed, msg.req.antithetic)
    : msg.kind === 'localvol'
      ? w.mcLocalVol(msg.req.legs, msg.req.market, msg.req.paths, msg.req.seed, msg.req.stepsPerYear, msg.req.extrapolate)
      : w.mcPrice(msg.req.call, msg.req.S, msg.req.K, msg.req.r, msg.req.sigma, msg.req.T, msg.req.paths, msg.req.seed, msg.req.q);
  const ms = performance.now() - t0;
  ctx.postMessage(res
    ? { id: msg.id, ok: true, result: { ...res, ms } }
    : { id: msg.id, ok: false, error: 'Monte Carlo inputs are outside the engine’s domain' });
};
