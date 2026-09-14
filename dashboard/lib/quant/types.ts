// Core domain types shared by the pricing, strategy, risk and IO modules.

export interface Market {
  S: number;      // spot
  sigma: number;  // annualised volatility (decimal); the at-the-money-forward volatility when a smile is set
  r: number;      // continuously-compounded risk-free rate
  q: number;      // continuous dividend yield
  smile?: Smile | null;  // SSVI volatility smile; absent or null = flat volatility across strikes
  term?: TermStructure | null;  // ATM term structure; absent or null = the same ATM volatility at every expiry
  smileSpot?: number;    // spot the smile is centred on; set by atSpot() for sticky-strike scenarios
}

/**
 * At-the-money term structure (lib/quant/volSurface.ts). With one set, σ is the 30-day ATM volatility and
 * ATM total variance is σ²·W(T), where W is normalised so that W(30 days) = 30 days.
 */
export type TermStructure =
  | { kind: 'curve'; ratio: number; halfLife: number }   // short-end ÷ long-run ATM vol; years for the gap to halve
  | { kind: 'fitted'; T: number[]; w: number[] };         // W at listed expiries (years), fitted to option chains

/** SSVI smile parameters (lib/quant/volSurface.ts). */
export interface Smile {
  rho: number;    // skew, −1 < ρ < 1; negative makes downside strikes richer (equities)
  eta: number;    // smile curvature, η > 0
  gamma: number;  // how quickly curvature decays with maturity, 0 < γ ≤ ½
}

export interface Greeks {
  price: number;  // per-share price for one option, or $ value for a portfolio
  delta: number;
  gamma: number;
  theta: number;  // dV/dt per year (negative = time decay)
  vega: number;   // dV/dσ per 1.00 of volatility
}

export type Side = 'buy' | 'sell';

export interface Leg {
  id: string;
  call: boolean;
  side: Side;
  qty: number;      // contracts, always > 0
  K: number;        // strike
  T: number;        // years to expiry
  premium: number;  // entry price per share
}

/** Listed equity option contract multiplier. */
export const CONTRACT_MULT = 100;

export const signedQty = (l: Leg): number => (l.side === 'buy' ? l.qty : -l.qty);
