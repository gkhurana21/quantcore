/**
 * The C++ pricing core compiled to WebAssembly (dashboard/public/wasm/quantcore.wasm).
 *
 * The committed module must match its manifest and the current C++ sources — a source
 * edit without `scripts/build-wasm.sh` fails here — load with no imports, and agree with
 * the native C++ build (python bindings) and with the TypeScript models. Comparisons with
 * the native build skip where the bindings are not built (Linux CI); everything else runs
 * everywhere, so CI checks the C++ pricing code through WebAssembly.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { bsGreeks, bsPrice } from '../lib/quant/blackScholes';
import type { ExoticSpec } from '../lib/quant/exotics';
import {
  barrierPrices, barrierPricesDiscrete, barrierPricesRebate, controlVariate, geometricAsianPrice,
} from '../lib/quant/exotics';
import { localVol, mcLocalVol } from '../lib/quant/localVol';
import { mulberry32 } from '../lib/quant/rng';
import type { Leg, Market, Smile, TermStructure } from '../lib/quant/types';
import { CONTRACT_MULT, signedQty } from '../lib/quant/types';
import { fittedTerm, legSigma, SMILE_PRESETS, TERM_PRESETS } from '../lib/quant/volSurface';
import { portfolioValue } from '../lib/strategy/portfolio';

/** SPY iron condor on the 47-day expiry plus a long 6-month call. */
function condorWithCalendar(): Leg[] {
  const leg = (id: string, call: boolean, side: 'buy' | 'sell', K: number, T = 0.129, qty = 10): Leg =>
    ({ id, call, side, qty, K, T, premium: 0 });
  return [leg('p1', false, 'buy', 715), leg('p2', false, 'sell', 735), leg('c1', true, 'sell', 775),
          leg('c2', true, 'buy', 795), leg('cal', true, 'buy', 760, 0.5, 5)];
}
import { crrAmericanPrice } from '../lib/quant/binomial';
import type { PdeSpec, QuantcoreWasm, WasmManifest } from '../lib/engine/wasm';
import { instantiateQuantcore, MAX_WASM_PATHS, WASM_ABI } from '../lib/engine/wasm';

const ROOT = path.resolve(__dirname, '..', '..');
const WASM_DIR = path.join(ROOT, 'dashboard', 'public', 'wasm');
const MAC_PY = '/Library/Developer/CommandLineTools/usr/bin/python3';
const PY = existsSync(MAC_PY) ? MAC_PY : 'python3';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/**
 * The bindings read the wire protocol's snake_case keys; the TypeScript models are camelCase. Handing a model
 * straight to Python would leave `rebateAtHit` unread and silently price the rebate at the hit.
 */
function toNative<T extends object>(spec: T): Record<string, unknown> {
  const { rebateAtHit, ...rest } = spec as T & { rebateAtHit?: boolean };
  return rebateAtHit === undefined ? { ...rest } : { ...rest, rebate_at_hit: rebateAtHit };
}
const bytes = readFileSync(path.join(WASM_DIR, 'quantcore.wasm'));
const manifest: WasmManifest = JSON.parse(readFileSync(path.join(WASM_DIR, 'quantcore.json'), 'utf8'));

/** Evaluate a Python expression over `x` (the JSON input) with the native quantcore module. */
function native<T>(expr: string, input: unknown): T {
  const script = `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'python'))}); ` +
    `import quantcore; x = json.load(sys.stdin); print(json.dumps(${expr}))`;
  return JSON.parse(execFileSync(PY, ['-c', script], { input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'ignore'] }).toString());
}

function nativeAvailable(): boolean {
  try { native('1', null); return true; } catch { return false; }
}

interface Contract { call: boolean; S: number; K: number; r: number; sigma: number; T: number; q: number; }

function grid(): Contract[] {
  const cases: Contract[] = [];
  for (const S of [50, 100, 756.48, 3000]) for (const kr of [0.5, 0.9, 1, 1.1, 2]) for (const T of [0.01, 0.129, 1, 5])
    for (const sigma of [0.05, 0.2, 0.8]) for (const q of [0, 0.03]) for (const call of [true, false])
      cases.push({ call, S, K: S * kr, r: 0.045, sigma, T, q });
  return cases;
}

const KEYS = ['price', 'delta', 'gamma', 'theta', 'vega'] as const;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(b), 1);

let w: QuantcoreWasm;
test.beforeAll(async () => { w = await instantiateQuantcore(bytes); });

test.describe('C++ core compiled to WebAssembly', () => {
  test('the committed module matches its manifest and the current C++ sources', () => {
    expect(manifest.abi).toBe(WASM_ABI);
    expect(manifest.emscripten).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bytes.length).toBe(manifest.bytes);
    expect(sha256(bytes)).toBe(manifest.sha256);
    expect(manifest.sources.map(s => s.path)).toEqual(expect.arrayContaining(
      ['core/src/black_scholes.cpp', 'core/src/monte_carlo.cpp', 'core/src/monte_carlo_portfolio.cpp', 'core/src/local_vol.cpp',
       'core/include/quantcore/ziggurat.hpp', 'bindings/quantcore_wasm.cpp']));
    const stale = manifest.sources.filter(s => sha256(readFileSync(path.join(ROOT, s.path))) !== s.sha256).map(s => s.path);
    expect(stale, 'C++ sources changed without rebuilding the module: run scripts/build-wasm.sh').toEqual([]);
  });

  test('is standalone: no imports, ABI checked', () => {
    expect(w.imports).toEqual([]);
    expect(w.abi).toBe(WASM_ABI);
  });

  test('Greeks match the native C++ build to 1e-12 on 960 contracts, with and without dividends', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const cases = grid();
    const ref = native<Record<(typeof KEYS)[number], number>[]>(
      '[quantcore.bs_full(0 if c["call"] else 1, c["S"], c["K"], c["r"], c["sigma"], c["T"], c["q"]) for c in x]', cases);
    const bad: string[] = [];
    let identical = 0;
    cases.forEach((c, i) => {
      const g = w.bsFull(c.call, c.S, c.K, c.r, c.sigma, c.T, c.q)!;
      for (const k of KEYS) {
        if (g[k] === ref[i][k]) identical++;
        else if (!close(g[k], ref[i][k])) bad.push(`${JSON.stringify(c)} ${k}: wasm ${g[k]} native ${ref[i][k]}`);
      }
    });
    console.log(`  wasm vs native bs_full: ${identical}/${cases.length * KEYS.length} values bit-identical, the rest within 1e-12`);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('Greeks match the TypeScript models to 1e-12 on the same grid', () => {
    const bad: string[] = [];
    for (const c of grid()) {
      const g = w.bsFull(c.call, c.S, c.K, c.r, c.sigma, c.T, c.q)!;
      const b = bsGreeks(c.call, c.S, c.K, c.T, c.sigma, c.r, c.q);
      for (const k of KEYS) if (!close(g[k], b[k])) bad.push(`${JSON.stringify(c)} ${k}: wasm ${g[k]} ts ${b[k]}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('put-call parity holds inside the module with a dividend yield', () => {
    const cases: [number, number, number, number, number, number][] =
      [[100, 95, 0.05, 0.25, 0.75, 0.02], [930, 900, 0.08, 0.2, 2 / 12, 0.03], [42, 60, 0, 0.9, 3, 0.07]];
    for (const [S, K, r, sigma, T, q] of cases) {
      const c = w.bsFull(true, S, K, r, sigma, T, q)!, p = w.bsFull(false, S, K, r, sigma, T, q)!;
      expect(Math.abs(c.price - p.price - (S * Math.exp(-q * T) - K * Math.exp(-r * T)))).toBeLessThan(1e-12 * S);
      expect(Math.abs(c.delta - p.delta - Math.exp(-q * T))).toBeLessThan(1e-14);
      expect(c.gamma).toBe(p.gamma);
      expect(c.vega).toBe(p.vega);
    }
  });

  test('Monte Carlo with the same seed reproduces the native C++ result to 1e-12', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const runs = [
      { call: true, S: 756.48, K: 755, r: 0.045, sigma: 0.138, T: 0.129, paths: 100_000, seed: 42, q: 0 },
      { call: false, S: 142.35, K: 150, r: 0.03, sigma: 0.38, T: 0.6, paths: 200_000, seed: 7, q: 0.02 },
      { call: true, S: 930, K: 900, r: 0.08, sigma: 0.2, T: 2 / 12, paths: 1_000_000, seed: 123_456, q: 0.03 },
    ];
    const ref = native<{ price: number; std_error: number; paths: number }[]>(
      '[quantcore.mc_price(0 if c["call"] else 1, c["S"], c["K"], c["r"], c["sigma"], c["T"], c["paths"], c["seed"], q=c["q"]) for c in x]',
      runs);
    runs.forEach((c, i) => {
      const m = w.mcPrice(c.call, c.S, c.K, c.r, c.sigma, c.T, c.paths, c.seed, c.q)!;
      // Both builds draw the same mt19937_64 stream through libc++'s normal_distribution;
      // only the C library's exp/log rounding can differ, so results agree to rounding.
      expect(Math.abs(m.price - ref[i].price)).toBeLessThanOrEqual(1e-12 * ref[i].price);
      expect(Math.abs(m.stdError - ref[i].std_error)).toBeLessThanOrEqual(1e-12 * ref[i].std_error);
      expect(m.paths).toBe(ref[i].paths);
    });
  });

  test('Monte Carlo is seeded, deterministic and consistent with Black-Scholes', () => {
    const a = w.mcPrice(true, 756.48, 755, 0.045, 0.138, 0.129, 200_000, 42)!;
    const b = w.mcPrice(true, 756.48, 755, 0.045, 0.138, 0.129, 200_000, 42)!;
    const c = w.mcPrice(true, 756.48, 755, 0.045, 0.138, 0.129, 200_000, 43)!;
    expect(b).toEqual(a);
    expect(c.price).not.toBe(a.price);
    const bs = bsGreeks(true, 756.48, 755, 0.129, 0.138, 0.045, 0).price;
    for (const r of [a, c]) expect(Math.abs(r.price - bs) / r.stdError).toBeLessThan(4);
  });

  test('portfolio Monte Carlo reproduces the native C++ result for the same seed', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'] };
    const legs = condorWithCalendar();
    const sigma = legs.map(l => legSigma(m, l.K, l.T));
    for (const antithetic of [false, true]) {
      const a = w.mcPortfolio(legs, m, 400_000, 11, antithetic)!;
      const ref = native<{ price: number; std_error: number; paths: number }>(
        'quantcore.mc_portfolio(x["is_call"], x["K"], x["T"], x["sigma"], x["weight"], x["S"], x["r"], x["q"], x["paths"], x["seed"], x["antithetic"])',
        { is_call: legs.map(l => (l.call ? 1 : 0)), K: legs.map(l => l.K), T: legs.map(l => l.T), sigma,
          weight: legs.map(l => signedQty(l) * CONTRACT_MULT), S: m.S, r: m.r, q: m.q, paths: 400_000, seed: 11, antithetic });
      // same mt19937_64 stream and algorithm; only the C library's exp rounding may differ
      expect(Math.abs(a.price - ref.price)).toBeLessThanOrEqual(1e-12 * Math.abs(ref.price) + 1e-9);
      expect(Math.abs(a.stdError - ref.std_error)).toBeLessThanOrEqual(1e-12 * ref.std_error);
      expect(a.paths).toBe(ref.paths);
    }
  });

  test('portfolio Monte Carlo is consistent with Black-Scholes and with the single-contract kernel', () => {
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'] };
    const legs = condorWithCalendar();
    const ref = portfolioValue(legs, m);
    for (const [paths, antithetic] of [[1_000_000, false], [1_000_000, true]] as const) {
      const run = w.mcPortfolio(legs, m, paths, 5, antithetic)!;
      expect(run.paths).toBe(paths);
      expect(Math.abs(run.price - ref) / run.stdError).toBeLessThan(4);
    }
    // one long call: the portfolio kernel equals the single-contract kernel on the same seed
    const one: Leg = { id: 'c', call: true, side: 'buy', qty: 1, K: 755, T: 0.129, premium: 0 };
    const flat: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0 };
    const port = w.mcPortfolio([one], flat, 500_000, 42)!;
    const single = w.mcPrice(true, 756.48, 755, 0.045, 0.138, 0.129, 500_000, 42)!;
    expect(Math.abs(port.price / CONTRACT_MULT - single.price)).toBeLessThan(1e-12 * single.price);
    // domain: no legs, a non-positive strike, too much work
    expect(w.mcPortfolio([], flat, 1000)).toBeNull();
    expect(w.mcPortfolio([{ ...one, K: 0 }], flat, 1000)).toBeNull();
    expect(w.mcPortfolio(Array.from({ length: 8 }, (_, i) => ({ ...one, id: `c${i}` })), flat, 10_000_000)).toBeNull();
  });

  test('implied and local volatility match the TypeScript surface across random smiles and term structures', () => {
    const u = mulberry32(77);
    const range = (a: number, b: number) => a + (b - a) * u();
    const days = [7, 30, 91, 365];
    const bad: string[] = [];
    let worstImplied = 0, worstLocal = 0, n = 0;
    for (let i = 0; i < 400; i++) {
      const rho = range(-0.9, 0.5);
      const smile: Smile | null = i % 4 === 3 ? null : { rho, eta: range(0.1, 0.95) * (2 / (1 + Math.abs(rho))), gamma: range(0.1, 0.5) };
      let term: TermStructure | null = null;
      if (i % 3 === 1) term = { kind: 'curve', ratio: range(0.4, 2.5), halfLife: range(0.02, 1) };
      if (i % 3 === 2) {
        const theta: number[] = [];
        days.forEach((d, j) => theta.push(Math.max(theta[j - 1] ?? 0, range(0.12, 0.3) ** 2 * (d / 365))));
        term = fittedTerm(days.map(d => d / 365), theta)!.term;
      }
      const S = range(50, 1000);
      const m: Market = { S, sigma: range(0.08, 0.6), r: range(0, 0.06), q: range(0, 0.03), smile, term,
                          ...(smile && i % 5 === 4 ? { smileSpot: S * range(0.9, 1.1) } : {}) };
      for (const T of [2 / 365, 0.05, 0.3, 1.2]) for (const x of [0.7, 0.9, 1, 1.15, 1.4]) {
        const K = S * x;
        const a = w.impliedVol(m, K, T)!, b = legSigma(m, K, T);
        const c = w.localVol(m, K, T)!, d = localVol(m, K, T);
        // relative to the browser's value, floored: a pooled (flat) stretch of a fitted term structure has zero forward
        // variance, where both kernels return exactly 0 and a plain ratio would be 0/0
        const ei = Math.abs(a - b) / Math.max(b, 1e-6), el = Math.abs(c - d) / Math.max(d, 1e-6);
        worstImplied = Math.max(worstImplied, ei);
        worstLocal = Math.max(worstLocal, el);
        if (!(ei <= 1e-12)) bad.push(`implied ${a} vs ${b} ${JSON.stringify({ m, K, T })}`);
        if (!(el <= 1e-12)) bad.push(`local ${c} vs ${d} ${JSON.stringify({ m, K, T })}`);
        n += 2;
      }
    }
    console.log(`  wasm vs TypeScript surface: ${n} values, worst relative difference implied ${worstImplied.toExponential(1)}, local ${worstLocal.toExponential(1)}`);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('local-vol Monte Carlo reproduces the native C++ result for the same seed', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const legs = condorWithCalendar();
    for (const extrapolate of [false, true]) {
      const a = w.mcLocalVol(legs, m, 200_000, 9, 365, extrapolate)!;
      const ref = native<{ price: number; std_error: number; paths: number; steps: number; fine_bias: number | null }>(
        'quantcore.mc_local_vol(x["is_call"], x["K"], x["T"], x["weight"], x["market"], x["paths"], x["seed"], x["spy"], x["extrapolate"], 0)',
        { is_call: legs.map(l => (l.call ? 1 : 0)), K: legs.map(l => l.K), T: legs.map(l => l.T),
          weight: legs.map(l => signedQty(l) * CONTRACT_MULT), market: m, paths: 200_000, seed: 9, spy: 365, extrapolate });
      // same mt19937_64 stream, ziggurat tables and algorithm; only exp/log/pow rounding and FMA contraction differ
      expect(Math.abs(a.price - ref.price)).toBeLessThanOrEqual(1e-12 * Math.abs(ref.price) + 1e-9);
      expect(Math.abs(a.stdError - ref.std_error)).toBeLessThanOrEqual(1e-12 * ref.std_error + 1e-9);
      expect(a.steps).toBe(ref.steps);
      if (extrapolate) expect(Math.abs(a.fineBias! - ref.fine_bias!)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(ref.fine_bias!)));
      else expect(a.fineBias).toBeNull();
    }
  });

  test('local-vol Monte Carlo agrees with the surface’s Black-Scholes value and the TypeScript kernel; domain checks', () => {
    test.setTimeout(120_000);
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const legs = condorWithCalendar();
    const ref = portfolioValue(legs, m);
    const a = w.mcLocalVol(legs, m, 400_000, 21, 365, true)!;
    const ts = mcLocalVol(legs, m, 60_000, 21, 365, true);
    console.log(`  surface value ${ref.toFixed(2)} · wasm ${a.price.toFixed(2)} ± ${a.stdError.toFixed(2)} · TypeScript ${ts.price.toFixed(2)} ± ${ts.se.toFixed(2)}`);
    expect(Math.abs(a.price - ref) / a.stdError).toBeLessThan(4);
    expect(Math.abs(a.price - ts.price) / Math.hypot(a.stdError, ts.se)).toBeLessThan(4);

    // no smile: exact variance steps, so four steps a year are unbiased
    const termOnly: Market = { ...m, smile: null };
    const e = w.mcLocalVol(legs, termOnly, 200_000, 3, 4, true)!;
    expect(Math.abs(e.price - portfolioValue(legs, termOnly)) / e.stdError).toBeLessThan(4);
    expect(e.fineBias).toBeNull();

    // domain: no legs, an invalid smile, too much work, more pillars than the module holds
    expect(w.mcLocalVol([], m, 1000, 1, 365, true)).toBeNull();
    expect(w.mcLocalVol(legs, { ...m, smile: { rho: -0.5, eta: -1, gamma: 0.4 } }, 1000, 1, 365, true)).toBeNull();
    expect(w.mcLocalVol(legs, m, 10_000_000, 1, 365, true)).toBeNull();
    const weekly = fittedTerm(Array.from({ length: 40 }, (_, i) => (i + 1) / 52), Array.from({ length: 40 }, (_, i) => (0.04 * (i + 1)) / 52))!;
    expect(w.mcLocalVol(legs, { ...m, sigma: weekly.sigma, term: weekly.term }, 1000, 1, 365, true)).toBeNull();
  });

  test('exotic closed forms match the TypeScript formulas to 1e-12', () => {
    const bad: string[] = [];
    let n = 0, worst = 0;
    const cmp = (label: string, a: number, b: number) => {
      worst = Math.max(worst, Math.abs(a - b) / Math.max(Math.abs(b), 1));
      if (!close(a, b)) bad.push(`${label}: wasm ${a} ts ${b}`);
      n++;
    };
    for (const call of [true, false]) for (const up of [false, true]) for (const K of [80, 100, 120])
      for (const H of [70, 90, 99, 101, 110, 130]) for (const T of [0.05, 1]) for (const sigma of [0.12, 0.45]) for (const q of [0, 0.03]) {
        const a = w.barrierPrices(call, up, 100, K, H, T, sigma, 0.045, q), b = barrierPrices(call, up, 100, K, H, T, sigma, 0.045, q);
        const tag = JSON.stringify({ call, up, K, H, T, sigma, q });
        if (!a) { bad.push(`null ${tag}`); continue; }
        cmp(`out ${tag}`, a.out, b.out);
        cmp(`in ${tag}`, a.in, b.in);
        cmp(`vanilla ${tag}`, a.vanilla, b.vanilla);
        // the same barrier monitored on a finite number of dates; 0 must be the continuous price exactly
        for (const monitors of [0, 12, 252]) {
          const d = w.barrierPricesDiscrete(call, up, 100, K, H, T, sigma, 0.045, q, monitors);
          const e = barrierPricesDiscrete(call, up, 100, K, H, T, sigma, 0.045, q, monitors);
          if (!d) { bad.push(`null discrete m=${monitors} ${tag}`); continue; }
          cmp(`out m=${monitors} ${tag}`, d.out, e.out);
          cmp(`in m=${monitors} ${tag}`, d.in, e.in);
          if (monitors === 0 && d.out !== a.out) bad.push(`m=0 is not the continuous price ${tag}: ${d.out} vs ${a.out}`);
        }
        // paying a rebate, at the hit and at expiry; 0 must leave the plain price untouched
        for (const rebate of [0, 2.5]) for (const atHit of [true, false]) {
          const d = w.barrierPricesRebate(call, up, 100, K, H, T, sigma, 0.045, q, rebate, atHit);
          const e = barrierPricesRebate(call, up, 100, K, H, T, sigma, 0.045, q, rebate, atHit);
          if (!d) { bad.push(`null rebate ${rebate} ${tag}`); continue; }
          cmp(`out rebate ${rebate} ${atHit} ${tag}`, d.out, e.out);
          cmp(`in rebate ${rebate} ${atHit} ${tag}`, d.in, e.in);
          if (rebate === 0 && (d.out !== a.out || d.in !== a.in)) bad.push(`rebate 0 moved the price ${tag}`);
        }
      }
    for (const call of [true, false]) for (const fixings of [1, 2, 12, 52, 365]) for (const K of [80, 100, 120]) for (const T of [0.1, 1, 3]) {
      cmp(`asian ${JSON.stringify({ call, fixings, K, T })}`, w.geometricAsian(call, 100, K, T, fixings, 0.3, 0.045, 0.02) ?? NaN,
          geometricAsianPrice(call, 100, K, T, fixings, 0.3, 0.045, 0.02));
    }
    console.log(`  wasm vs TypeScript exotic closed forms: ${n} values, worst relative difference ${worst.toExponential(1)}`);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('exotic Monte Carlo reproduces the native C++ result for the same seed', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const specs: ExoticSpec[] = [
      { kind: 'barrier', call: true, K: 756, T: 0.25, up: false, levels: [640, 680, 700, 720, 740] },
      { kind: 'barrier', call: false, K: 740, T: 0.4, up: true, levels: [780, 820] },
      // tested on 13 dates instead of continuously: the spec buffer's monitoring slot, through the browser build
      { kind: 'barrier', call: true, K: 756, T: 0.25, up: false, levels: [640, 700, 740], monitors: 13 },
      // paying a rebate, at the hit and at expiry: the spec buffer's two rebate slots
      { kind: 'barrier', call: true, K: 756, T: 0.25, up: false, levels: [700, 740], rebate: 12, rebateAtHit: true },
      { kind: 'barrier', call: false, K: 740, T: 0.4, up: true, levels: [800], rebate: 12, rebateAtHit: false },
      { kind: 'asian', call: true, K: 750, T: 0.5, fixings: 26 },
    ];
    interface NativeExotic {
      steps: number; monitors: number; vanilla: number; vanilla_se: number; vanilla_fine_bias: number | null;
      out: number[]; out_se: number[]; out_fine_bias: (number | null)[]; in: number[]; in_se: number[];
      arith: number | null; arith_se: number | null; arith_fine_bias: number | null;
      geo: number | null; geo_se: number | null; arith_geo_cov: number | null;
    }
    // same mt19937_64 stream, ziggurat tables and algorithm; only exp/log/pow rounding and FMA contraction differ
    const near = (a: number | null | undefined, b: number | null) =>
      a == null || b === null ? a === b : Math.abs(a - b) <= 1e-12 * Math.abs(b) + 1e-9;
    let compared = 0;
    for (const spec of specs) for (const extrapolate of [false, true]) {
      const a = w.mcExotic(spec, m, 50_000, 13, 365, extrapolate)!;
      const ref = native<NativeExotic>('quantcore.mc_exotic(x["spec"], x["market"], x["paths"], x["seed"], x["spy"], x["extrapolate"], 0)',
                                       { spec: toNative(spec), market: m, paths: 50_000, seed: 13, spy: 365, extrapolate });
      expect(a.steps).toBe(ref.steps);
      expect(a.monitors).toBe(ref.monitors);
      expect(a.out.length).toBe(ref.out.length);
      const pairs: [string, number | null | undefined, number | null][] = [
        ['vanilla', a.vanilla, ref.vanilla], ['vanilla_se', a.vanillaSe, ref.vanilla_se],
        ['vanilla_fine_bias', a.vanillaFineBias, ref.vanilla_fine_bias],
        ['arith', a.arith, ref.arith], ['arith_se', a.arithSe, ref.arith_se], ['arith_fine_bias', a.arithFineBias, ref.arith_fine_bias],
        ['geo', a.geo, ref.geo], ['geo_se', a.geoSe, ref.geo_se], ['arith_geo_cov', a.arithGeoCov, ref.arith_geo_cov],
        ...ref.out.flatMap((_, j): [string, number | null | undefined, number | null][] => [
          [`out[${j}]`, a.out[j], ref.out[j]], [`out_se[${j}]`, a.outSe[j], ref.out_se[j]],
          [`out_fine_bias[${j}]`, a.outFineBias[j], ref.out_fine_bias[j]], [`in[${j}]`, a.in[j], ref.in[j]], [`in_se[${j}]`, a.inSe[j], ref.in_se[j]],
        ]),
      ];
      const bad = pairs.filter(([, x, y]) => !near(x, y)).map(([k, x, y]) => `${spec.kind} extrapolate=${extrapolate} ${k}: wasm ${x} native ${y}`);
      expect(bad).toEqual([]);
      compared += pairs.length;
    }
    console.log(`  wasm vs native mc_exotic: ${compared} values agree (barrier and Asian, with and without Richardson)`);
  });

  test('exotic Monte Carlo agrees with the closed forms under flat volatility and reprices the vanilla under local vol; domain checks', () => {
    test.setTimeout(120_000);
    const flat: Market = { S: 100, sigma: 0.25, r: 0.08, q: 0.04 };
    const zs: number[] = [];
    for (const call of [true, false]) for (const up of [false, true]) {
      const levels = up ? [106, 112, 120] : [80, 88, 94];
      const a = w.mcExotic({ kind: 'barrier', call, K: 100, T: 0.5, up, levels }, flat, 400_000, zs.length + 1, 1, false)!;
      expect(a.steps).toBe(1);                                   // the bridge is exact under flat volatility: one step
      levels.forEach((H, j) => {
        const cf = barrierPrices(call, up, 100, 100, H, 0.5, 0.25, 0.08, 0.04);
        zs.push(Math.abs(a.out[j] - cf.out) / a.outSe[j], Math.abs(a.in[j] - cf.in) / a.inSe[j]);
        expect(Math.abs(a.out[j] + a.in[j] - a.vanilla)).toBeLessThan(1e-9);   // in-out parity, path by path
      });
    }
    const asian = w.mcExotic({ kind: 'asian', call: true, K: 100, T: 1, fixings: 12 }, { S: 100, sigma: 0.3, r: 0.05, q: 0 }, 400_000, 7, 1, false)!;
    const geoCf = geometricAsianPrice(true, 100, 100, 1, 12, 0.3, 0.05, 0);
    const cv = controlVariate(asian, geoCf)!;
    zs.push(Math.abs(asian.geo! - geoCf) / asian.geoSe!);
    console.log(`  flat barriers and geometric Asian: worst |z| ${Math.max(...zs).toFixed(2)} over ${zs.length} prices · arithmetic ` +
                `${asian.arith!.toFixed(4)} ± ${asian.arithSe!.toFixed(4)} → control variate ${cv.value.toFixed(4)} ± ${cv.se.toFixed(5)}`);
    expect(Math.max(...zs)).toBeLessThan(4);
    expect(asian.arith!).toBeGreaterThan(asian.geo!);
    expect(cv.se).toBeLessThan(asian.arithSe! / 10);
    expect(Math.abs(cv.value - asian.arith!) / asian.arithSe!).toBeLessThan(4);

    // local volatility: the vanilla simulated on the barrier's own paths reprices at the surface's implied volatility
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const lv = w.mcExotic({ kind: 'barrier', call: true, K: 756, T: 0.25, up: false, levels: [700] }, m, 150_000, 17, 365, true)!;
    const bs = bsPrice(true, 756.48, 756, 0.25, legSigma(m, 756, 0.25), 0.045, 0.01);
    expect(Math.abs(lv.vanilla - bs) / lv.vanillaSe).toBeLessThan(4);
    expect(lv.out[0]).toBeLessThan(lv.vanilla);
    expect(lv.vanillaFineBias).not.toBeNull();

    // domain: no levels, too many, a negative level, fixings outside 1..2000, too much work for one run
    const base = { kind: 'barrier', call: true, K: 100, T: 0.5, up: false } as const;
    expect(w.mcExotic({ ...base, levels: [] }, flat, 1000, 1, 1, false)).toBeNull();
    expect(w.mcExotic({ ...base, levels: Array.from({ length: 17 }, (_, i) => 60 + i) }, flat, 1000, 1, 1, false)).toBeNull();
    expect(w.mcExotic({ ...base, levels: [-90] }, flat, 1000, 1, 1, false)).toBeNull();
    expect(w.mcExotic({ kind: 'asian', call: true, K: 100, T: 1, fixings: 0 }, flat, 1000, 1, 1, false)).toBeNull();
    expect(w.mcExotic({ kind: 'asian', call: true, K: 100, T: 1, fixings: 2001 }, flat, 1000, 1, 1, false)).toBeNull();
    expect(w.mcExotic({ ...base, levels: [90] }, m, 10_000_000, 1, 365, true)).toBeNull();
  });

  test('finite-difference PDE agrees with the closed forms and a binomial lattice under flat volatility', () => {
    test.setTimeout(120_000);
    const flat: Market = { S: 100, sigma: 0.25, r: 0.05, q: 0.02 };
    let euro = 0;
    for (const call of [true, false]) for (const K of [90, 100, 110]) {
      const p = w.pde({ kind: 'european', call, K, T: 1 }, flat)!;
      const g = bsGreeks(call, 100, K, 1, 0.25, 0.05, 0.02);
      euro = Math.max(euro, Math.abs(p.price - g.price) / g.price);
      expect(Math.abs(p.delta - g.delta)).toBeLessThan(1e-4);
      expect(Math.abs(p.gamma - g.gamma) / g.gamma).toBeLessThan(1e-3);
      expect(Math.abs(p.theta - g.theta) / Math.abs(g.theta)).toBeLessThan(1e-3);
      expect(p.boundary).toEqual([]);
    }
    const barrierM: Market = { S: 100, sigma: 0.25, r: 0.08, q: 0.04 };
    let knock = 0;
    for (const [call, up, K, H] of [[true, false, 100, 92], [false, true, 100, 108], [true, true, 95, 115], [false, false, 105, 90]] as const) {
      const p = w.pde({ kind: 'knockout', call, K, T: 0.5, H, up }, barrierM)!;
      knock = Math.max(knock, Math.abs(p.price - barrierPrices(call, up, 100, K, H, 0.5, 0.25, 0.08, 0.04).out));
    }
    // Hull's American put against a 4,000-step lattice (odd and even step counts averaged)
    const hull: Market = { S: 50, sigma: 0.4, r: 0.1, q: 0 };
    const am = w.pde({ kind: 'american', call: false, K: 50, T: 5 / 12 }, hull)!;
    const crr = 0.5 * (crrAmericanPrice(false, 50, 50, 5 / 12, 0.4, 0.1, 0, 4000) + crrAmericanPrice(false, 50, 50, 5 / 12, 0.4, 0.1, 0, 4001));
    console.log(`  PDE: European worst relative error ${euro.toExponential(1)}, knock-outs worst |diff| ${knock.toExponential(1)}, ` +
                `American put ${am.price.toFixed(4)} vs lattice ${crr.toFixed(4)}, boundary ${am.boundary[0].S?.toFixed(2)} → ${am.boundary[am.boundary.length - 1].S?.toFixed(2)}`);
    expect(euro).toBeLessThan(2e-4);
    expect(knock).toBeLessThan(2e-3);
    expect(Math.abs(am.price - crr)).toBeLessThan(2e-3);
    expect(am.boundary.length).toBe(64);
    expect(am.boundary.every((b, j) => b.S != null && b.S < 50 && (j === 0 || b.S <= am.boundary[j - 1].S!))).toBe(true);

    // domain: no strike, no expiry, a knock-out without a barrier, too few nodes, an invalid surface
    expect(w.pde({ kind: 'european', call: true, K: 0, T: 1 }, flat)).toBeNull();
    expect(w.pde({ kind: 'european', call: true, K: 100, T: 0 }, flat)).toBeNull();
    expect(w.pde({ kind: 'knockout', call: true, K: 100, T: 1, up: false }, flat)).toBeNull();
    expect(w.pde({ kind: 'european', call: true, K: 100, T: 1 }, flat, 11, 100)).toBeNull();
    expect(w.pde({ kind: 'european', call: true, K: 100, T: 1 }, { ...flat, smile: { rho: 0.2, eta: -1, gamma: 0.4 } })).toBeNull();
  });

  test('finite-difference PDE reproduces the native C++ result on a local-volatility surface', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const specs: PdeSpec[] = [
      { kind: 'european', call: true, K: 760, T: 0.25 },
      { kind: 'american', call: false, K: 740, T: 0.5 },
      { kind: 'knockout', call: true, K: 755, T: 0.25, H: 700, up: false },
      { kind: 'knockout', call: false, K: 740, T: 0.4, H: 800, up: true },
      // the rebate as the barrier's boundary value, paid at the hit and at expiry
      { kind: 'knockout', call: true, K: 755, T: 0.25, H: 700, up: false, rebate: 15, rebateAtHit: true },
      { kind: 'knockout', call: true, K: 755, T: 0.25, H: 700, up: false, rebate: 15, rebateAtHit: false },
      // the knock-out as a jump at each monitoring date, alone and with a rebate
      { kind: 'knockout', call: true, K: 755, T: 0.25, H: 700, up: false, monitors: 13 },
      { kind: 'knockout', call: false, K: 740, T: 0.4, H: 800, up: true, monitors: 26 },
      { kind: 'knockout', call: true, K: 755, T: 0.25, H: 700, up: false, monitors: 13, rebate: 15, rebateAtHit: true },
    ];
    interface NativePde { price: number; delta: number; gamma: number; theta: number; nodes: number; steps: number;
                          boundary_tau: number[]; boundary_S: (number | null)[]; }
    const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-12 * Math.abs(b) + 1e-9);
    const bad: string[] = [];
    for (const spec of specs) {
      const a = w.pde(spec, m, 401, 400)!;
      const ref = native<NativePde>('quantcore.pde_price(x["spec"], x["market"], 401, 400)',
                                    { spec: toNative(spec), market: m });
      const pairs: [string, number | null, number | null][] = [
        ['price', a.price, ref.price], ['delta', a.delta, ref.delta], ['gamma', a.gamma, ref.gamma], ['theta', a.theta, ref.theta],
        ['nodes', a.nodes, ref.nodes], ['steps', a.steps, ref.steps], ['boundary length', a.boundary.length, ref.boundary_tau.length],
        ...a.boundary.flatMap((b, j): [string, number | null, number | null][] =>
          [[`tau[${j}]`, b.tau, ref.boundary_tau[j]], [`S[${j}]`, b.S, ref.boundary_S[j]]]),
      ];
      bad.push(...pairs.filter(([, x, y]) => !near(x, y)).map(([k, x, y]) => `${spec.kind} ${k}: wasm ${x} native ${y}`));
    }
    expect(bad).toEqual([]);
  });

  test('Longstaff–Schwartz American Monte Carlo brackets the finite-difference price', () => {
    test.setTimeout(120_000);
    const hull: Market = { S: 50, sigma: 0.4, r: 0.1, q: 0 };
    const pde = w.pde({ kind: 'american', call: false, K: 50, T: 5 / 12 }, hull)!;
    const eu = w.pde({ kind: 'european', call: false, K: 50, T: 5 / 12 }, hull)!;
    const a = w.lsm(false, 50, 5 / 12, hull, 20_000, 200_000, 7, 22, 365)!;
    console.log(`  LSM ${a.price.toFixed(4)} ± ${a.stdError.toFixed(4)} (policy ${a.policyPrice.toFixed(4)}) vs PDE ${pde.price.toFixed(4)}; ` +
                `European ${a.european.toFixed(4)} ± ${a.europeanSe.toFixed(4)} vs ${eu.price.toFixed(4)}; ${a.exerciseDates}/${a.dates} dates with a rule`);
    // the valuation pass is out of sample, so it is low biased: at or below the PDE up to Monte Carlo error
    expect(a.price).toBeLessThan(pde.price + 4 * a.stdError);
    expect(a.price).toBeGreaterThan(pde.price - (4 * a.stdError + 0.01 * pde.price));
    expect(Math.abs(a.european - eu.price) / a.europeanSe).toBeLessThan(4);
    expect(a.price).toBeGreaterThan(a.european);
    expect(a.dates).toBe(22);
    expect(a.exerciseDates).toBeGreaterThan(15);
    expect(a.valuePaths).toBe(200_000);

    // domain: over the cell cap, no strike, too few paths, too many dates
    expect(w.lsm(false, 50, 5 / 12, hull, 20_000, 200_000, 7, 64, 365)).toBeNull();
    expect(w.lsm(false, 0, 1, hull, 1000, 1000, 1, 10, 365)).toBeNull();
    expect(w.lsm(false, 50, 1, hull, 50, 1000, 1, 10, 365)).toBeNull();
    expect(w.lsm(false, 50, 1, hull, 1000, 1000, 1, 513, 365)).toBeNull();
  });

  test('Longstaff–Schwartz reproduces the native C++ result for the same seed', () => {
    test.skip(!nativeAvailable(), 'native quantcore module not built');
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const a = w.lsm(false, 756, 0.5, m, 10_000, 20_000, 13, 26, 365)!;
    interface NativeLsm { price: number; std_error: number; policy_price: number; european: number; european_se: number;
                          dates: number; steps: number; exercise_dates: number; }
    const ref = native<NativeLsm>(
      'quantcore.lsm_american(x["call"], x["K"], x["T"], x["market"], x["policy"], x["value"], x["seed"], x["dates"], x["spy"])',
      { call: false, K: 756, T: 0.5, market: m, policy: 10_000, value: 20_000, seed: 13, dates: 26, spy: 365 });
    const near = (x: number, y: number) => Math.abs(x - y) <= 1e-12 * Math.abs(y) + 1e-9;
    const bad = ([['price', a.price, ref.price], ['std_error', a.stdError, ref.std_error],
                  ['policy_price', a.policyPrice, ref.policy_price], ['european', a.european, ref.european],
                  ['european_se', a.europeanSe, ref.european_se], ['dates', a.dates, ref.dates],
                  ['steps', a.steps, ref.steps], ['exercise_dates', a.exerciseDates, ref.exercise_dates]] as [string, number, number][])
      .filter(([, x, y]) => !near(x, y)).map(([k, x, y]) => `${k}: wasm ${x} native ${y}`);
    expect(bad).toEqual([]);
  });

  test('inputs outside the model domain are rejected, never priced', () => {
    const invalid: [number, number, number, number, number][] = [
      [0, 100, 0.05, 0.2, 1], [100, 0, 0.05, 0.2, 1], [100, 100, 0.05, 0, 1], [100, 100, 0.05, 0.2, 0],
      [100, 100, NaN, 0.2, 1], [Infinity, 100, 0.05, 0.2, 1], [-5, 100, 0.05, 0.2, 1],
    ];
    for (const [S, K, r, sigma, T] of invalid) expect(w.bsFull(true, S, K, r, sigma, T)).toBeNull();
    expect(w.mcPrice(true, 100, 100, 0.05, 0.2, 1, 1000.5)).toBeNull();
    expect(w.mcPrice(true, 100, 100, 0.05, 0.2, 1, MAX_WASM_PATHS + 1)).toBeNull();
    expect(w.mcPrice(true, 100, 100, 0.05, 0.2, 1, 1000, -1)).toBeNull();
    expect(w.mcPrice(true, 100, 100, 0.05, 0.2, 1, 1000, 2 ** 32)).toBeNull();
    // extreme but valid inputs stay finite
    expect(w.bsFull(false, 1e-6, 1e6, 0.12, 3, 30, 0.08)).not.toBeNull();
  });
});
