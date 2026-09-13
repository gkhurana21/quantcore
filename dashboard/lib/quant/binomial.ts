import { bsPrice, intrinsic } from './blackScholes';

export const CRR_STEPS = 512;

/**
 * Cox-Ross-Rubinstein binomial lattice price for a European option with a
 * continuous dividend yield. u = e^{σ√Δt}, d = 1/u, p = (e^{(r−q)Δt} − d)/(u − d).
 * Terminal node prices are built in log space for numerical stability.
 */
export function crrPrice(call: boolean, S: number, K: number, T: number,
                         sigma: number, r: number, q = 0, steps = CRR_STEPS): number {
  if (!(S > 0) || !(K > 0)) return 0;
  if (T <= 0 || !(sigma > 1e-12)) return bsPrice(call, S, K, T, sigma, r, q);
  const n = Math.max(1, Math.floor(steps));
  const dt = T / n;
  const lnu = sigma * Math.sqrt(dt);
  const u = Math.exp(lnu), d = 1 / u;
  const p = Math.min(1, Math.max(0, (Math.exp((r - q) * dt) - d) / (u - d)));
  const disc = Math.exp(-r * dt);
  const pu = disc * p, pd = disc * (1 - p);
  const v = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) v[i] = intrinsic(call, S * Math.exp((n - 2 * i) * lnu), K);
  for (let s = n - 1; s >= 0; s--) {
    for (let i = 0; i <= s; i++) v[i] = pu * v[i] + pd * v[i + 1];
  }
  return v[0];
}

/** Lattice price at several step counts — shows the classic odd/even convergence to BS. */
export function crrConvergence(call: boolean, S: number, K: number, T: number,
                               sigma: number, r: number, q: number,
                               stepsList: number[]): { steps: number; price: number }[] {
  return stepsList.map(steps => ({ steps, price: crrPrice(call, S, K, T, sigma, r, q, steps) }));
}
