// Number formatting for the terminal. Negative values use a true minus sign.

const MINUS = '−';

const withCommas = (v: number, d: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** True when v is negative and still shows a nonzero digit at d decimals, so a value a hair below zero never renders as "−0". */
const showsNegative = (v: number, d: number) => v < 0 && Number(Math.abs(v).toFixed(d)) !== 0;

/** v.toFixed(d) without a signed zero ("-0.0000" → "0.0000"). */
export function fixed(v: number, d: number): string {
  return (showsNegative(v, d) ? v : Math.abs(v)).toFixed(d);
}

/** $1,234 / −$1,234 */
export function usd(v: number, d = 0): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : `${MINUS}∞`;
  return `${showsNegative(v, d) ? MINUS : ''}$${withCommas(Math.abs(v), d)}`;
}

/** +$1,234 / −$1,234 */
export function usdSigned(v: number, d = 0): string {
  if (!Number.isFinite(v)) return v > 0 ? '+∞' : `${MINUS}∞`;
  const rounded = Number(Math.abs(v).toFixed(d));
  return `${v < 0 && rounded !== 0 ? MINUS : '+'}$${withCommas(Math.abs(v), d)}`;
}

/** Compact signed dollars: +$840, −$12.4k, +$1.2M */
export function usdCompact(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '+∞' : `${MINUS}∞`;
  const a = Math.abs(v), s = showsNegative(v, 0) ? MINUS : '+';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e5) return `${s}$${(a / 1e3).toFixed(0)}k`;
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${a.toFixed(0)}`;
}

export function num(v: number, d = 2): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : `${MINUS}∞`;
  return `${showsNegative(v, d) ? MINUS : ''}${withCommas(Math.abs(v), d)}`;
}

export function signed(v: number, d = 2): string {
  return `${showsNegative(v, d) ? MINUS : '+'}${withCommas(Math.abs(v), d)}`;
}

/** 0.1234 → 12.34% */
export const pct = (v: number, d = 1): string => `${num(v * 100, d)}%`;

export const signedPct = (v: number, d = 1): string => `${signed(v * 100, d)}%`;

export const days = (T: number): number => Math.round(T * 365);
