/**
 * SSVI volatility smile (lib/quant/volSurface.ts): identities, the arbitrage-free
 * parameter region checked numerically, sticky-strike scenarios, and flat markets
 * pricing exactly as before. Seeds are fixed, so any failure reproduces.
 */

import { test, expect } from '@playwright/test';
import { bsPrice } from '../lib/quant/blackScholes';
import { mulberry32 } from '../lib/quant/rng';
import type { Market, Smile } from '../lib/quant/types';
import {
  atSpot, atVol, clampSmile, durrleman, legSigma, MAX_SIGMA, phi, SMILE_PRESETS, ssvi, validSmile,
} from '../lib/quant/volSurface';

function rng(seed: number) {
  const u = mulberry32(seed);
  return {
    u,
    range: (a: number, b: number) => a + (b - a) * u(),
    logRange: (a: number, b: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * u()),
  };
}
type Rng = ReturnType<typeof rng>;

/** A random smile inside the arbitrage-free region, edges included. */
function randomSmile(g: Rng): Smile {
  const rho = g.range(-0.95, 0.95);
  const gamma = g.u() < 0.2 ? 0.5 : g.range(0.05, 0.5);
  const etaMax = 2 / (1 + Math.abs(rho));
  const eta = g.u() < 0.2 ? etaMax : g.range(0.05, etaMax);
  return { rho, eta, gamma };
}

const PRESETS = Object.values(SMILE_PRESETS);
const SPY: Market = { S: 756.48, sigma: 0.138, r: 0.045, q: 0 };

test.describe('SSVI volatility smile', () => {
  test('a flat market prices every strike at σ exactly, and scenarios add no smile state', () => {
    for (const K of [1, 500, 755, 1200]) for (const T of [0, 0.01, 0.129, 2]) {
      expect(legSigma(SPY, K, T)).toBe(SPY.sigma);
      expect(legSigma({ ...SPY, smile: null }, K, T)).toBe(SPY.sigma);
    }
    expect(atSpot(SPY, 800)).toEqual({ ...SPY, S: 800 });
    expect('smileSpot' in atSpot(SPY, 800)).toBe(false);
    expect('smileSpot' in atVol(SPY, 0.2)).toBe(false);
  });

  test('the at-the-money-forward volatility equals σ for every smile and maturity', () => {
    const g = rng(1);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const smile = i < PRESETS.length ? PRESETS[i] : randomSmile(g);
      const m: Market = { S: g.logRange(1, 5000), sigma: g.logRange(0.02, 1.5), r: g.range(0, 0.1), q: g.range(0, 0.06), smile };
      const T = g.logRange(1 / 365, 5);
      const F = m.S * Math.exp((m.r - m.q) * T);
      const v = legSigma(m, F, T);
      if (!(Math.abs(v - m.sigma) <= 1e-12 * m.sigma)) bad.push(`${JSON.stringify({ m, T })} → ${v}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('presets and clamped parameters lie in the arbitrage-free region', () => {
    for (const s of PRESETS) expect(validSmile(s), JSON.stringify(s)).toBe(true);
    expect(validSmile({ rho: -0.9, eta: 1.2, gamma: 0.5 })).toBe(false);   // η(1 + |ρ|) = 2.28 > 2
    expect(validSmile({ rho: 0.2, eta: 1, gamma: 0.6 })).toBe(false);      // γ > ½
    expect(validSmile({ rho: 1, eta: 0.5, gamma: 0.3 })).toBe(false);      // |ρ| = 1
    const g = rng(2);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const c = clampSmile({ rho: g.range(-3, 3), eta: g.range(-1, 10), gamma: g.range(-1, 2) });
      if (!validSmile(c)) bad.push(JSON.stringify(c));
    }
    expect(validSmile(clampSmile({ rho: NaN, eta: Infinity, gamma: NaN }))).toBe(true);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('the analytic k-derivatives of total variance match finite differences', () => {
    const g = rng(3);
    const bad: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const s = randomSmile(g), theta = g.logRange(1e-4, 3), k = g.range(-2, 2);
      // Steps scale with the smile's width 1/φ. Richardson extrapolation (4·D(h/2) − D(h))/3 cancels the
      // O(h²) truncation error, so the steps can stay well above rounding noise.
      const width = 1 / Math.max(1, phi(theta, s)), h1 = 1e-3 * width, h2 = 1e-2 * width;
      const w = (x: number) => ssvi(x, theta, s).w;
      const a = ssvi(k, theta, s);
      const D1 = (h: number) => (w(k + h) - w(k - h)) / (2 * h);
      const D2 = (h: number) => (w(k + h) - 2 * w(k) + w(k - h)) / (h * h);
      const dFd = (4 * D1(h1 / 2) - D1(h1)) / 3;
      const d2Fd = (4 * D2(h2 / 2) - D2(h2)) / 3;
      if (Math.abs(a.dw - dFd) > 1e-6 * Math.max(Math.abs(a.dw), a.w)) bad.push(`dw ${JSON.stringify({ s, theta, k, dw: a.dw, dFd })}`);
      if (Math.abs(a.d2w - d2Fd) > 1e-4 * Math.max(Math.abs(a.d2w), a.w)) bad.push(`d2w ${JSON.stringify({ s, theta, k, d2w: a.d2w, d2Fd })}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('no butterfly arbitrage: Durrleman’s condition holds and call prices are convex in strike', () => {
    const g = rng(4);
    const bad: string[] = [];
    for (let i = 0; i < 400; i++) {
      const s = randomSmile(g), theta = g.logRange(1e-5, 4);
      for (let j = 0; j <= 600; j++) {
        const k = -3 + j * 0.01;
        const d = durrleman(k, theta, s);
        if (!(d >= -1e-12)) bad.push(`g(${k.toFixed(2)}) = ${d} for ${JSON.stringify({ s, theta })}`);
      }
    }
    // Independent of the g(k) formula: a butterfly spread (c(K−h) − 2c(K) + c(K+h)) never has a negative price.
    for (let i = 0; i < 300; i++) {
      const m: Market = { S: 100, sigma: g.logRange(0.05, 1), r: 0, q: 0, smile: randomSmile(g) };
      const T = g.logRange(1 / 365, 5);
      const c = (K: number) => bsPrice(true, 100, K, T, legSigma(m, K, T), 0, 0);
      for (let j = -150; j <= 150; j++) {
        const K = 100 * Math.exp(j * 0.01), h = 0.25;
        const fly = c(K - h) - 2 * c(K) + c(K + h);
        if (!(fly >= -1e-9)) bad.push(`butterfly ${fly} at K=${K.toFixed(2)} ${JSON.stringify({ m, T })}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('no calendar arbitrage: total variance increases with maturity at every moneyness', () => {
    const g = rng(5);
    const bad: string[] = [];
    for (let i = 0; i < 500; i++) {
      const s = randomSmile(g), sigma = g.logRange(0.02, 1.5);
      const T1 = g.logRange(1 / 365, 4), T2 = T1 * g.range(1.001, 3);
      for (let j = 0; j <= 120; j++) {
        const k = -3 + j * 0.05;
        const w1 = ssvi(k, sigma * sigma * T1, s).w, w2 = ssvi(k, sigma * sigma * T2, s).w;
        if (!(w2 >= w1 - 1e-15)) bad.push(`w(${k}) ${w1} → ${w2} ${JSON.stringify({ s, sigma, T1, T2 })}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('parameters outside the region do create arbitrage — the checks are not vacuous', () => {
    const s: Smile = { rho: -0.9, eta: 5, gamma: 0.5 };   // wings steeper than Lee's moment bound
    expect(validSmile(s)).toBe(false);
    let worst = Infinity;
    for (const theta of [0.5, 1, 2]) for (let j = 0; j <= 600; j++) worst = Math.min(worst, durrleman(-3 + j * 0.01, theta, s));
    expect(worst).toBeLessThan(0);
  });

  test('equity skew: downside strikes carry more volatility than upside strikes', () => {
    const T = 0.129;
    const F = SPY.S * Math.exp(SPY.r * T);
    for (const [name, smile] of Object.entries(SMILE_PRESETS)) {
      const m: Market = { ...SPY, smile };
      const down = legSigma(m, 0.95 * F, T), up = legSigma(m, 1.05 * F, T);
      console.log(`  ${name}: 95% ${(down * 100).toFixed(2)}% · ATM ${(m.sigma * 100).toFixed(2)}% · 105% ${(up * 100).toFixed(2)}%`);
      expect(down).toBeGreaterThan(m.sigma);
      expect(up).toBeLessThan(down);
    }
    const mirrored: Market = { ...SPY, smile: { rho: 0.7, eta: 1, gamma: 0.45 } };
    expect(legSigma(mirrored, 1.05 * F, T)).toBeGreaterThan(legSigma(mirrored, 0.95 * F, T));
  });

  test('scenarios are sticky-strike; a new spot quote re-centres the smile', () => {
    const m: Market = { ...SPY, smile: SMILE_PRESETS['Equity index'] };
    for (const K of [650, 720, 755, 800, 900]) for (const T of [0.02, 0.129, 1]) {
      const base = legSigma(m, K, T);
      expect(legSigma(atSpot(m, 600), K, T)).toBe(base);
      expect(legSigma(atSpot(atSpot(m, 600), 900), K, T)).toBe(base);
      expect(legSigma(atVol(atSpot(m, 600), m.sigma), K, T)).toBe(base);
      const requoted: Market = { ...m, S: 800 };                 // the market itself moved
      expect(Math.abs(legSigma(requoted, (K * 800) / m.S, T) - base)).toBeLessThan(1e-12);
    }
    expect(legSigma(atVol(m, 0.3), m.S * Math.exp(m.r * 0.5), 0.5)).toBeCloseTo(0.3, 12);
  });

  test('extreme strikes and maturities stay finite and within the engine’s volatility range', () => {
    const g = rng(6);
    const bad: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const m: Market = { S: g.logRange(0.01, 1e5), sigma: g.logRange(0.01, 1.5), r: g.range(0, 0.15), q: g.range(0, 0.08), smile: randomSmile(g) };
      const K = m.S * g.logRange(1e-9, 1e9), T = g.logRange(1e-6, 30);
      const v = legSigma(m, K, T);
      if (!(Number.isFinite(v) && v > 0 && v <= MAX_SIGMA)) bad.push(`${v} ${JSON.stringify({ m, K, T })}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
