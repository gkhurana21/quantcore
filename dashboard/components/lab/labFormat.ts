export const Z95 = 1.959963984540054;

export const fmtMs = (ms: number): string =>
  !Number.isFinite(ms) ? '—'
    : ms < 0.01 ? `${(ms * 1000).toFixed(1)} µs`
    : ms < 1 ? `${ms.toFixed(3)} ms`
    : ms < 1000 ? `${ms.toFixed(1)} ms`
    : `${(ms / 1000).toFixed(2)} s`;

export const fmtPaths = (n: number): string =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n);

/** Decimal places that resolve a tick step (e.g. step 0.05 → 2). */
export const decimalsFor = (step: number): number => Math.min(4, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
