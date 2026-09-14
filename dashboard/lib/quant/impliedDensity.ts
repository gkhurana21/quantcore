// The risk-neutral distribution of S_T implied by the volatility smile (Breeden–Litzenberger).
//
// Call prices C(K) from the smile determine the density, f(K) = e^{rT}·∂²C/∂K². In total
// variance w(k) at log-forward moneyness k = ln(K/F) this has a closed form (Gatheral):
//
//   density of ln(S_T/F):   p(k) = g(k)·φ(d₋)/√w,     d₋ = −k/√w − √w/2
//   P(S_T > K):             N(d₋) − φ(d₋)·w′(k)/(2√w)   (= −e^{rT}·∂C/∂K)
//
// where g is Durrleman's function — non-negative exactly when the smile is free of butterfly
// arbitrage, which the app's parameter region guarantees. With no skew (w′ = w″ = 0, g = 1)
// both reduce to the lognormal. Quantiles come from the distribution function tabulated on a
// log-moneyness grid wide enough to hold all but 1e-8 of the probability in each tail.

import { normCdf, normPdf } from './normal';
import type { Market } from './types';
import { atmVariance, durrleman, ssvi } from './volSurface';

export interface SmileDistribution {
  forward: number;
  T: number;
  /** Density of S_T. */
  pdf(S: number): number;
  /** P(S_T > K) — the undiscounted digital call. */
  probAbove(K: number): number;
  /** The price S with P(S_T ≤ S) = u. */
  quantile(u: number): number;
}

const GRID = 8001;
const TAIL = 1e-8;
const K_MIN = -25, K_MAX = 10;

/** The terminal distribution for today's market under its smile; null without a smile. */
export function smileDistribution(m: Market, T: number): SmileDistribution | null {
  const s = m.smile;
  if (!s || !(T > 0) || !(m.S > 0) || !(m.sigma > 0)) return null;
  const forward = (m.smileSpot ?? m.S) * Math.exp((m.r - m.q) * T);
  const theta = atmVariance(m, T);   // σ²·T without a term structure

  const density = (k: number) => {
    const { w } = ssvi(k, theta, s);
    const sw = Math.sqrt(w), dm = -k / sw - sw / 2;
    return (Math.max(0, durrleman(k, theta, s)) * normPdf(dm)) / sw;
  };
  const above = (k: number) => {
    const { w, dw } = ssvi(k, theta, s);
    const sw = Math.sqrt(w), dm = -k / sw - sw / 2;
    return Math.min(1, Math.max(0, normCdf(dm) - (normPdf(dm) * dw) / (2 * sw)));
  };

  // widen the grid until each tail holds less than TAIL of the probability
  let kLo = -6 * Math.sqrt(theta), kHi = 6 * Math.sqrt(theta);
  while (kLo > K_MIN && 1 - above(kLo) > TAIL) kLo = Math.max(K_MIN, kLo * 1.5 - 0.05);
  while (kHi < K_MAX && above(kHi) > TAIL) kHi = Math.min(K_MAX, kHi * 1.5 + 0.05);
  const ks = new Float64Array(GRID), cdf = new Float64Array(GRID);
  for (let i = 0; i < GRID; i++) {
    ks[i] = kLo + ((kHi - kLo) * i) / (GRID - 1);
    cdf[i] = Math.max(i ? cdf[i - 1] : 0, 1 - above(ks[i]));   // monotone against rounding
  }
  const c0 = cdf[0], c1 = cdf[GRID - 1];

  return {
    forward, T,
    pdf: S => (S > 0 ? density(Math.log(S / forward)) / S : 0),
    probAbove: K => (K > 0 ? above(Math.log(K / forward)) : 1),
    quantile: u => {
      const target = c0 + (c1 - c0) * Math.min(1, Math.max(0, u));
      let a = 0, b = GRID - 1;
      while (b - a > 1) {
        const mid = (a + b) >> 1;
        if (cdf[mid] < target) a = mid; else b = mid;
      }
      const t = cdf[b] > cdf[a] ? (target - cdf[a]) / (cdf[b] - cdf[a]) : 0;
      return forward * Math.exp(ks[a] + t * (ks[b] - ks[a]));
    },
  };
}
