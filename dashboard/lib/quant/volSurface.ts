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

import type { Market, Smile } from './types';

export type { Smile } from './types';

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

/** Implied volatility for strike K and expiry T under the market's smile; the ATM σ when flat. */
export function legSigma(m: Market, K: number, T: number): number {
  const s = m.smile;
  if (!s || !(T > 0) || !(K > 0)) return m.sigma;
  const F = (m.smileSpot ?? m.S) * Math.exp((m.r - m.q) * T);
  const { w } = ssvi(Math.log(K / F), m.sigma * m.sigma * T, s);
  const v = Math.sqrt(w / T);
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_SIGMA) : m.sigma;
}

/** The same market at another spot with every strike keeping its volatility (sticky strike). */
export const atSpot = (m: Market, S: number): Market =>
  (m.smile ? { ...m, S, smileSpot: m.smileSpot ?? m.S } : { ...m, S });

/** The same market with the ATM volatility replaced; the smile keeps its parameters and centre. */
export const atVol = (m: Market, sigma: number): Market =>
  (m.smile ? { ...m, sigma, smileSpot: m.smileSpot ?? m.S } : { ...m, sigma });
