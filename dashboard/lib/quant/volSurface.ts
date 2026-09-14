// Arbitrage-free implied volatility smile: SSVI (Gatheral & Jacquier, 2014).
//
// Total implied variance at log-forward-moneyness k = ln(K/F), with ATM total variance θ:
//
//   w(k, θ) = θ/2 · (1 + ρ·φ(θ)·k + √((φ(θ)·k + ρ)² + 1 − ρ²))
//   φ(θ)    = η / (θ^γ · (1 + θ)^(1−γ))            power-law curvature
//   θ_T     = σ_ATM² · T                            flat at-the-money term structure
//
// Parameters are kept in the power-law region η(1 + |ρ|) ≤ 2, 0 < γ ≤ ½, |ρ| < 1, which
// Gatheral & Jacquier show is free of static arbitrage — no butterfly or calendar spread
// with a negative price. The unit tests check this numerically (Durrleman's density
// condition, call-price convexity in strike, total variance increasing with maturity).
//
// Market.sigma remains the ATM volatility and a market without a smile prices exactly as
// before. Scenario revaluation is sticky-strike: atSpot() keeps the smile centred on the
// spot it was quoted at, so each strike keeps its volatility when spot moves.

import type { Market, Smile, TermStructure } from './types';

export type { Smile, TermStructure } from './types';

export const SMILE_PRESETS = {
  'Equity index': { rho: -0.7, eta: 1.0, gamma: 0.45 },
  'Single stock': { rho: -0.35, eta: 1.3, gamma: 0.4 },
} as const satisfies Record<string, Smile>;

export type SmilePreset = keyof typeof SMILE_PRESETS;

export const SMILE_LIMITS = { rho: [-0.95, 0.95], eta: [0.05, 2], gamma: [0.05, 0.5] } as const;

/** Upper bound on a leg volatility — the native engine's accepted range. */
export const MAX_SIGMA = 5;

/** True when the parameters lie in the arbitrage-free power-law region. */
export function validSmile(s: Smile): boolean {
  return Number.isFinite(s.rho) && Number.isFinite(s.eta) && Number.isFinite(s.gamma) &&
    Math.abs(s.rho) < 1 && s.eta > 0 && s.gamma > 0 && s.gamma <= 0.5 &&
    s.eta * (1 + Math.abs(s.rho)) <= 2 + 1e-12;
}

/** Clamp parameters into the slider limits and the arbitrage-free region (η ≤ 2 / (1 + |ρ|)). */
export function clampSmile(s: Smile): Smile {
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  const rho = clamp(s.rho, SMILE_LIMITS.rho);
  const gamma = clamp(s.gamma, SMILE_LIMITS.gamma);
  const eta = Math.min(clamp(s.eta, SMILE_LIMITS.eta), 2 / (1 + Math.abs(rho)));
  return { rho, eta, gamma };
}

export const phi = (theta: number, s: Smile): number =>
  s.eta / (Math.pow(theta, s.gamma) * Math.pow(1 + theta, 1 - s.gamma));

/** SSVI total variance w(k) and its first two derivatives in k, at ATM total variance θ. */
export function ssvi(k: number, theta: number, s: Smile): { w: number; dw: number; d2w: number } {
  const p = phi(theta, s);
  const x = p * k + s.rho;
  const R = Math.sqrt(x * x + 1 - s.rho * s.rho);
  return {
    w: (theta / 2) * (1 + s.rho * p * k + R),
    dw: (theta / 2) * (s.rho * p + (p * x) / R),
    d2w: (theta / 2) * (p * p * (1 - s.rho * s.rho)) / (R * R * R),
  };
}

/** Durrleman's g(k): the density implied by the smile is non-negative exactly when g ≥ 0. */
export function durrleman(k: number, theta: number, s: Smile): number {
  const { w, dw, d2w } = ssvi(k, theta, s);
  const a = 1 - (k * dw) / (2 * w);
  return a * a - ((dw * dw) / 4) * (1 / w + 0.25) + d2w / 2;
}

// ── At-the-money term structure ─────────────────────────────────────────────
//
// ATM total variance θ(T) = σ²·W(T), with σ the 30-day ATM volatility and W the shape of total
// variance in maturity, normalised so that W(30d) = 30d. Without a term structure W(T) = T:
// every expiry has ATM volatility σ, exactly as before.
//
//   curve   A(T) = T + (r² − 1)·(1 − e^{−κT})/κ,  W(T) = T₃₀·A(T)/A(T₃₀),  κ = ln 2 / half-life
//           the average of an instantaneous variance mean-reverting from r²·v̄ to v̄ (the Heston
//           expectation), r = short-end ÷ long-run ATM volatility. A′(T) = 1 + (r² − 1)·e^{−κT} ≥ min(1, r²) > 0.
//   fitted  W at listed expiries, linear in T between them and constant volatility outside.
//
// Gatheral & Jacquier (Theorem 4.2): SSVI is free of calendar spread arbitrage when θ(T) is
// non-decreasing and 0 ≤ ∂θ(θφ(θ)) ≤ (1 + √(1 − ρ²))·φ(θ)/ρ². For the power law ∂θ(θφ) = φ·(1 − γ)/(1 + θ) < φ,
// so a non-decreasing θ(T) is all that is needed; both shapes guarantee it.
//
// Vol scenarios (atVol) move σ and keep W, so every expiry's ATM volatility scales in proportion.

/** Maturity whose ATM volatility is σ when a term structure is set: 30 days, as for VIX. */
export const TERM_PIVOT_T = 30 / 365;

export const TERM_PRESETS = {
  // calm market — the shape of SPY's ATM term structure on 2026-09-14 (least squares on the live chain):
  // 7 days 0.86×, 3 months 1.23×, 1 year 1.53× the 30-day volatility
  Upward: { kind: 'curve', ratio: 0.5, halfLife: 0.15 },
  // stressed market, illustrative: front-week volatility 1.3× the 30-day level, one year 0.74×
  Inverted: { kind: 'curve', ratio: 2, halfLife: 0.02 },
} as const satisfies Record<string, TermStructure>;

export type TermPreset = keyof typeof TERM_PRESETS;

export const TERM_LIMITS = { ratio: [0.4, 2.5], halfLife: [3 / 365, 1] } as const;

/** True when the term structure is well formed; every such structure has non-decreasing total variance. */
export function validTerm(t: TermStructure): boolean {
  if (t.kind === 'curve') return t.ratio > 0 && t.halfLife > 0 && Number.isFinite(t.ratio) && Number.isFinite(t.halfLife);
  const n = t.T.length;
  if (n < 1 || t.w.length !== n) return false;
  for (let i = 0; i < n; i++) {
    if (!(t.T[i] > 0 && t.w[i] > 0 && Number.isFinite(t.T[i]) && Number.isFinite(t.w[i]))) return false;
    if (i > 0 && !(t.T[i] > t.T[i - 1] && t.w[i] >= t.w[i - 1])) return false;
  }
  return true;
}

/** Clamp a curve into the slider limits; a fitted structure is kept when well formed. */
export function clampTerm(t: TermStructure): TermStructure | null {
  if (t.kind === 'fitted') return validTerm(t) ? t : null;
  const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
  return { kind: 'curve', ratio: clamp(t.ratio, TERM_LIMITS.ratio), halfLife: clamp(t.halfLife, TERM_LIMITS.halfLife) };
}

/** W(T): ATM total variance at maturity T per unit of σ². */
export function termShape(t: TermStructure, T: number): number {
  if (t.kind === 'curve') {
    const kappa = Math.LN2 / t.halfLife, c = t.ratio * t.ratio - 1;
    const A = (x: number) => x - (c * Math.expm1(-kappa * x)) / kappa;
    return (TERM_PIVOT_T * A(T)) / A(TERM_PIVOT_T);
  }
  const { T: ts, w } = t, n = ts.length;
  if (T <= ts[0]) return (w[0] * T) / ts[0];
  if (T >= ts[n - 1]) return (w[n - 1] * T) / ts[n - 1];
  let i = 1;
  while (ts[i] < T) i++;
  if (ts[i] === T) return w[i];
  return w[i - 1] + ((T - ts[i - 1]) / (ts[i] - ts[i - 1])) * (w[i] - w[i - 1]);
}

/**
 * A fitted term structure through ATM total variances θ at listed expiries (strictly increasing T,
 * non-decreasing θ), with the 30-day ATM volatility σ it implies. Null when the pillars are not valid.
 */
export function fittedTerm(T: number[], theta: number[]): { sigma: number; term: TermStructure } | null {
  const raw: TermStructure = { kind: 'fitted', T, w: theta };
  if (!validTerm(raw)) return null;
  const s2 = termShape(raw, TERM_PIVOT_T) / TERM_PIVOT_T;
  return { sigma: Math.sqrt(s2), term: { kind: 'fitted', T: [...T], w: theta.map(x => x / s2) } };
}

/** ATM total variance θ(T) = σ²·W(T); σ²·T without a term structure. */
export function atmVariance(m: Market, T: number): number {
  const v = m.sigma * m.sigma;
  return m.term ? v * termShape(m.term, T) : v * T;
}

/** At-the-money-forward volatility at maturity T; σ without a term structure. */
export function atmVol(m: Market, T: number): number {
  if (!m.term || !(T > 0)) return m.sigma;
  const v = Math.sqrt(atmVariance(m, T) / T);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_SIGMA) : m.sigma;
}

/** True when legs can carry different volatilities: a smile, a term structure, or both. */
export const hasVolSurface = (m: Market): boolean => !!m.smile || !!m.term;

/** Implied volatility for strike K and expiry T under the market's smile and term structure; σ when flat. */
export function legSigma(m: Market, K: number, T: number): number {
  const s = m.smile;
  if ((!s && !m.term) || !(T > 0) || !(K > 0)) return m.sigma;
  let w = atmVariance(m, T);
  if (s) {
    const F = (m.smileSpot ?? m.S) * Math.exp((m.r - m.q) * T);
    w = ssvi(Math.log(K / F), w, s).w;
  }
  const v = Math.sqrt(w / T);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_SIGMA) : m.sigma;
}

/** The same market at another spot with every strike keeping its volatility (sticky strike). */
export const atSpot = (m: Market, S: number): Market =>
  (m.smile ? { ...m, S, smileSpot: m.smileSpot ?? m.S } : { ...m, S });

/** The same market with the ATM volatility replaced; the smile keeps its parameters and centre. */
export const atVol = (m: Market, sigma: number): Market =>
  (m.smile ? { ...m, sigma, smileSpot: m.smileSpot ?? m.S } : { ...m, sigma });
