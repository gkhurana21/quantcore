// Loader for the C++ pricing core compiled to WebAssembly.
//
// bindings/quantcore_wasm.cpp is built by scripts/build-wasm.sh from the same
// core/src sources as the native engine (black_scholes.cpp, monte_carlo.cpp). The
// module is standalone — no Emscripten JavaScript glue — so it instantiates the same
// way in the page, in a Web Worker and in Node (the unit tests). Inputs are validated
// here: the C++ entry points assume positive S, K, sigma and T.

import type { Greeks, Leg, Market } from '../quant/types';
import { legSigma } from '../quant/volSurface';

export const WASM_PATH = '/wasm/quantcore.wasm';
export const WASM_MANIFEST_PATH = '/wasm/quantcore.json';
export const WASM_ABI = 1;
export const MAX_WASM_PATHS = 50_000_000;

/** Written by scripts/build-wasm.sh next to the module. */
export interface WasmManifest {
  abi: number;
  emscripten: string;
  flags: string[];
  bytes: number;
  sha256: string;
  sources: { path: string; sha256: string }[];
}

export interface WasmMcResult { price: number; stdError: number; paths: number; }

export interface QuantcoreWasm {
  abi: number;
  bytes: number;
  imports: string[];
  bsFull(call: boolean, S: number, K: number, r: number, sigma: number, T: number, q?: number): Greeks | null;
  mcPrice(call: boolean, S: number, K: number, r: number, sigma: number, T: number,
          paths: number, seed?: number, q?: number): WasmMcResult | null;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  qc_abi_version(): number;
  qc_out(): number;
  qc_bs_full(call: number, S: number, K: number, r: number, sigma: number, T: number, q: number): void;
  qc_mc_price(call: number, S: number, K: number, r: number, sigma: number, T: number,
              paths: number, seed: number, q: number): void;
}

const positive = (v: number) => Number.isFinite(v) && v > 0;
const validMarket = (S: number, K: number, r: number, sigma: number, T: number, q: number) =>
  positive(S) && positive(K) && positive(sigma) && positive(T) && Number.isFinite(r) && Number.isFinite(q);

export async function instantiateQuantcore(bytes: BufferSource): Promise<QuantcoreWasm> {
  const compiled = await WebAssembly.compile(bytes);
  // A standalone module may import a few WASI calls (abort paths). None is reachable
  // from these entry points, so each is stubbed to fail loudly if it ever is.
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {};
  const names: string[] = [];
  for (const imp of WebAssembly.Module.imports(compiled)) {
    names.push(`${imp.module}.${imp.name}`);
    if (imp.kind !== 'function') throw new Error(`quantcore.wasm: unsupported import ${imp.module}.${imp.name} (${imp.kind})`);
    (imports[imp.module] ??= {})[imp.name] = () => { throw new Error(`quantcore.wasm called ${imp.module}.${imp.name}`); };
  }
  const instance = await WebAssembly.instantiate(compiled, imports);
  const ex = instance.exports as unknown as Exports;
  ex._initialize?.();                                   // run static constructors (reactor module)
  const abi = ex.qc_abi_version();
  if (abi !== WASM_ABI) throw new Error(`quantcore.wasm ABI ${abi}, expected ${WASM_ABI}`);

  let view = new Float64Array(ex.memory.buffer, ex.qc_out(), 8);
  const out = () => (view.buffer === ex.memory.buffer ? view : (view = new Float64Array(ex.memory.buffer, ex.qc_out(), 8)));

  return {
    abi,
    bytes: bytes.byteLength,
    imports: names,
    bsFull(call, S, K, r, sigma, T, q = 0) {
      if (!validMarket(S, K, r, sigma, T, q)) return null;
      ex.qc_bs_full(call ? 1 : 0, S, K, r, sigma, T, q);
      const o = out();
      const g: Greeks = { price: o[0], delta: o[1], gamma: o[2], theta: o[3], vega: o[4] };
      return Number.isFinite(g.price) && Number.isFinite(g.delta) && Number.isFinite(g.gamma) &&
             Number.isFinite(g.theta) && Number.isFinite(g.vega) ? g : null;
    },
    mcPrice(call, S, K, r, sigma, T, paths, seed = 42, q = 0) {
      if (!validMarket(S, K, r, sigma, T, q) || !Number.isInteger(paths) || paths < 2 || paths > MAX_WASM_PATHS ||
          !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) return null;
      ex.qc_mc_price(call ? 1 : 0, S, K, r, sigma, T, paths, seed, q);
      const o = out();
      return Number.isFinite(o[0]) && Number.isFinite(o[1]) ? { price: o[0], stdError: o[1], paths: o[2] } : null;
    },
  };
}

export async function loadQuantcore(url = WASM_PATH): Promise<QuantcoreWasm> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quantcore.wasm: HTTP ${res.status}`);
  return instantiateQuantcore(await res.arrayBuffer());
}

/** Per-share Greeks for every leg at its smile volatility, or null if any leg is outside the module's domain. */
export function wasmLegGreeks(w: QuantcoreWasm, legs: Leg[], m: Market): Greeks[] | null {
  const out: Greeks[] = [];
  for (const l of legs) {
    const g = w.bsFull(l.call, m.S, l.K, m.r, legSigma(m, l.K, l.T), l.T, m.q);
    if (!g) return null;
    out.push(g);
  }
  return out;
}
