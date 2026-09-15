// Loader for the C++ pricing core compiled to WebAssembly.
//
// bindings/quantcore_wasm.cpp is built by scripts/build-wasm.sh from the same
// core/src sources as the native engine (black_scholes.cpp, monte_carlo.cpp). The
// module is standalone — no Emscripten JavaScript glue — so it instantiates the same
// way in the page, in a Web Worker and in Node (the unit tests). Inputs are validated
// here: the C++ entry points assume positive S, K, sigma and T.

import type { BarrierPrices, ExoticMcResult, ExoticSpec } from '../quant/exotics';
import { MAX_ASIAN_FIXINGS, MAX_BARRIER_LEVELS } from '../quant/exotics';
import type { Greeks, Leg, Market } from '../quant/types';
import { CONTRACT_MULT, signedQty } from '../quant/types';
import { legSigma } from '../quant/volSurface';

export const WASM_PATH = '/wasm/quantcore.wasm';
export const WASM_MANIFEST_PATH = '/wasm/quantcore.json';
export const WASM_ABI = 4;
export const MAX_WASM_PATHS = 50_000_000;
/** Cap on paths × legs for one portfolio run, so a single-threaded run stays within seconds. */
export const MAX_WASM_PORTFOLIO_WORK = 64_000_000;
/** Cap on paths × time steps × local-variance evaluations (3 a step with Richardson) for one local-vol run. */
export const MAX_WASM_LOCAL_VOL_WORK = 300_000_000;
/** Term-structure pillars the module's surface buffer holds. */
export const WASM_TERM_PILLARS = 32;
const SURFACE_SIZE = 13 + 2 * WASM_TERM_PILLARS;
// exotic input: kind, call, K, T, up, n_levels, levels × 16, n_fixings; output: see bindings/quantcore_wasm.cpp
const EXOTIC_SPEC_SIZE = 7 + MAX_BARRIER_LEVELS;
const EXOTIC_OUT_SIZE = 6 + 5 * MAX_BARRIER_LEVELS + 6;

/** Evaluations for one exotic path as the engines count them: time steps (fixings add steps) × three a step with Richardson × barrier levels. */
export function exoticWorkPerPath(spec: ExoticSpec, m: Market, stepsPerYear: number, extrapolate: boolean): number {
  const steps = Math.ceil(spec.T * stepsPerYear) + (spec.kind === 'asian' ? spec.fixings : 0);
  return steps * (extrapolate && m.smile ? 3 : 1) * (1 + (spec.kind === 'barrier' ? spec.levels.length : 0) / 4);
}

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
  /** Continuously monitored barrier option in closed form — the C++ port of barrierPrices. */
  barrierPrices(call: boolean, up: boolean, S: number, K: number, H: number, T: number, sigma: number, r: number, q: number): BarrierPrices | null;
  /** Geometric-average Asian option on n equally spaced fixings — the C++ port of geometricAsianPrice. */
  geometricAsian(call: boolean, S: number, K: number, T: number, n: number, sigma: number, r: number, q: number): number | null;
  /**
   * A barrier (Brownian-bridge monitoring, every level on the same paths) or Asian option under the market's local
   * volatility, per unit of underlying: log-Euler, optionally with coupled Richardson extrapolation.
   */
  mcExotic(spec: ExoticSpec, m: Market, paths: number, seed: number, stepsPerYear: number, extrapolate: boolean): ExoticMcResult | null;
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
  qc_exotic_spec(): number;
  qc_exotic_spec_size(): number;
  qc_exotic_out(): number;
  qc_exotic_out_size(): number;
  qc_barrier_prices(call: number, up: number, S: number, K: number, H: number, T: number, sigma: number, r: number, q: number): void;
  qc_geometric_asian(call: number, S: number, K: number, T: number, n: number, sigma: number, r: number, q: number): number;
  qc_mc_exotic(paths: number, seed: number, stepsPerYear: number, extrapolate: number): void;
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
  if (ex.qc_exotic_spec_size() !== EXOTIC_SPEC_SIZE || ex.qc_exotic_out_size() !== EXOTIC_OUT_SIZE) {
    throw new Error(`quantcore.wasm exotic buffers ${ex.qc_exotic_spec_size()}/${ex.qc_exotic_out_size()}, expected ${EXOTIC_SPEC_SIZE}/${EXOTIC_OUT_SIZE}`);
  }

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
    barrierPrices(call, up, S, K, H, T, sigma, r, q) {
      if (!validMarket(S, K, r, sigma, T, q) || !positive(H)) return null;
      ex.qc_barrier_prices(call ? 1 : 0, up ? 1 : 0, S, K, H, T, sigma, r, q);
      const o = out();
      return Number.isFinite(o[0]) && Number.isFinite(o[1]) && Number.isFinite(o[2]) ? { out: o[0], in: o[1], vanilla: o[2] } : null;
    },
    geometricAsian(call, S, K, T, n, sigma, r, q) {
      if (!validMarket(S, K, r, sigma, T, q) || !Number.isInteger(n) || n < 1 || n > MAX_ASIAN_FIXINGS) return null;
      return finiteOrNull(ex.qc_geometric_asian(call ? 1 : 0, S, K, T, n, sigma, r, q));
    },
    mcExotic(spec, m, paths, seed, stepsPerYear, extrapolate) {
      if (!Number.isInteger(paths) || paths < 2 || paths > MAX_WASM_PATHS ||
          !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff ||
          !(stepsPerYear > 0 && stepsPerYear <= 100_000) || !positive(spec.K) || !positive(spec.T)) return null;
      const v = new Float64Array(EXOTIC_SPEC_SIZE);
      v[1] = spec.call ? 1 : 0; v[2] = spec.K; v[3] = spec.T;
      if (spec.kind === 'barrier') {
        const n = spec.levels.length;
        if (!n || n > MAX_BARRIER_LEVELS || !spec.levels.every(positive)) return null;
        v[0] = 0; v[4] = spec.up ? 1 : 0; v[5] = n;
        v.set(spec.levels, 6);
      } else {
        if (!Number.isInteger(spec.fixings) || spec.fixings < 1 || spec.fixings > MAX_ASIAN_FIXINGS) return null;
        v[0] = 1; v[6 + MAX_BARRIER_LEVELS] = spec.fixings;
      }
      if (paths * exoticWorkPerPath(spec, m, stepsPerYear, extrapolate) > MAX_WASM_LOCAL_VOL_WORK || !setSurface(m)) return null;
      new Float64Array(ex.memory.buffer, ex.qc_exotic_spec(), EXOTIC_SPEC_SIZE).set(v);
      ex.qc_mc_exotic(paths, seed, stepsPerYear, extrapolate ? 1 : 0);
      const o = new Float64Array(ex.memory.buffer, ex.qc_exotic_out(), EXOTIC_OUT_SIZE);
      if (!Number.isFinite(o[2]) || !Number.isFinite(o[3])) return null;
      const L = MAX_BARRIER_LEVELS, n = o[5], k = 6 + 5 * L;
      const block = (b: number) => Array.from(o.subarray(6 + b * L, 6 + b * L + n));
      return {
        paths: o[0], steps: o[1], vanilla: o[2], vanillaSe: o[3], vanillaFineBias: finiteOrNull(o[4]),
        out: block(0), outSe: block(1), outFineBias: block(2).map(finiteOrNull), in: block(3), inSe: block(4),
        arith: finiteOrNull(o[k]), arithSe: finiteOrNull(o[k + 1]), arithFineBias: finiteOrNull(o[k + 2]),
        geo: finiteOrNull(o[k + 3]), geoSe: finiteOrNull(o[k + 4]), arithGeoCov: finiteOrNull(o[k + 5]),
      };
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
