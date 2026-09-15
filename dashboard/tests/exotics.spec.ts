/**
 * Barrier and geometric Asian closed forms (lib/quant/exotics.ts), checked against methods that share nothing
 * with the formulas: a Crank–Nicolson finite-difference solver of the Black-Scholes PDE with an absorbing barrier,
 * and Monte Carlo with exact GBM fixings. Also limits, monotonicity and in-out parity.
 */

import { test, expect } from '@playwright/test';
import { bsPrice } from '../lib/quant/blackScholes';
import { barrierPrices, geometricAsianPrice } from '../lib/quant/exotics';
import { mulberry32, normalSampler } from '../lib/quant/rng';

/**
 * Knock-out price by Crank–Nicolson in x = ln S on [barrier, far side] (up: [far side, barrier]), with a grid node
 * on ln S and on the barrier, V = 0 at the barrier, the vanilla's asymptote at the far side, and four fully
 * implicit half-steps first (Rannacher) to damp the payoff kink.
 */
function pdeKnockOut(call: boolean, up: boolean, S: number, K: number, H: number, T: number, sigma: number, r: number, q: number,
                     nx = 1600, nt = 1200): number {
  const x0 = Math.log(S), xb = Math.log(H), width = 7 * sigma * Math.sqrt(T) + Math.abs(x0 - xb);
  // grid from the barrier to the far side with ln S exactly on a node
  const steps0 = Math.max(4, Math.round((nx * Math.abs(x0 - xb)) / width));
  const dx = Math.abs(x0 - xb) / steps0;
  const n = Math.round(width / dx);
  const xs = Array.from({ length: n + 1 }, (_, i) => (up ? xb - dx * (n - i) : xb + dx * i));   // ascending
  const iS = up ? n - steps0 : steps0;
  const payoff = (x: number) => Math.max(call ? Math.exp(x) - K : K - Math.exp(x), 0);
  let V = xs.map(payoff);
  if (up) V[n] = 0; else V[0] = 0;
  const a = 0.5 * sigma * sigma / (dx * dx), b = (r - q - 0.5 * sigma * sigma) / (2 * dx);
  const lo = a - b, di = -2 * a - r, hi = a + b;   // L V_i = lo·V_{i−1} + di·V_i + hi·V_{i+1}
  const far = (tau: number) => {
    const x = up ? xs[0] : xs[n];
    const s = Math.exp(x);
    return call ? Math.max(s * Math.exp(-q * tau) - K * Math.exp(-r * tau), 0) : Math.max(K * Math.exp(-r * tau) - s * Math.exp(-q * tau), 0);
  };
  const dt = T / nt;
  const solve = (theta: number, h: number, tau: number) => {
    // (I − θhL) V_new = (I + (1 − θ)hL) V_old on the interior; boundaries fixed
    const m = n - 1;
    const rhs = new Float64Array(m), cl = new Float64Array(m), cd = new Float64Array(m), cu = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const i = k + 1;
      rhs[k] = V[i] + (1 - theta) * h * (lo * V[i - 1] + di * V[i] + hi * V[i + 1]);
      cl[k] = -theta * h * lo; cd[k] = 1 - theta * h * di; cu[k] = -theta * h * hi;
    }
    const left = up ? far(tau) : 0, right = up ? 0 : far(tau);
    rhs[0] -= cl[0] * left;
    rhs[m - 1] -= cu[m - 1] * right;
    for (let k = 1; k < m; k++) {          // Thomas algorithm
      const w = cl[k] / cd[k - 1];
      cd[k] -= w * cu[k - 1];
      rhs[k] -= w * rhs[k - 1];
    }
    const out = new Array<number>(n + 1);
    out[0] = left; out[n] = right;
    out[m] = rhs[m - 1] / cd[m - 1];
    for (let k = m - 2; k >= 0; k--) out[k + 1] = (rhs[k] - cu[k] * out[k + 2]) / cd[k];
    V = out;
  };
  let tau = 0;
  for (let s = 0; s < 4; s++) { tau += dt / 2; solve(1, dt / 2, tau); }
  for (let s = 2; s < nt; s++) { tau += dt; solve(0.5, dt, tau); }
  return V[iS];
}

test.describe('barrier options (Reiner–Rubinstein)', () => {
  test('knock-out prices match a Crank–Nicolson PDE solver for all four knock-out types, both sides of the strike', () => {
    // sanity first: the same solver with a barrier far away reprices a vanilla
    const far = pdeKnockOut(true, false, 100, 100, 1e-3, 0.5, 0.25, 0.08, 0.04);
    expect(Math.abs(far - bsPrice(true, 100, 100, 0.5, 0.25, 0.08, 0.04))).toBeLessThan(2e-3);

    const bad: string[] = [];
    let worst = 0;
    for (const [sigma, T, r, q] of [[0.25, 0.5, 0.08, 0.04], [0.3, 1, 0.03, 0], [0.18, 0.25, 0.05, 0.02]] as const) {
      for (const call of [true, false]) for (const up of [false, true]) {
        const H = up ? 115 : 88;
        for (const K of [80, 95, 100, 110, 125]) {
          const cf = barrierPrices(call, up, 100, K, H, T, sigma, r, q).out;
          const pde = pdeKnockOut(call, up, 100, K, H, T, sigma, r, q);
          const err = Math.abs(cf - pde);
          worst = Math.max(worst, err);
          if (!(err < 2e-3 + 2e-4 * pde)) bad.push(`${call ? 'call' : 'put'} ${up ? 'up' : 'down'}-and-out K ${K} H ${H} σ ${sigma} T ${T}: closed form ${cf} PDE ${pde}`);
        }
      }
    }
    console.log(`  60 knock-out prices: worst |closed form − PDE| ${worst.toExponential(2)}`);
    expect(bad).toEqual([]);
  });

  test('Monte Carlo with Brownian-bridge monitoring agrees with the closed forms, knock-out and knock-in', () => {
    const S = 100, T = 0.5, sigma = 0.25, r = 0.08, q = 0.04, N = 200_000;
    const z = normalSampler(17), u = mulberry32(99);
    const cases = [
      { call: true, up: false, K: 100, H: 92 }, { call: false, up: true, K: 100, H: 108 },
      { call: true, up: true, K: 95, H: 120 }, { call: false, up: false, K: 105, H: 85 },
    ];
    for (const c of cases) {
      const cf = barrierPrices(c.call, c.up, S, c.K, c.H, T, sigma, r, q);
      // one exact GBM step to expiry; the bridge gives the probability the path touched the barrier in between
      let sOut = 0, sOut2 = 0, sIn = 0, sIn2 = 0;
      const x0 = Math.log(S), h = Math.log(c.H), v = sigma * sigma * T, drift = (r - q - sigma * sigma / 2) * T;
      for (let i = 0; i < N; i++) {
        const x1 = x0 + drift + Math.sqrt(v) * z();
        const beyond = c.up ? x1 >= h : x1 <= h;
        const pHit = beyond ? 1 : Math.exp((-2 * (h - x0) * (h - x1)) / v);
        const pay = Math.exp(-r * T) * Math.max(c.call ? Math.exp(x1) - c.K : c.K - Math.exp(x1), 0);
        // sample the touch rather than weighting by it, so this check is independent of the engine's estimator
        const touched = u() < pHit;
        const o = touched ? 0 : pay, k = touched ? pay : 0;
        sOut += o; sOut2 += o * o; sIn += k; sIn2 += k * k;
      }
      const mOut = sOut / N, seOut = Math.sqrt((sOut2 / N - mOut * mOut) / N);
      const mIn = sIn / N, seIn = Math.sqrt((sIn2 / N - mIn * mIn) / N);
      expect(Math.abs(mOut - cf.out) / seOut, `${JSON.stringify(c)} out ${mOut} vs ${cf.out}`).toBeLessThan(4);
      expect(Math.abs(mIn - cf.in) / seIn, `${JSON.stringify(c)} in ${mIn} vs ${cf.in}`).toBeLessThan(4);
    }
  });

  test('limits, monotonicity in the barrier, touched barriers and parity', () => {
    const [S, K, T, sigma, r, q] = [100, 100, 0.75, 0.3, 0.04, 0.01];
    const vanillaC = bsPrice(true, S, K, T, sigma, r, q), vanillaP = bsPrice(false, S, K, T, sigma, r, q);
    // a barrier out of reach leaves the vanilla
    expect(barrierPrices(true, false, S, K, 1e-6, T, sigma, r, q).out).toBeCloseTo(vanillaC, 9);
    expect(barrierPrices(false, true, S, K, 1e9, T, sigma, r, q).out).toBeCloseTo(vanillaP, 9);
    // touched at inception: knocked out, or knocked in
    for (const [call, up, H] of [[true, false, 100], [true, true, 100], [false, false, 101], [false, true, 99]] as const) {
      const p = barrierPrices(call, up, S, K, H, T, sigma, r, q);
      expect(p.out).toBe(0);
      expect(p.in).toBe(p.vanilla);
    }
    // the further the barrier, the more a knock-out is worth; parity always
    let prev = 0;
    for (let H = 99; H >= 40; H -= 1) {
      const p = barrierPrices(true, false, S, K, H, T, sigma, r, q);
      expect(p.out).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(p.out + p.in).toBeCloseTo(vanillaC, 12);
      prev = p.out;
    }
    // an up-and-out call struck above its barrier can never pay
    expect(barrierPrices(true, true, S, 130, 120, T, sigma, r, q).out).toBe(0);
  });
});

test.describe('geometric Asian options', () => {
  test('one fixing is the vanilla; many fixings approach the continuous average', () => {
    for (const call of [true, false]) {
      expect(geometricAsianPrice(call, 100, 95, 0.8, 1, 0.3, 0.05, 0.02)).toBeCloseTo(bsPrice(call, 100, 95, 0.8, 0.3, 0.05, 0.02), 12);
      // continuous limit: variance σ²T/3, average time T/2
      const S = 100, K = 100, T = 1, sigma = 0.25, r = 0.05, q = 0.01;
      const v = (sigma * sigma * T) / 3, mean = Math.log(S) + (r - q - sigma * sigma / 2) * (T / 2);
      const Fg = Math.exp(mean + v / 2), sd = Math.sqrt(v);
      const d1 = (mean - Math.log(K) + v) / sd, d2 = d1 - sd;
      const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
      const cont = Math.exp(-r * T) * (call ? Fg * N(d1) - K * N(d2) : K * N(-d2) - Fg * N(-d1));
      expect(Math.abs(geometricAsianPrice(call, S, K, T, 100_000, sigma, r, q) - cont)).toBeLessThan(1e-4);
    }
  });

  test('Monte Carlo with exact GBM fixings agrees with the closed form', () => {
    const S = 50, K = 52, T = 0.5, n = 12, sigma = 0.35, r = 0.03, q = 0.0, N = 200_000;
    const z = normalSampler(5);
    for (const call of [true, false]) {
      let s = 0, s2 = 0;
      for (let i = 0; i < N; i++) {
        let x = Math.log(S), sum = 0;
        for (let k = 0; k < n; k++) {
          const dt = T / n;
          x += (r - q - sigma * sigma / 2) * dt + sigma * Math.sqrt(dt) * z();
          sum += x;
        }
        const g = Math.exp(sum / n);
        const pay = Math.exp(-r * T) * Math.max(call ? g - K : K - g, 0);
        s += pay; s2 += pay * pay;
      }
      const m = s / N, se = Math.sqrt((s2 / N - m * m) / N);
      expect(Math.abs(m - geometricAsianPrice(call, S, K, T, n, sigma, r, q)) / se).toBeLessThan(4);
    }
  });
});

/** Abramowitz–Stegun 7.1.26 is too coarse here; a series/continued-fraction erf for the continuous-limit test. */
function erf(x: number): number {
  const t = Math.abs(x);
  if (t < 2.5) {
    let sum = t, term = t, k = 0;
    do { k++; term *= (-t * t) / k; sum += term / (2 * k + 1); } while (Math.abs(term / (2 * k + 1)) > 1e-17);
    return Math.sign(x) * (2 / Math.sqrt(Math.PI)) * sum;
  }
  // erfc continued fraction for large |x|
  let f = 0;
  for (let k = 60; k >= 1; k--) f = (k / 2) / (t + f);
  const erfc = Math.exp(-t * t) / Math.sqrt(Math.PI) / (t + f);
  return Math.sign(x) * (1 - erfc);
}
