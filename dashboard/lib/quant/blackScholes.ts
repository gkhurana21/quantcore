import { normCdf, normPdf } from './normal';
import type { Greeks } from './types';

export const intrinsic = (call: boolean, S: number, K: number): number =>
  Math.max(call ? S - K : K - S, 0);

/**
 * Black-Scholes-Merton price and analytic Greeks for a European option with a
 * continuous dividend yield q. theta is dV/dt per year (negative = decay) and
 * vega is per 1.00 change in σ. With q = 0 these are exactly the formulas the
 * C++ core implements (core/src/black_scholes.cpp).
 */
export function bsGreeks(call: boolean, S: number, K: number, T: number,
                         sigma: number, r: number, q = 0): Greeks {
  if (!(S > 0) || !(K > 0)) return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 };
  if (T <= 0) {
    const itm = call ? S > K : K > S;
    return { price: intrinsic(call, S, K), delta: itm ? (call ? 1 : -1) : 0,
             gamma: 0, theta: 0, vega: 0 };
  }
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  if (!(sigma > 1e-12)) {
    const fwd = S * dq - K * dr;
    const price = Math.max(call ? fwd : -fwd, 0);
    return { price, delta: price > 0 ? (call ? dq : -dq) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const volT = sigma * sqrtT;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / volT;
  const d2 = d1 - volT;
  const pdf = normPdf(d1);
  const gamma = (dq * pdf) / (S * volT);
  const vega = S * dq * pdf * sqrtT;
  const decay = -(S * dq * pdf * sigma) / (2 * sqrtT);
  if (call) {
    const Nd1 = normCdf(d1), Nd2 = normCdf(d2);
    return { price: S * dq * Nd1 - K * dr * Nd2, delta: dq * Nd1, gamma, vega,
             theta: decay - r * K * dr * Nd2 + q * S * dq * Nd1 };
  }
  const Nmd1 = normCdf(-d1), Nmd2 = normCdf(-d2);
  return { price: K * dr * Nmd2 - S * dq * Nmd1, delta: -dq * Nmd1, gamma, vega,
           theta: decay + r * K * dr * Nmd2 - q * S * dq * Nmd1 };
}

/** Price only — the hot path for curves, surfaces and Monte Carlo VaR. */
export function bsPrice(call: boolean, S: number, K: number, T: number,
                        sigma: number, r: number, q = 0): number {
  if (!(S > 0) || !(K > 0)) return 0;
  if (T <= 0) return intrinsic(call, S, K);
  const dq = Math.exp(-q * T), dr = Math.exp(-r * T);
  if (!(sigma > 1e-12)) return Math.max(call ? S * dq - K * dr : K * dr - S * dq, 0);
  const volT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / volT;
  const d2 = d1 - volT;
  return call ? S * dq * normCdf(d1) - K * dr * normCdf(d2)
              : K * dr * normCdf(-d2) - S * dq * normCdf(-d1);
}

/** Risk-neutral probability of finishing in the money: N(d2) for calls, N(−d2) for puts. */
export function probItm(call: boolean, S: number, K: number, T: number,
                        sigma: number, r: number, q = 0): number {
  if (T <= 0 || !(sigma > 1e-12)) return intrinsic(call, S, K) > 0 ? 1 : 0;
  const volT = sigma * Math.sqrt(T);
  const d2 = (Math.log(S / K) + (r - q - 0.5 * sigma * sigma) * T) / volT;
  return call ? normCdf(d2) : normCdf(-d2);
}
