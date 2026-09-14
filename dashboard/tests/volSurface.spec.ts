/**
 * SSVI volatility smile (lib/quant/volSurface.ts): identities, the arbitrage-free
 * parameter region checked numerically, sticky-strike scenarios, and flat markets
 * pricing exactly as before. Seeds are fixed, so any failure reproduces.
 */

import { test, expect } from '@playwright/test';
import { bsPrice } from '../lib/quant/blackScholes';
import { mulberry32 } from '../lib/quant/rng';
import type { Market, Smile, TermStructure } from '../lib/quant/types';
import {
  atmVariance, atmVol, atSpot, atVol, clampSmile, clampTerm, durrleman, fittedTerm, hasVolSurface, legSigma, MAX_SIGMA,
  phi, SMILE_PRESETS, ssvi, TERM_LIMITS, TERM_PIVOT_T, TERM_PRESETS, termShape, validSmile, validTerm,
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
      const m: Market = { S: g.logRange(0.01, 1e5), sigma: g.logRange(0.01, 1.5), r: g.range(0, 0.15), q: g.range(0, 0.08),
                          smile: randomSmile(g), ...(i % 2 ? { term: randomTerm(g) } : {}) };
      const K = m.S * g.logRange(1e-9, 1e9), T = g.logRange(1e-6, 30);
      const v = legSigma(m, K, T);
      if (!(Number.isFinite(v) && v > 0 && v <= MAX_SIGMA)) bad.push(`${v} ${JSON.stringify({ m, K, T })}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

/** A random term structure: a mean-reverting curve or fitted pillars with some flat total-variance steps. */
function randomTerm(g: Rng): TermStructure {
  if (g.u() < 0.5) return { kind: 'curve', ratio: g.logRange(0.4, 2.5), halfLife: g.logRange(7 / 365, 3) };
  const n = 1 + Math.floor(g.u() * 8);
  const T: number[] = [], theta: number[] = [];
  let t = g.logRange(2 / 365, 45 / 365);
  for (let i = 0; i < n; i++) {
    const v = g.logRange(0.08, 0.6);
    theta.push(Math.max(theta[i - 1] ?? 0, g.u() < 0.15 && i ? theta[i - 1] : v * v * t));
    T.push(t);
    t *= g.range(1.05, 3);
  }
  return fittedTerm(T, theta)!.term;
}

/** The curve's A(T) written out independently of volSurface.ts. */
const curveA = (t: { ratio: number; halfLife: number }, T: number) => {
  const kappa = Math.log(2) / t.halfLife;
  return T + ((t.ratio * t.ratio - 1) * (1 - Math.exp(-kappa * T))) / kappa;
};

test.describe('ATM term structure', () => {
  test('without a term structure nothing changes, bit for bit', () => {
    const g = rng(11);
    for (let i = 0; i < 2000; i++) {
      const m: Market = { S: g.logRange(1, 5000), sigma: g.logRange(0.02, 1.5), r: g.range(0, 0.1), q: g.range(0, 0.06),
                          ...(i % 2 ? { smile: randomSmile(g) } : {}) };
      const K = m.S * g.logRange(0.3, 3), T = g.logRange(1 / 365, 5);
      expect(legSigma({ ...m, term: null }, K, T)).toBe(legSigma(m, K, T));
      expect(atmVariance(m, T)).toBe(m.sigma * m.sigma * T);
      expect(atmVol(m, T)).toBe(m.sigma);
      expect(hasVolSurface(m)).toBe(!!m.smile);
    }
    expect(hasVolSurface({ ...SPY, term: TERM_PRESETS.Upward })).toBe(true);
  });

  test('σ is the 30-day at-the-money-forward volatility under every term structure and smile', () => {
    const g = rng(12);
    const bad: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const m: Market = { S: g.logRange(1, 5000), sigma: g.logRange(0.02, 1.5), r: g.range(0, 0.1), q: g.range(0, 0.06),
                          term: randomTerm(g), ...(i % 2 ? { smile: randomSmile(g) } : {}) };
      const F = m.S * Math.exp((m.r - m.q) * TERM_PIVOT_T);
      const v = legSigma(m, F, TERM_PIVOT_T);
      if (!(Math.abs(v - m.sigma) <= 1e-12 * m.sigma)) bad.push(`${v} vs ${m.sigma} ${JSON.stringify(m.term)}`);
      if (!(Math.abs(termShape(m.term!, TERM_PIVOT_T) - TERM_PIVOT_T) <= 1e-15)) bad.push(`W(30d) ${JSON.stringify(m.term)}`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('curve: the short end is ratio × the long-run volatility, and volatility moves monotonically in between', () => {
    const g = rng(13);
    const bad: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const term = { kind: 'curve' as const, ratio: g.logRange(0.4, 2.5), halfLife: g.logRange(7 / 365, 3) };
      const m: Market = { ...SPY, sigma: g.logRange(0.05, 0.8), term };
      const longRun = m.sigma * Math.sqrt(TERM_PIVOT_T / curveA(term, TERM_PIVOT_T));
      const shortEnd = atmVol(m, 1e-9);
      if (!(Math.abs(shortEnd / longRun - term.ratio) <= 1e-6 * term.ratio)) bad.push(`short ${shortEnd / longRun} vs ${term.ratio}`);
      // independent formula for the whole curve
      for (const T of [0.01, 0.2, 1, 4]) {
        const expected = m.sigma * Math.sqrt((TERM_PIVOT_T * curveA(term, T)) / (curveA(term, TERM_PIVOT_T) * T));
        if (!(Math.abs(atmVol(m, T) - expected) <= 1e-12 * expected)) bad.push(`vol(${T}) ${atmVol(m, T)} vs ${expected}`);
      }
      let prev = atmVol(m, 1 / 365);
      for (let d = 2; d <= 1500; d += 7) {
        const v = atmVol(m, d / 365);
        if (term.ratio < 1 ? v < prev - 1e-15 : v > prev + 1e-15) bad.push(`not monotone at ${d}d ${JSON.stringify(term)}`);
        prev = v;
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    const up: Market = { ...SPY, term: TERM_PRESETS.Upward }, inv: Market = { ...SPY, term: TERM_PRESETS.Inverted };
    expect(atmVol(up, 7 / 365)).toBeLessThan(SPY.sigma);
    expect(atmVol(up, 1)).toBeGreaterThan(SPY.sigma);
    expect(atmVol(inv, 7 / 365)).toBeGreaterThan(SPY.sigma);
    expect(atmVol(inv, 1)).toBeLessThan(SPY.sigma);
    console.log(`  Upward: 7d ${(atmVol(up, 7 / 365) * 100).toFixed(2)}% · 30d ${(atmVol(up, TERM_PIVOT_T) * 100).toFixed(2)}% · 1y ${(atmVol(up, 1) * 100).toFixed(2)}%` +
                ` · Inverted: 7d ${(atmVol(inv, 7 / 365) * 100).toFixed(2)}% · 1y ${(atmVol(inv, 1) * 100).toFixed(2)}%`);
  });

  test('fitted pillars reproduce the listed ATM variances, interpolate total variance, and reject calendar arbitrage', () => {
    const T = [7 / 365, 21 / 365, 63 / 365, 180 / 365, 1];
    const vols = [0.11, 0.14, 0.15, 0.17, 0.19];
    const theta = T.map((t, i) => vols[i] * vols[i] * t);
    const fit = fittedTerm(T, theta)!;
    expect(validTerm(fit.term)).toBe(true);
    const m: Market = { ...SPY, sigma: fit.sigma, term: fit.term };
    T.forEach((t, i) => expect(Math.abs(atmVariance(m, t) - theta[i])).toBeLessThanOrEqual(1e-15 + 1e-13 * theta[i]));
    const mid = (T[1] + T[2]) / 2;
    expect(atmVariance(m, mid)).toBeCloseTo((theta[1] + theta[2]) / 2, 15);
    expect(atmVol(m, 1 / 365)).toBeCloseTo(vols[0], 12);      // constant volatility before the first expiry
    expect(atmVol(m, 3)).toBeCloseTo(vols[4], 12);            // and after the last
    // σ is the 30-day volatility: total variance interpolated between the 21- and 63-day pillars
    const w30 = theta[1] + ((TERM_PIVOT_T - T[1]) / (T[2] - T[1])) * (theta[2] - theta[1]);
    expect(fit.sigma).toBeCloseTo(Math.sqrt(w30 / TERM_PIVOT_T), 14);

    expect(fittedTerm(T, [...theta.slice(0, 2), theta[1] * 0.99, ...theta.slice(3)])).toBeNull();   // total variance falls
    expect(fittedTerm([T[0], T[0], ...T.slice(2)], theta)).toBeNull();                               // repeated maturity
    expect(fittedTerm(T, theta.slice(1))).toBeNull();
    expect(fittedTerm([], [])).toBeNull();
    expect(fittedTerm([0.1, NaN], [0.001, 0.002])).toBeNull();
    expect(fittedTerm([0.1, 0.2], [0.004, 0.004])).not.toBeNull();                                 // flat total variance is allowed
  });

  test('no calendar arbitrage under any term structure and smile: total variance and calendar spreads never fall', () => {
    const g = rng(14);
    const bad: string[] = [];
    for (let i = 0; i < 600; i++) {
      const m: Market = { S: 100, sigma: g.logRange(0.05, 0.8), r: 0, q: 0, term: randomTerm(g), ...(i % 3 ? { smile: randomSmile(g) } : {}) };
      const T1 = g.logRange(1 / 365, 3), T2 = T1 * g.range(1.0005, 2.5);
      for (let j = 0; j <= 80; j++) {
        const k = -2 + j * 0.05;
        const w = (T: number) => (m.smile ? ssvi(k, atmVariance(m, T), m.smile).w : atmVariance(m, T));
        if (!(w(T2) >= w(T1) * (1 - 1e-12))) bad.push(`w(${k}) ${w(T1)} → ${w(T2)} ${JSON.stringify({ m, T1, T2 })}`);
      }
      // with r = q = 0 every expiry shares the forward, so a calendar spread must cost something
      for (let j = 0; j <= 40; j++) {
        const K = 100 * Math.exp(-1 + j * 0.05);
        const spread = bsPrice(true, 100, K, T2, legSigma(m, K, T2), 0, 0) - bsPrice(true, 100, K, T1, legSigma(m, K, T1), 0, 0);
        if (!(spread >= -1e-9)) bad.push(`calendar ${spread} K=${K.toFixed(2)} ${JSON.stringify({ m, T1, T2 })}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  test('vol scenarios scale every expiry in proportion; spot scenarios leave the term structure alone', () => {
    const g = rng(15);
    for (let i = 0; i < 300; i++) {
      const m: Market = { ...SPY, sigma: g.logRange(0.05, 0.6), term: randomTerm(g), ...(i % 2 ? { smile: SMILE_PRESETS['Equity index'] } : {}) };
      const f = g.range(0.5, 2);
      for (const T of [3 / 365, 0.129, 0.7, 2]) {
        const shocked = atmVol(atVol(m, m.sigma * f), T);
        if (shocked < MAX_SIGMA) expect(shocked / atmVol(m, T)).toBeCloseTo(f, 10);   // proportional below the engine's cap
        for (const K of [600, 755, 900]) expect(legSigma(atSpot(m, 700), K, T)).toBe(legSigma(m, K, T));
      }
      expect(atVol(m, 0.3).term).toBe(m.term);
      expect(atSpot(m, 700).term).toBe(m.term);
    }
  });

  test('presets are valid and clamped curves stay inside the slider limits', () => {
    for (const t of Object.values(TERM_PRESETS)) expect(validTerm(t)).toBe(true);
    expect(validTerm({ kind: 'curve', ratio: 0, halfLife: 1 })).toBe(false);
    expect(validTerm({ kind: 'curve', ratio: 1, halfLife: -1 })).toBe(false);
    const g = rng(16);
    for (let i = 0; i < 2000; i++) {
      const c = clampTerm({ kind: 'curve', ratio: g.range(-5, 10), halfLife: g.range(-2, 20) })!;
      expect(c.kind === 'curve' && validTerm(c) && c.ratio >= TERM_LIMITS.ratio[0] && c.ratio <= TERM_LIMITS.ratio[1] &&
             c.halfLife >= TERM_LIMITS.halfLife[0] && c.halfLife <= TERM_LIMITS.halfLife[1]).toBe(true);
    }
    expect(validTerm(clampTerm({ kind: 'curve', ratio: NaN, halfLife: Infinity })!)).toBe(true);
    expect(clampTerm({ kind: 'fitted', T: [0.2, 0.1], w: [0.01, 0.02] })).toBeNull();
  });
});
