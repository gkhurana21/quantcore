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
import { bsGreeks } from '../lib/quant/blackScholes';
import type { Leg, Market } from '../lib/quant/types';
import { CONTRACT_MULT, signedQty } from '../lib/quant/types';
import { legSigma, SMILE_PRESETS } from '../lib/quant/volSurface';
import { portfolioValue } from '../lib/strategy/portfolio';

/** SPY iron condor on the 47-day expiry plus a long 6-month call. */
function condorWithCalendar(): Leg[] {
  const leg = (id: string, call: boolean, side: 'buy' | 'sell', K: number, T = 0.129, qty = 10): Leg =>
    ({ id, call, side, qty, K, T, premium: 0 });
  return [leg('p1', false, 'buy', 715), leg('p2', false, 'sell', 735), leg('c1', true, 'sell', 775),
          leg('c2', true, 'buy', 795), leg('cal', true, 'buy', 760, 0.5, 5)];
}
import type { QuantcoreWasm, WasmManifest } from '../lib/engine/wasm';
import { instantiateQuantcore, MAX_WASM_PATHS, WASM_ABI } from '../lib/engine/wasm';

const ROOT = path.resolve(__dirname, '..', '..');
const WASM_DIR = path.join(ROOT, 'dashboard', 'public', 'wasm');
const MAC_PY = '/Library/Developer/CommandLineTools/usr/bin/python3';
const PY = existsSync(MAC_PY) ? MAC_PY : 'python3';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
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
      ['core/src/black_scholes.cpp', 'core/src/monte_carlo.cpp', 'bindings/quantcore_wasm.cpp']));
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
