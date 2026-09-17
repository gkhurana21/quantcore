// Path-dependent options in closed form under Black-Scholes-Merton (flat volatility):
//
//  • Barrier options — Reiner & Rubinstein (1991), as tabulated by Haug (The Complete Guide to Option Pricing
//    Formulas, §4.17). Knock-out prices come from the formulas; knock-in prices from in-out parity,
//    in + out = vanilla, which holds path by path without rebates. barrierPricesDiscrete corrects the price for a
//    barrier watched on a finite number of dates (Broadie–Glasserman–Kou), and barrierPricesRebate adds the rebate
//    terms E and F, which break that parity by exactly the rebate's discounted value.
//  • Geometric-average Asian options on n equally spaced fixings t_i = T·i/n: ln G is normal with mean
//    ln S + (r − q − σ²/2)·T(n + 1)/(2n) and variance σ²·T(n + 1)(2n + 1)/(6n²), so the price is
//    Black-Scholes-like. It is the exact reference, and the control variate, for arithmetic averages under GBM.
//
// The tests check the barrier formulas against a Crank–Nicolson PDE solver and Monte Carlo with Brownian-bridge
// monitoring, and the Asian formula against its one-fixing (vanilla) and continuous limits and Monte Carlo.

import { bsPrice, intrinsic } from './blackScholes';
import { normCdf } from './normal';

export interface BarrierPrices {
  out: number;       // knock-out: pays the vanilla payoff only if the barrier is never touched
  in: number;        // knock-in: pays only if it is touched
  vanilla: number;
}

/** Continuously monitored barrier option prices. `up`: the barrier is above spot; otherwise below. */
export function barrierPrices(call: boolean, up: boolean, S: number, K: number, H: number, T: number,
                              sigma: number, r: number, q: number): BarrierPrices {
  const vanilla = T > 0 ? bsPrice(call, S, K, T, sigma, r, q) : intrinsic(call, S, K);
  const touched = up ? S >= H : S <= H;
  if (touched) return { out: 0, in: vanilla, vanilla };
  if (!(T > 0) || !(sigma > 0)) return { out: vanilla, in: 0, vanilla };

  const sd = sigma * Math.sqrt(T);
  const mu = (r - q - (sigma * sigma) / 2) / (sigma * sigma);
  const x1 = Math.log(S / K) / sd + (1 + mu) * sd;
  const x2 = Math.log(S / H) / sd + (1 + mu) * sd;
  const y1 = Math.log((H * H) / (S * K)) / sd + (1 + mu) * sd;
  const y2 = Math.log(H / S) / sd + (1 + mu) * sd;
  const phi = call ? 1 : -1, eta = up ? -1 : 1;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  const hs = H / S, hs2mu = Math.pow(hs, 2 * mu), hs2mu1 = hs2mu * hs * hs;
  const A = phi * S * dq * normCdf(phi * x1) - phi * K * dr * normCdf(phi * (x1 - sd));
  const B = phi * S * dq * normCdf(phi * x2) - phi * K * dr * normCdf(phi * (x2 - sd));
  const C = phi * S * dq * hs2mu1 * normCdf(eta * y1) - phi * K * dr * hs2mu * normCdf(eta * (y1 - sd));
  const D = phi * S * dq * hs2mu1 * normCdf(eta * y2) - phi * K * dr * hs2mu * normCdf(eta * (y2 - sd));

  let out: number;
  if (call && !up) out = K > H ? A - C : B - D;              // down-and-out call
  else if (call && up) out = K >= H ? 0 : A - B + C - D;     // up-and-out call
  else if (!call && !up) out = K <= H ? 0 : A - B + C - D;   // down-and-out put
  else out = K >= H ? B - D : A - C;                         // up-and-out put
  out = Math.min(vanilla, Math.max(0, out));                  // rounding at the edges of the domain
  return { out, in: vanilla - out, vanilla };
}

/** β = −ζ(½)/√(2π), the Broadie–Glasserman–Kou barrier shift in units of σ√Δt. */
export const BGK_BETA = 0.5825971579390106;

/**
 * Barrier option monitored at `monitors` equally spaced dates k·T/m, by the Broadie–Glasserman–Kou correction: the
 * continuous formula with the barrier moved away from the spot to H·exp(±β σ √(T/m)). A barrier tested on only m
 * dates is harder to breach, so the discretely monitored knock-out is worth more than the continuous one. The
 * correction's error is o(1/√m) — far smaller than the discrete-vs-continuous gap it removes, but it is asymptotic
 * and weakest at very few monitoring dates. m < 1 prices continuous monitoring.
 */
export function barrierPricesDiscrete(call: boolean, up: boolean, S: number, K: number, H: number, T: number,
                                      sigma: number, r: number, q: number, monitors: number): BarrierPrices {
  if (!(monitors >= 1) || !(T > 0) || !(sigma > 0) || !(H > 0)) return barrierPrices(call, up, S, K, H, T, sigma, r, q);
  const shift = Math.exp((up ? 1 : -1) * BGK_BETA * sigma * Math.sqrt(T / monitors));
  return barrierPrices(call, up, S, K, H * shift, T, sigma, r, q);
}

/**
 * Barrier option paying a rebate, continuously monitored (Reiner & Rubinstein's E and F terms). The knock-out pays
 * `rebate` when the barrier is hit if `atHit`, otherwise at expiry — the first is worth more, the money arriving
 * earlier. The knock-in pays it at expiry when the barrier is never touched.
 *
 * A rebate breaks in-out parity. With the rebate paid at expiry the two sides together pay it in every state, so
 * in + out − vanilla is exactly R·e^(−rT); paid at the hit, the out side is worth more still. Parity is restored
 * exactly when `rebate` is 0.
 */
export function barrierPricesRebate(call: boolean, up: boolean, S: number, K: number, H: number, T: number,
                                    sigma: number, r: number, q: number, rebate: number, atHit: boolean): BarrierPrices {
  const p = barrierPrices(call, up, S, K, H, T, sigma, r, q);
  if (!(rebate > 0) || !Number.isFinite(rebate)) return p;
  if (up ? S >= H : S <= H) {
    // already through the barrier: the out side is the rebate alone, and the in side can no longer earn one
    return { out: atHit ? rebate : rebate * Math.exp(-r * T), in: p.in, vanilla: p.vanilla };
  }
  if (!(T > 0) || !(sigma > 0) || !(H > 0)) return p;

  const sd = sigma * Math.sqrt(T);
  const mu = (r - q - (sigma * sigma) / 2) / (sigma * sigma);
  const lambda = Math.sqrt(mu * mu + (2 * r) / (sigma * sigma));
  const eta = up ? -1 : 1;
  const hs = H / S;
  const x2 = Math.log(S / H) / sd + (1 + mu) * sd;
  const y2 = Math.log(H / S) / sd + (1 + mu) * sd;
  const z = Math.log(H / S) / sd + lambda * sd;
  const noHit = normCdf(eta * (x2 - sd)) - Math.pow(hs, 2 * mu) * normCdf(eta * (y2 - sd));
  const f = rebate * (Math.pow(hs, mu + lambda) * normCdf(eta * z) +
                      Math.pow(hs, mu - lambda) * normCdf(eta * (z - 2 * lambda * sd)));
  const dr = Math.exp(-r * T);
  return { out: p.out + (atHit ? f : rebate * dr * (1 - noHit)), in: p.in + rebate * dr * noHit, vanilla: p.vanilla };
}

/** Geometric-average Asian option on n equally spaced fixings T·i/n, i = 1..n (flat volatility). */
export function geometricAsianPrice(call: boolean, S: number, K: number, T: number, n: number,
                                    sigma: number, r: number, q: number): number {
  if (!(T > 0) || !(sigma > 0) || !(n >= 1)) return intrinsic(call, S, K);
  const tbar = (T * (n + 1)) / (2 * n);
  const variance = (sigma * sigma * T * (n + 1) * (2 * n + 1)) / (6 * n * n);
  const mean = Math.log(S) + (r - q - (sigma * sigma) / 2) * tbar;
  const sd = Math.sqrt(variance);
  const forwardG = Math.exp(mean + variance / 2);             // E[G]
  const d1 = (mean - Math.log(K) + variance) / sd, d2 = d1 - sd;
  const df = Math.exp(-r * T);
  return call ? df * (forwardG * normCdf(d1) - K * normCdf(d2)) : df * (K * normCdf(-d2) - forwardG * normCdf(-d1));
}

/** E[G] for the geometric average — the control-variate mean for arithmetic Asian Monte Carlo under GBM. */
export function geometricAverageMean(S: number, T: number, n: number, sigma: number, r: number, q: number): number {
  const tbar = (T * (n + 1)) / (2 * n);
  const variance = (sigma * sigma * T * (n + 1) * (2 * n + 1)) / (6 * n * n);
  return Math.exp(Math.log(S) + (r - q - (sigma * sigma) / 2) * tbar + variance / 2);
}

// ── Monte Carlo (the C++ kernel: native engine or WebAssembly) ───────────────

/** Barrier levels one simulation prices on the same paths, and the most Asian fixings (core/include/quantcore/exotics.hpp). */
export const MAX_BARRIER_LEVELS = 16;
export const MAX_ASIAN_FIXINGS = 2000;
/** Monitoring dates one discretely monitored barrier run may use (daily over eight years). */
export const MAX_BARRIER_MONITORS = 2000;

/**
 * A barrier option at one or more levels, or an Asian option on n equally spaced fixings. `monitors` is the number of
 * equally spaced dates the barrier is tested on; absent or 0 monitors it continuously.
 */
export type ExoticSpec =
  | { kind: 'barrier'; call: boolean; K: number; T: number; up: boolean; levels: number[]; monitors?: number;
      rebate?: number; rebateAtHit?: boolean }
  | { kind: 'asian'; call: boolean; K: number; T: number; fixings: number };

/**
 * A Monte Carlo run of an exotic, per unit of underlying. Barrier runs fill the per-level arrays and Asian runs the
 * average fields; both price the vanilla on the same paths. Fine-grid biases (coarse − fine means) are null without
 * Richardson extrapolation.
 */
export interface ExoticMcResult {
  paths: number;
  steps: number;
  monitors: number;             // barrier monitoring dates used; 0 when the barrier was monitored continuously
  vanilla: number; vanillaSe: number; vanillaFineBias: number | null;
  out: number[]; outSe: number[]; outFineBias: (number | null)[];
  in: number[]; inSe: number[];
  arith: number | null; arithSe: number | null; arithFineBias: number | null;
  geo: number | null; geoSe: number | null;
  arithGeoCov: number | null;   // covariance of the per-path arithmetic and geometric payoffs
}

/**
 * The arithmetic-average estimate with the geometric average as control variate (Kemna & Vorst, 1990):
 * Â = Ā − β(Ḡ − G*), β = Cov(A, G)/Var(G), SE(Â) = √((Var A − Cov²/Var G)/N), where G* is the geometric option's exact
 * value. Valid only where G* is exact — flat volatility. Variances are recovered from the standard errors (SE²·N).
 */
export function controlVariate(r: Pick<ExoticMcResult, 'paths' | 'arith' | 'arithSe' | 'geo' | 'geoSe' | 'arithGeoCov'>,
                               geoExact: number): { value: number; se: number; beta: number } | null {
  const { paths: N, arith, arithSe, geo, geoSe, arithGeoCov: cov } = r;
  if (arith == null || arithSe == null || geo == null || geoSe == null || cov == null || !(N > 1)) return null;
  const varA = arithSe * arithSe * N, varG = geoSe * geoSe * N;
  if (!(varG > 0)) return { value: arith, se: arithSe, beta: 0 };
  const beta = cov / varG;
  return { value: arith - beta * (geo - geoExact), se: Math.sqrt(Math.max(varA - (cov * cov) / varG, 0) / N), beta };
}
