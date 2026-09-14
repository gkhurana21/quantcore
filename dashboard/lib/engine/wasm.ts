// Loader for the C++ pricing core compiled to WebAssembly.
//
// bindings/quantcore_wasm.cpp is built by scripts/build-wasm.sh from the same
// core/src sources as the native engine (black_scholes.cpp, monte_carlo.cpp). The
// module is standalone — no Emscripten JavaScript glue — so it instantiates the same
// way in the page, in a Web Worker and in Node (the unit tests). Inputs are validated
// here: the C++ entry points assume positive S, K, sigma and T.

import type { Greeks, Leg, Market } from '../quant/types';
import { CONTRACT_MULT, signedQty } from '../quant/types';
import { legSigma } from '../quant/volSurface';

export const WASM_PATH = '/wasm/quantcore.wasm';
export const WASM_MANIFEST_PATH = '/wasm/quantcore.json';
export const WASM_ABI = 3;
export const MAX_WASM_PATHS = 50_000_000;
/** Cap on paths × legs for one portfolio run, so a single-threaded run stays within seconds. */
export const MAX_WASM_PORTFOLIO_WORK = 64_000_000;
/** Cap on paths × time steps × local-variance evaluations (3 a step with Richardson) for one local-vol run. */
export const MAX_WASM_LOCAL_VOL_WORK = 300_000_000;
/** Term-structure pillars the module's surface buffer holds. */
export const WASM_TERM_PILLARS = 32;
const SURFACE_SIZE = 13 + 2 * WASM_TERM_PILLARS;

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

export interface WasmLocalVolResult extends WasmMcResult {
  steps: number;              // time steps per path (the fine grid when extrapolating)
  fineBias: number | null;    // coarse − fine mean when extrapolating
}

export interface QuantcoreWasm {
  abi: number;
  bytes: number;
  imports: string[];
  bsFull(call: boolean, S: number, K: number, r: number, sigma: number, T: number, q?: number): Greeks | null;
  mcPrice(call: boolean, S: number, K: number, r: number, sigma: number, T: number,
          paths: number, seed?: number, q?: number): WasmMcResult | null;
  /** $ value of the portfolio by Monte Carlo, each leg at its smile volatility on shared Brownian paths. */
  mcPortfolio(legs: Leg[], m: Market, paths: number, seed?: number, antithetic?: boolean): WasmMcResult | null;
  maxLegs: number;
  /** Implied volatility of strike K at expiry T on the market's surface — the C++ port of legSigma. */
  impliedVol(m: Market, K: number, T: number): number | null;
  /** Dupire local volatility at spot S and time t — the C++ port of localVol. */
  localVol(m: Market, S: number, t: number): number | null;
  /** $ value under the market's local volatility: log-Euler, optionally with coupled Richardson extrapolation. */
  mcLocalVol(legs: Leg[], m: Market, paths: number, seed: number, stepsPerYear: number, extrapolate: boolean): WasmLocalVolResult | null;
}

/** The module's surface buffer for a market: S, r, q, σ, smile, centre, term kind and parameters, pillars. */
export function surfaceBuffer(m: Market): Float64Array | null {
  if (!positive(m.S) || !positive(m.sigma) || !Number.isFinite(m.r) || !Number.isFinite(m.q)) return null;
  const v = new Float64Array(SURFACE_SIZE);
  v[0] = m.S; v[1] = m.r; v[2] = m.q; v[3] = m.sigma;
  if (m.smile) { v[4] = 1; v[5] = m.smile.rho; v[6] = m.smile.eta; v[7] = m.smile.gamma; }
  v[8] = m.smileSpot ?? 0;
  const t = m.term;
  if (t?.kind === 'curve') {
    v[9] = 1; v[10] = t.ratio; v[11] = t.halfLife;
  } else if (t?.kind === 'fitted') {
    if (!t.T.length || t.T.length > WASM_TERM_PILLARS || t.T.length !== t.w.length) return null;
    v[9] = 2; v[12] = t.T.length;
    t.T.forEach((T, i) => { v[13 + i] = T; v[13 + WASM_TERM_PILLARS + i] = t.w[i]; });
  }
  return v;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  qc_abi_version(): number;
  qc_out(): number;
  qc_bs_full(call: number, S: number, K: number, r: number, sigma: number, T: number, q: number): void;
  qc_mc_price(call: number, S: number, K: number, r: number, sigma: number, T: number,
              paths: number, seed: number, q: number): void;
  qc_legs(): number;
  qc_max_legs(): number;
  qc_mc_portfolio(n: number, S: number, r: number, q: number, paths: number, seed: number, antithetic: number): void;
  qc_surface(): number;
  qc_surface_size(): number;
  qc_implied_vol(K: number, T: number): number;
  qc_local_vol(S: number, t: number): number;
  qc_mc_local_vol(n: number, paths: number, seed: number, stepsPerYear: number, extrapolate: number): void;
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
  if (ex.qc_surface_size() !== SURFACE_SIZE) throw new Error(`quantcore.wasm surface buffer ${ex.qc_surface_size()}, expected ${SURFACE_SIZE}`);

  let view = new Float64Array(ex.memory.buffer, ex.qc_out(), 8);
  const out = () => (view.buffer === ex.memory.buffer ? view : (view = new Float64Array(ex.memory.buffer, ex.qc_out(), 8)));
  const setSurface = (m: Market) => {
    const buf = surfaceBuffer(m);
    if (buf) new Float64Array(ex.memory.buffer, ex.qc_surface(), SURFACE_SIZE).set(buf);
    return !!buf;
  };
  const finiteOrNull = (v: number) => (Number.isFinite(v) ? v : null);

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
    maxLegs: ex.qc_max_legs(),
    mcPortfolio(legs, m, paths, seed = 42, antithetic = false) {
      const n = legs.length;
      if (!n || n > ex.qc_max_legs() || !positive(m.S) || !Number.isFinite(m.r) || !Number.isFinite(m.q) ||
          !Number.isInteger(paths) || paths < 2 || paths > MAX_WASM_PATHS || paths * n > MAX_WASM_PORTFOLIO_WORK ||
          !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) return null;
      const rows = new Float64Array(5 * n);
      for (let i = 0; i < n; i++) {
        const l = legs[i], sigma = legSigma(m, l.K, l.T);
        if (!positive(l.K) || !Number.isFinite(l.T) || !positive(sigma) || !(l.qty > 0)) return null;
        rows.set([l.call ? 1 : 0, l.K, l.T, sigma, signedQty(l) * CONTRACT_MULT], 5 * i);
      }
      new Float64Array(ex.memory.buffer, ex.qc_legs(), 5 * n).set(rows);
      ex.qc_mc_portfolio(n, m.S, m.r, m.q, paths, seed, antithetic ? 1 : 0);
      const o = out();
      return Number.isFinite(o[0]) && Number.isFinite(o[1]) ? { price: o[0], stdError: o[1], paths: o[2] } : null;
    },
    impliedVol(m, K, T) {
      if (!Number.isFinite(K) || !Number.isFinite(T) || !setSurface(m)) return null;
      return finiteOrNull(ex.qc_implied_vol(K, T));
    },
    localVol(m, S, t) {
      if (!positive(S) || !Number.isFinite(t) || !setSurface(m)) return null;
      return finiteOrNull(ex.qc_local_vol(S, t));
    },
    mcLocalVol(legs, m, paths, seed, stepsPerYear, extrapolate) {
      const n = legs.length;
      if (!n || n > ex.qc_max_legs() || !Number.isInteger(paths) || paths < 2 || paths > MAX_WASM_PATHS ||
          !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff ||
          !(stepsPerYear > 0 && stepsPerYear <= 100_000)) return null;
      const lastT = legs.reduce((a, l) => Math.max(a, l.T), 0);
      const work = paths * (Math.ceil(lastT * stepsPerYear) + n) * (extrapolate && m.smile ? 3 : 1);
      if (work > MAX_WASM_LOCAL_VOL_WORK || !setSurface(m)) return null;
      const rows = new Float64Array(5 * n);
      for (let i = 0; i < n; i++) {
        const l = legs[i];
        if (!positive(l.K) || !Number.isFinite(l.T) || !(l.qty > 0)) return null;
        rows.set([l.call ? 1 : 0, l.K, l.T, 0, signedQty(l) * CONTRACT_MULT], 5 * i);
      }
      new Float64Array(ex.memory.buffer, ex.qc_legs(), 5 * n).set(rows);
      ex.qc_mc_local_vol(n, paths, seed, stepsPerYear, extrapolate ? 1 : 0);
      const o = out();
      return Number.isFinite(o[0]) && Number.isFinite(o[1])
        ? { price: o[0], stdError: o[1], paths: o[2], steps: o[3], fineBias: finiteOrNull(o[4]) }
        : null;
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
