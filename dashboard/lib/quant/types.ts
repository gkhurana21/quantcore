// Core domain types shared by the pricing, strategy, risk and IO modules.

export interface Market {
  S: number;      // spot
  sigma: number;  // annualised volatility (decimal)
  r: number;      // continuously-compounded risk-free rate
  q: number;      // continuous dividend yield
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
