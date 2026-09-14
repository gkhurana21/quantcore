/**
 * The smile-implied terminal distribution (lib/quant/impliedDensity.ts): it must be the
 * lognormal in a flat market, a proper probability density under any arbitrage-free smile,
 * and consistent with the smile's own option prices — calls, digitals and sampling.
 */

import { test, expect } from '@playwright/test';
import { runMcViz } from '../lib/compute/tasks';
import { bsPrice, probItm } from '../lib/quant/blackScholes';
import { smileDistribution } from '../lib/quant/impliedDensity';
import { lognormalPdf } from '../lib/quant/monteCarlo';
import { mulberry32 } from '../lib/quant/rng';
import type { Leg, Market, Smile } from '../lib/quant/types';
import { legSigma, SMILE_PRESETS } from '../lib/quant/volSurface';

function randomCase(u: () => number): { m: Market; T: number } {
  const rho = -0.95 + 1.9 * u();
  const smile: Smile = { rho, eta: 0.05 + (2 / (1 + Math.abs(rho)) - 0.05) * u(), gamma: 0.05 + 0.45 * u() };
  return { m: { S: 20 + 1500 * u(), sigma: 0.08 + 0.4 * u(), r: 0.08 * u(), q: 0.04 * u(), smile }, T: 0.03 + 0.8 * u() };
}

/** ∫ f(k) dk over log-moneyness by the trapezoid rule on a fine grid. */
function integrate(f: (k: number) => number, lo = -14, hi = 7, n = 140_000): number {
  const h = (hi - lo) / n;
  let s = 0.5 * (f(lo) + f(hi));
  for (let i = 1; i < n; i++) s += f(lo + i * h);
  return s * h;
}

test.describe('smile-implied terminal distribution', () => {
  test('without skew the density and digital are exactly the lognormal ones', () => {
    // a smile with no skew or curvature left to show: η at its floor gives w ≈ θ everywhere
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0.01, smile: { rho: 0, eta: 1e-9, gamma: 0.5 } };
    const T = 0.129;
    const d = smileDistribution(m, T)!;
    for (const x of [0.7, 0.9, 1, 1.05, 1.3]) {
      const S = x * m.S;
      expect(Math.abs(d.pdf(S) - lognormalPdf(S, m, T))).toBeLessThan(1e-9 * lognormalPdf(S, m, T) + 1e-15);
      expect(Math.abs(d.probAbove(S) - probItm(true, m.S, S, T, m.sigma, m.r, m.q))).toBeLessThan(1e-9);
    }
    expect(smileDistribution({ ...m, smile: null }, T)).toBeNull();
  });

  test('under random arbitrage-free smiles it is a probability density with the forward as its mean', () => {
    const u = mulberry32(41);
    const bad: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { m, T } = randomCase(u);
      const d = smileDistribution(m, T)!;
      const p = (k: number) => d.pdf(d.forward * Math.exp(k)) * d.forward * Math.exp(k);   // density of ln(S/F)
      const mass = integrate(p);
      const mean = integrate(k => d.forward * Math.exp(k) * p(k)) / d.forward;
      const ctx = JSON.stringify({ m, T });
      if (!(Math.abs(mass - 1) < 1e-6)) bad.push(`mass ${mass} ${ctx}`);
      if (!(Math.abs(mean - 1) < 1e-5)) bad.push(`mean/F ${mean} ${ctx}`);
      for (let j = -300; j <= 300; j++) if (!(p(j * 0.01) >= 0)) { bad.push(`negative density at k=${j / 100} ${ctx}`); break; }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('it reprices the smile: discounted call payoffs and digitals match strike derivatives of prices', () => {
    const u = mulberry32(42);
    const bad: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { m, T } = randomCase(u);
      const d = smileDistribution(m, T)!;
      const F = d.forward, disc = Math.exp(-m.r * T);
      const call = (K: number) => bsPrice(true, m.S, K, T, legSigma(m, K, T), m.r, m.q);
      for (const x of [0.85, 0.97, 1, 1.04, 1.2]) {
        const K = x * F;
        const expected = disc * integrate(k => Math.max(F * Math.exp(k) - K, 0) * d.pdf(F * Math.exp(k)) * F * Math.exp(k));
        if (!(Math.abs(expected - call(K)) < 1e-6 * F)) bad.push(`call K=${x}F: ${expected} vs ${call(K)} ${JSON.stringify({ m, T })}`);
        // P(S_T > K) = −e^{rT}·∂C/∂K, the derivative by Richardson-extrapolated central differences
        const h = 1e-3 * K;
        const D = (hh: number) => (call(K + hh) - call(K - hh)) / (2 * hh);
        const digital = -((4 * D(h / 2) - D(h)) / 3) / disc;
        if (!(Math.abs(digital - d.probAbove(K)) < 1e-7)) bad.push(`digital K=${x}F: ${d.probAbove(K)} vs ${digital}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('quantile sampling reproduces the mean and tail probabilities', () => {
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0, smile: SMILE_PRESETS['Equity index'] };
    const T = 0.129;
    const d = smileDistribution(m, T)!;
    const u = mulberry32(43);
    const n = 400_000;
    let sum = 0, sumSq = 0, below90 = 0, above110 = 0;
    for (let i = 0; i < n; i++) {
      const s = d.quantile(u());
      sum += s; sumSq += s * s;
      if (s < 0.9 * d.forward) below90++;
      if (s > 1.1 * d.forward) above110++;
    }
    const mean = sum / n, se = Math.sqrt((sumSq / n - mean * mean) / n);
    expect(Math.abs(mean - d.forward)).toBeLessThan(3 * se + 1e-4 * d.forward);
    const pLow = 1 - d.probAbove(0.9 * d.forward), pHigh = d.probAbove(1.1 * d.forward);
    for (const [emp, exact] of [[below90 / n, pLow], [above110 / n, pHigh]]) {
      expect(Math.abs(emp - exact)).toBeLessThan(3 * Math.sqrt(exact * (1 - exact) / n) + 1e-5);
    }
    expect(d.quantile(0)).toBeGreaterThan(0);
    expect(d.quantile(1)).toBeGreaterThan(d.quantile(0.999));
  });

  test('the Monte Carlo view samples it when a smile is on, and keeps the lognormal otherwise', () => {
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0, smile: SMILE_PRESETS['Equity index'] };
    const T = 0.129, n = 200_000;
    const put = { id: 'p', call: false, side: 'buy', qty: 1, K: 700, T, premium: 5 } as Leg;
    const v = runMcViz({ legs: [put], market: m, seed: 7, nPaths: 4, nSteps: 8, histSamples: n, bins: 40 });
    const d = smileDistribution(m, T)!;
    expect(v.density).toBe('smile');
    expect(v.pdfLognormal).toHaveLength(v.pdf.length);
    expect(v.analyticItm).toBeCloseTo(1 - d.probAbove(700), 14);
    const within = (emp: number, p: number) => expect(Math.abs(emp - p)).toBeLessThan(4 * Math.sqrt((p * (1 - p)) / n));
    within(v.dist.pItm!, v.analyticItm!);
    within(v.pProfit, 1 - d.probAbove(700 - 5));   // a long put at 5 pays off below 695

    const flat = runMcViz({ legs: [put], market: { ...m, smile: null }, seed: 7, nPaths: 4, nSteps: 8, histSamples: 20_000, bins: 40 });
    expect(flat.density).toBe('lognormal');
    expect(flat.pdfLognormal).toEqual([]);
    expect(flat.analyticItm).toBe(probItm(false, m.S, 700, T, m.sigma, m.r, m.q));
  });

  test('equity skew moves probability into the downside tail compared with the lognormal at ATM σ', () => {
    const m: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0, smile: SMILE_PRESETS['Equity index'] };
    const T = 0.129;
    const d = smileDistribution(m, T)!;
    const F = d.forward;
    const flatBelow = (K: number) => 1 - probItm(true, m.S, K, T, m.sigma, m.r, m.q);
    const smileBelow = (K: number) => 1 - d.probAbove(K);
    console.log(`  P(S_T < 90% F): smile ${(smileBelow(0.9 * F) * 100).toFixed(2)}% vs lognormal ${(flatBelow(0.9 * F) * 100).toFixed(2)}%`);
    expect(smileBelow(0.9 * F)).toBeGreaterThan(1.5 * flatBelow(0.9 * F));
    expect(d.probAbove(1.1 * F)).toBeLessThan(1 - flatBelow(1.1 * F));
  });
});
