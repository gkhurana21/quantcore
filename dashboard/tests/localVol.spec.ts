/**
 * Dupire local volatility from the SSVI surface (lib/quant/localVol.ts): the flat and term-structure-only
 * limits, agreement with Dupire's formula evaluated independently from call prices, and a local-volatility
 * Monte Carlo that reprices the vanillas of the surface it was built from.
 */

import { test, expect } from '@playwright/test';
import { bsPrice } from '../lib/quant/blackScholes';
import { atmForwardVariance, localVol, mcLocalVol, sampleLocalVolPaths, timeGrid } from '../lib/quant/localVol';
import { mulberry32 } from '../lib/quant/rng';
import type { Leg, Market, Smile, TermStructure } from '../lib/quant/types';
import { atmVariance, fittedTerm, legSigma, MAX_SIGMA, SMILE_PRESETS, TERM_PRESETS } from '../lib/quant/volSurface';
import { runMcViz } from '../lib/compute/tasks';

function rng(seed: number) {
  const u = mulberry32(seed);
  return {
    u,
    range: (a: number, b: number) => a + (b - a) * u(),
    logRange: (a: number, b: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u()),
  };
}
type Rng = ReturnType<typeof rng>;

/** A smile strictly inside the arbitrage-free region, where local volatility is finite everywhere. */
function interiorSmile(g: Rng): Smile {
  const rho = g.range(-0.8, 0.3);
  return { rho, eta: g.range(0.2, 0.85) * (2 / (1 + Math.abs(rho))), gamma: g.range(0.25, 0.5) };
}
const curve = (g: Rng): TermStructure => ({ kind: 'curve', ratio: g.logRange(0.5, 2), halfLife: g.logRange(0.05, 1) });

const call = (K: number, T: number): Leg => ({ id: `c${K}/${T}`, call: true, side: 'buy', qty: 1, K, T, premium: 0 });
const put = (K: number, T: number): Leg => ({ id: `p${K}/${T}`, call: false, side: 'buy', qty: 1, K, T, premium: 0 });

test.describe('Dupire local volatility', () => {
  test('flat: σ everywhere; a term structure alone: the forward volatility √θ′(T), whatever the spot', () => {
    const flat: Market = { S: 100, sigma: 0.2, r: 0.03, q: 0.01 };
    for (const S of [50, 100, 180]) for (const t of [0, 0.1, 2]) expect(localVol(flat, S, t)).toBe(0.2);

    const g = rng(1);
    const bad: string[] = [];
    for (let i = 0; i < 500; i++) {
      const m: Market = { S: 100, sigma: g.logRange(0.05, 0.8), r: 0.02, q: 0, term: curve(g) };
      const T = g.logRange(0.01, 3), h = 1e-5 * T;
      const fd = (atmVariance(m, T + h) - atmVariance(m, T - h)) / (2 * h);
      const lv = localVol(m, g.logRange(20, 500), T);
      if (!(Math.abs(lv * lv - fd) <= 1e-6 * fd)) bad.push(`${lv * lv} vs ${fd} ${JSON.stringify({ m, T })}`);
      if (Math.abs(atmForwardVariance(m, T) - lv * lv) > 1e-15) bad.push('forward variance');
    }
    // fitted pillars: piecewise-constant forward variance between listed expiries
    const T = [0.05, 0.2, 0.5, 1], vols = [0.3, 0.22, 0.2, 0.21];
    const fit = fittedTerm(T, T.map((t, i) => vols[i] * vols[i] * t))!;
    const m: Market = { S: 100, sigma: fit.sigma, r: 0, q: 0, term: fit.term };
    const forward = (a: number, b: number) => Math.sqrt((atmVariance(m, b) - atmVariance(m, a)) / (b - a));
    expect(localVol(m, 100, 0.03)).toBeCloseTo(0.3, 12);
    expect(localVol(m, 100, 0.3)).toBeCloseTo(forward(0.2, 0.5), 12);
    expect(localVol(m, 100, 1.5)).toBeCloseTo(0.21, 12);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('matches Dupire’s formula evaluated by finite differences of the surface’s call prices', () => {
    // σ_loc²(K, T) = (∂C/∂T + (r − q)·K·∂C/∂K + q·C) / (½·K²·∂²C/∂K²), with C(K, T) = BS at legSigma(K, T)
    const g = rng(2);
    const bad: string[] = [];
    let worst = 0;
    for (let i = 0; i < 300; i++) {
      const m: Market = { S: 100, sigma: g.logRange(0.1, 0.5), r: g.range(0, 0.06), q: g.range(0, 0.03),
                          smile: interiorSmile(g), term: curve(g) };
      const T = g.logRange(0.08, 2);
      const F = m.S * Math.exp((m.r - m.q) * T);
      const K = F * Math.exp(g.range(-1.2, 0.8) * legSigma(m, F, T) * Math.sqrt(T));   // within ~1σ of the forward
      const C = (k: number, t: number) => bsPrice(true, m.S, k, t, legSigma(m, k, t), m.r, m.q);
      // Richardson-extrapolated central differences. Strike steps scale with the width of the terminal
      // distribution, K·σ·√T: a fixed 2%-of-strike step is half a standard deviation at short expiries,
      // where its truncation error alone exceeds the tolerance.
      const d = (f: (h: number) => number, h: number) => (4 * f(h / 2) - f(h)) / 3;
      const width = K * legSigma(m, K, T) * Math.sqrt(T);
      const hK = 1e-3 * width, hT = 1e-3 * T;
      const dT = d(h => (C(K, T + h) - C(K, T - h)) / (2 * h), hT);
      const dK = d(h => (C(K + h, T) - C(K - h, T)) / (2 * h), hK);
      const dKK = d(h => (C(K + h, T) - 2 * C(K, T) + C(K - h, T)) / (h * h), 20 * hK);
      const dupire = (dT + (m.r - m.q) * K * dK + m.q * C(K, T)) / (0.5 * K * K * dKK);
      const lv = localVol(m, K, T);
      const err = Math.abs(lv * lv - dupire) / dupire;
      worst = Math.max(worst, err);
      if (!(err < 1e-4)) bad.push(`σ_loc² ${lv * lv} vs Dupire ${dupire} (${err}) ${JSON.stringify({ m, K, T })}`);
    }
    console.log(`  analytic vs finite-difference Dupire: worst relative error ${worst.toExponential(2)} over 300 random surfaces`);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('a local-volatility Monte Carlo reprices the surface’s vanillas across strikes and expiries', () => {
    test.setTimeout(120_000);
    const g = rng(3);
    const bad: string[] = [];
    const zs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const m: Market = { S: 100, sigma: g.range(0.15, 0.35), r: 0.03, q: 0.01, smile: interiorSmile(g), term: curve(g) };
      for (const T of [0.25, 1]) {
        const F = m.S * Math.exp((m.r - m.q) * T), sd = legSigma(m, F, T) * Math.sqrt(T);
        // puts below the forward, calls above: out of the money, where the smile matters
        for (const x of [-1.5, -0.75, 0, 0.75, 1.5]) {
          const K = +(F * Math.exp(x * sd)).toFixed(4);
          const leg = x < 0 ? put(K, T) : call(K, T);
          const ref = 100 * bsPrice(leg.call, m.S, K, T, legSigma(m, K, T), m.r, m.q);
          const mc = mcLocalVol([leg], m, 100_000, 7000 + zs.length, 365);
          const z = (mc.price - ref) / mc.se;
          zs.push(z);
          if (!(Math.abs(z) < 4)) bad.push(`|z| ${z.toFixed(2)}: LV ${mc.price.toFixed(4)} ± ${mc.se.toFixed(4)} vs ${ref.toFixed(4)} ${JSON.stringify({ m, K, T })}`);
        }
      }
    }
    const meanZ = zs.reduce((a, z) => a + z, 0) / zs.length;
    const rms = Math.sqrt(zs.reduce((a, z) => a + z * z, 0) / zs.length);
    // an unbiased estimator would give mean ≈ 0 and RMS ≈ 1; RMS above 1 is the log-Euler bias measured in localVol.ts
    console.log(`  ${zs.length} vanillas: mean z ${meanZ.toFixed(2)}, RMS z ${rms.toFixed(2)}`);
    expect(bad).toEqual([]);
    expect(Math.abs(meanZ)).toBeLessThan(4 / Math.sqrt(zs.length) + 0.25);   // no systematic discretisation bias
  });

  test('without a smile the simulation is exact: each expiry is lognormal at its ATM term-structure volatility', () => {
    const g = rng(4);
    for (let i = 0; i < 6; i++) {
      const m: Market = { S: 100, sigma: g.range(0.1, 0.4), r: 0.04, q: 0, term: curve(g) };
      const legs = [call(105, 0.1), put(95, 0.6), call(100, 1.7)];
      const ref = legs.reduce((a, l) => a + 100 * bsPrice(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q), 0);
      const mc = mcLocalVol(legs, m, 60_000, 90 + i, 4);   // four steps a year: no bias to hide
      expect(Math.abs(mc.price - ref) / mc.se).toBeLessThan(4);
    }
  });

  test('the Monte Carlo view simulates local-volatility paths with a surface and GBM without one', () => {
    const base = { legs: [call(100, 0.25)], seed: 7, nPaths: 20, nSteps: 30, histSamples: 2000, bins: 20 };
    const flat = runMcViz({ ...base, market: { S: 100, sigma: 0.2, r: 0.03, q: 0 } });
    expect(flat.pathModel).toBe('gbm');
    expect(flat.localVol).toBeNull();

    const m: Market = { S: 100, sigma: 0.2, r: 0.03, q: 0, smile: SMILE_PRESETS['Equity index'], term: TERM_PRESETS.Upward };
    const v = runMcViz({ ...base, market: m });
    expect(v.pathModel).toBe('local-vol');
    expect(v.paths).toEqual(sampleLocalVolPaths(m, 0.25, 20, 30, 7));
    const lv = v.localVol!;
    expect(lv.atm).toEqual({ local: localVol(m, 100, 0.25), implied: legSigma(m, 100, 0.25) });
    expect(lv.down).toEqual({ local: localVol(m, 90, 0.25), implied: legSigma(m, 90, 0.25) });
    // equity skew: the local skew near the money is the steeper one
    expect(lv.down.local - lv.atm.local).toBeGreaterThan(lv.down.implied - lv.atm.implied);
    console.log(`  equity index + upward term, 91d: local ${(lv.down.local * 100).toFixed(2)}% → ${(lv.atm.local * 100).toFixed(2)}%, implied ${(lv.down.implied * 100).toFixed(2)}% → ${(lv.atm.implied * 100).toFixed(2)}% (90% → 100% of spot)`);
  });

  test('time grid lands on every expiry; paths are finite and capped even at the arbitrage-free boundary', () => {
    const grid = timeGrid([0.5, 0.1, 0.1, 0], 12);
    expect(grid[0]).toBe(0);
    expect(grid).toContain(0.1);
    expect(grid[grid.length - 1]).toBe(0.5);
    for (let i = 1; i < grid.length; i++) expect(grid[i] - grid[i - 1]).toBeLessThanOrEqual(1 / 12 + 1e-12);

    const edge: Market = { S: 100, sigma: 0.6, r: 0.05, q: 0, smile: { rho: -0.95, eta: 2 / 1.95, gamma: 0.5 },
                           term: { kind: 'curve', ratio: 2.5, halfLife: 3 / 365 } };
    for (const S of [1e-3, 1, 60, 100, 250, 1e5]) for (const t of [0, 1e-6, 0.02, 1, 5]) {
      const v = localVol(edge, S, t);
      expect(Number.isFinite(v) && v >= 0 && v <= MAX_SIGMA).toBe(true);
    }
    const paths = sampleLocalVolPaths(edge, 1, 30, 60, 5);
    expect(paths).toHaveLength(30);
    expect(paths.every(p => p.length === 61 && p.every(s => Number.isFinite(s) && s > 0))).toBe(true);
  });
});
