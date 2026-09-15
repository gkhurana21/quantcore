// Web Worker for Monte Carlo on the WebAssembly build of the C++ core — one contract, a whole
// portfolio, a portfolio under local volatility, or an exotic option — so a long run never blocks
// the page. The module loads once per worker.

import type { EngineMcRequest } from '../lib/engine/useEngine';
import type { PdeSpec, QuantcoreWasm } from '../lib/engine/wasm';
import { loadQuantcore } from '../lib/engine/wasm';
import type { ExoticSpec } from '../lib/quant/exotics';
import type { Leg, Market } from '../lib/quant/types';

export interface PortfolioMcRequest { legs: Leg[]; market: Market; paths: number; seed: number; antithetic: boolean; }

export interface LocalVolMcRequest {
  legs: Leg[]; market: Market; paths: number; seed: number; stepsPerYear: number; extrapolate: boolean;
}

export interface ExoticMcRequest {
  spec: ExoticSpec; market: Market; paths: number; seed: number; stepsPerYear: number; extrapolate: boolean;
}

/** Several finite-difference solves in one message, each option on its own market (e.g. the surface and flat σ). */
export interface PdeBatchRequest { items: { spec: PdeSpec; market: Market }[]; nodes: number; steps: number; }

type McMessage =
  | { id: number; url: string; kind: 'mc'; req: EngineMcRequest }
  | { id: number; url: string; kind: 'portfolio'; req: PortfolioMcRequest }
  | { id: number; url: string; kind: 'localvol'; req: LocalVolMcRequest }
  | { id: number; url: string; kind: 'exotic'; req: ExoticMcRequest }
  | { id: number; url: string; kind: 'pde'; req: PdeBatchRequest };

const ctx = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<McMessage>) => void) | null;
};

let loading: Promise<QuantcoreWasm> | null = null;

function run(w: QuantcoreWasm, msg: McMessage): object | null {
  switch (msg.kind) {
    case 'portfolio':
      return w.mcPortfolio(msg.req.legs, msg.req.market, msg.req.paths, msg.req.seed, msg.req.antithetic);
    case 'localvol':
      return w.mcLocalVol(msg.req.legs, msg.req.market, msg.req.paths, msg.req.seed, msg.req.stepsPerYear, msg.req.extrapolate);
    case 'exotic':
      return w.mcExotic(msg.req.spec, msg.req.market, msg.req.paths, msg.req.seed, msg.req.stepsPerYear, msg.req.extrapolate);
    case 'pde': {
      const { nodes, steps } = msg.req;
      return { results: msg.req.items.map(it => w.pde(it.spec, it.market, nodes, steps)) };
    }
    default:
      return w.mcPrice(msg.req.call, msg.req.S, msg.req.K, msg.req.r, msg.req.sigma, msg.req.T, msg.req.paths, msg.req.seed, msg.req.q);
  }
}

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
  const res = run(w, msg);
  const ms = performance.now() - t0;
  ctx.postMessage(res
    ? { id: msg.id, ok: true, result: { ...res, ms } }
    : { id: msg.id, ok: false, error: 'Monte Carlo inputs are outside the engine’s domain' });
};
