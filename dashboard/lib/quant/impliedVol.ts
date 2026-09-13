import { bsGreeks, bsPrice } from './blackScholes';

export interface ImpliedVol { sigma: number; iterations: number; }

const MIN_VOL = 1e-4;
const MAX_VOL = 5;

/**
 * Implied volatility of a European option from its price (Black-Scholes-Merton).
 *
 * Newton-Raphson on vega, safeguarded by a bracket that shrinks every step:
 * whenever a Newton step would leave the bracket (or vega vanishes) the solver
 * bisects instead, so it always converges. Returns null when the price is
 * outside the no-arbitrage bounds — at or below discounted intrinsic value, or at
 * or above S·e^(−qT) for a call / K·e^(−rT) for a put — or not reachable with a
 * volatility between 0.01% and 500%.
 */
export function impliedVol(call: boolean, price: number, S: number, K: number, T: number,
                           r: number, q = 0, tol = 1e-10): ImpliedVol | null {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  const lower = Math.max(call ? S * dq - K * dr : K * dr - S * dq, 0);
  const upper = call ? S * dq : K * dr;
  if (price <= lower || price >= upper) return null;

  let lo = MIN_VOL, hi = MAX_VOL;
  if (bsPrice(call, S, K, T, lo, r, q) > price || bsPrice(call, S, K, T, hi, r, q) < price) return null;

  // Manaster-Koehler starting point; ATM-forward options fall back to 20%
  let sigma = Math.sqrt((2 * Math.abs(Math.log(S / K) + (r - q) * T)) / T) || 0.2;
  sigma = Math.min(hi, Math.max(lo, sigma));

  for (let i = 1; i <= 200; i++) {
    const g = bsGreeks(call, S, K, T, sigma, r, q);
    const diff = g.price - price;
    if (Math.abs(diff) < tol) return { sigma, iterations: i };
    if (diff > 0) hi = sigma; else lo = sigma;
    let next = g.vega > 0 ? sigma - diff / g.vega : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - sigma) < 1e-15 || hi - lo < 1e-15) return { sigma: next, iterations: i };
    sigma = next;
  }
  return { sigma, iterations: 200 };
}
