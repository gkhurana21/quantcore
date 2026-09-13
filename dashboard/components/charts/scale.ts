// Small chart helpers shared by the SVG charts: nice ticks, scales, paths, lookup.

export function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo)) return [lo];
  const step = niceStep(hi - lo, count);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12));
  }
  return out;
}

export const linear = (d0: number, d1: number, r0: number, r1: number) =>
  (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

export function pathD(xs: ArrayLike<number>, ys: ArrayLike<number>,
                      X: (v: number) => number, Y: (v: number) => number): string {
  let d = '';
  for (let i = 0; i < xs.length; i++) d += `${i ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`;
  return d;
}

/** Index of the element of an ascending array closest to v. */
export function nearestIndex(xs: ArrayLike<number>, v: number): number {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= v) lo = mid; else hi = mid;
  }
  return Math.abs(xs[lo] - v) <= Math.abs(xs[hi] - v) ? lo : hi;
}

const MINUS = '−';

/** Axis-friendly dollars: $950, $12k, −$1.2M */
export function usdTick(v: number): string {
  const a = Math.abs(v), s = v < 0 ? MINUS : '';
  if (a >= 1e6) return `${s}$${+(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${s}$${+(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
  return `${s}$${+a.toFixed(a < 10 && a > 0 ? 1 : 0)}`;
}

export function numTick(v: number): string {
  const a = Math.abs(v), s = v < 0 ? MINUS : '';
  if (a >= 1e6) return `${s}${+(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${s}${+(a / 1e3).toFixed(0)}k`;
  if (a >= 100) return `${s}${a.toFixed(0)}`;
  if (a >= 1) return `${s}${+a.toFixed(1)}`;
  return `${s}${+a.toFixed(3)}`;
}
