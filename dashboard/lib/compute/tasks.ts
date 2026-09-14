// Heavy, pure computations behind the Pricing Models Lab, the Monte Carlo view
// and Monte Carlo VaR. They run inside a Web Worker (workers/compute.worker.ts)
// and fall back to the main thread when workers are unavailable. Every task is
// seeded, so the same request always produces the same numbers.

import { crrAmericanPrice, crrPrice, CRR_STEPS } from '../quant/binomial';
import { probItm } from '../quant/blackScholes';
import { atSpot, legSigma } from '../quant/volSurface';
import { smileDistribution } from '../quant/impliedDensity';
import { mulberry32 } from '../quant/rng';
import type { McResult, TerminalDistribution } from '../quant/monteCarlo';
import { lognormalPdf, mcPortfolio, samplePaths, terminalDistribution } from '../quant/monteCarlo';
import type { Leg, Market } from '../quant/types';
import { CONTRACT_MULT as M, signedQty } from '../quant/types';
import type { McVarResult, VolFactor } from '../risk/var';
import { mcVaR } from '../risk/var';
import { firstExpiry, netPremium, pnlAtFirstExpiry, portfolioValue } from '../strategy/portfolio';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Mean wall time of `fn`, repeated until at least `minMs` has elapsed (timer resolution is coarse). */
function timeIt<T>(fn: () => T, minMs: number): { value: T; ms: number; runs: number } {
  let value = fn();
  let runs = 1;
  const t0 = now();
  let elapsed = 0;
  for (; elapsed < minMs && runs < 100_000; runs++) {
    value = fn();
    elapsed = now() - t0;
  }
  return { value, ms: elapsed / Math.max(runs - 1, 1), runs: runs - 1 };
}

// ── Pricing Models Lab ──────────────────────────────────────────────────────

export const LAB_PATHS = [10_000, 50_000, 200_000] as const;
export const CONVERGENCE_CHECKPOINTS = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000];
const LEG_MC_PATHS = 50_000;

export interface LabRequest { legs: Leg[]; market: Market; seed: number; antithetic: boolean; }

export interface LabMcRun extends McResult { seed: number; }

export interface LabLegRow { bs: number; crr: number; american: number; mc: number; mcSe: number; }

export interface LabResult {
  bs: { value: number; ms: number; runs: number };
  crr: { value: number; ms: number; runs: number; steps: number };
  american: { value: number; ms: number; runs: number };   // same lattice with early exercise
  mc: LabMcRun[];                               // one run per LAB_PATHS entry (seeds s, s+1, s+2)
  crrCurve: { steps: number; error: number }[]; // portfolio CRR − BS by lattice size
  perLeg: LabLegRow[];                          // per-share prices, one row per leg
  gross: number;                                // Σ |qty·100·BS| — scale for relative errors
  legMcPaths: number;
}

const legBs = (l: Leg, m: Market) => portfolioValue([{ ...l, side: 'buy', qty: 1 }], m) / M;

function crrValue(legs: Leg[], m: Market, steps: number): number {
  let v = 0;
  for (const l of legs) v += signedQty(l) * M * crrPrice(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q, steps);
  return v;
}

function americanValue(legs: Leg[], m: Market, steps: number): number {
  let v = 0;
  for (const l of legs) v += signedQty(l) * M * crrAmericanPrice(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q, steps);
  return v;
}

export function runLab({ legs, market: m, seed, antithetic }: LabRequest): LabResult {
  const bs = timeIt(() => portfolioValue(legs, m), 3);
  const crr = timeIt(() => crrValue(legs, m, CRR_STEPS), 8);
  const american = timeIt(() => americanValue(legs, m, CRR_STEPS), 8);

  const mc = LAB_PATHS.map((paths, i) => ({
    ...mcPortfolio(legs, m, paths, seed + i, antithetic, i === LAB_PATHS.length - 1 ? CONVERGENCE_CHECKPOINTS : []),
    seed: seed + i,
  }));

  const stepsList: number[] = [];
  for (let n = 2; n <= 120; n++) stepsList.push(n);
  stepsList.push(160, 200, 256, 320, 400, 512);
  const crrCurve = stepsList.map(steps => ({ steps, error: crrValue(legs, m, steps) - bs.value }));

  const perLeg = legs.map((l, i) => {
    const unit: Leg = { ...l, side: 'buy', qty: 1 };
    const r = mcPortfolio([unit], m, LEG_MC_PATHS, seed + 100 + i, antithetic);
    return {
      bs: legBs(l, m),
      crr: crrPrice(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q, CRR_STEPS),
      american: crrAmericanPrice(l.call, m.S, l.K, l.T, legSigma(m, l.K, l.T), m.r, m.q, CRR_STEPS),
      mc: r.price / M, mcSe: r.se / M,
    };
  });

  const gross = legs.reduce((a, l, i) => a + Math.abs(l.qty * M * perLeg[i].bs), 0);
  return { bs: { value: bs.value, ms: bs.ms, runs: bs.runs },
           crr: { value: crr.value, ms: crr.ms, runs: crr.runs, steps: CRR_STEPS },
           american: { value: american.value, ms: american.ms, runs: american.runs },
           mc, crrCurve, perLeg, gross, legMcPaths: LEG_MC_PATHS };
}

// ── Monte Carlo visualisation ───────────────────────────────────────────────

export interface McVizRequest {
  legs: Leg[]; market: Market; seed: number;
  nPaths: number; nSteps: number; histSamples: number; bins: number;
}

export interface McVizResult {
  paths: number[][];
  horizonT: number;              // paths run to the last expiry
  expiries: number[];            // distinct leg expiries (years)
  strikes: number[];
  firstT: number;                // histogram horizon
  dist: TerminalDistribution;
  pdf: { x: number; y: number }[];   // density scaled to expected counts per bin: smile-implied with a smile, else lognormal
  pdfLognormal: { x: number; y: number }[];   // with a smile: the lognormal at ATM σ, for comparison (else empty)
  density: 'smile' | 'lognormal';    // the distribution the histogram samples
  analyticItm: number | null;        // N(d2) — single-leg portfolios
  pProfit: number;                   // empirical P(P&L > 0) at the first expiry
  expectedPnl: number;               // mean P&L at the first expiry across samples
  forward: number;
  pathSigma: number;                 // volatility of the simulated GBM: the leg's smile vol for one leg, ATM σ otherwise
  ms: number;
}

export function runMcViz(req: McVizRequest): McVizResult {
  const t0 = now();
  const { legs, market: m, seed } = req;
  const expiries = Array.from(new Set(legs.map(l => Math.max(0, l.T)))).sort((a, b) => a - b);
  const horizonT = Math.max(expiries[expiries.length - 1] ?? 0, 1 / 365);
  const firstT = Math.max(firstExpiry(legs), 1 / 365);
  const strikes = Array.from(new Set(legs.map(l => l.K))).sort((a, b) => a - b);
  const single = legs.length === 1 ? legs[0] : null;
  // GBM has one volatility: a single leg is simulated at its own smile volatility (so its
  // price and P(ITM) match), a multi-leg portfolio at the ATM volatility.
  const vm: Market = { S: m.S, sigma: single ? legSigma(m, single.K, single.T) : m.sigma, r: m.r, q: m.q };

  const paths = samplePaths(vm, horizonT, req.nPaths, req.nSteps, seed);

  let profit = 0, pnlSum = 0;
  const later = legs.some(l => l.T - firstT > 1e-9);
  const cost = netPremium(legs);
  // With a smile the price at the first expiry is drawn from the distribution the smile implies
  // (Breeden–Litzenberger), so P(ITM), P(profit) and expected P&L agree with the smile's prices.
  const smileDist = smileDistribution(m, firstT);
  const uniform = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const dist = terminalDistribution(vm, firstT, req.histSamples, req.bins, seed ^ 0x5bd1e995,
    single ? { K: single.K, call: single.call } : undefined,
    s => {
      const pnl = later ? pnlAtFirstExpiry(legs, atSpot(m, s)) : expiryPnl(legs, s, cost);
      pnlSum += pnl;
      if (pnl > 0) profit++;
    },
    smileDist ? () => smileDist.quantile(uniform()) : undefined);

  const pdf: { x: number; y: number }[] = [];
  const pdfLognormal: { x: number; y: number }[] = [];
  const atm: Market = { S: m.S, sigma: m.sigma, r: m.r, q: m.q };
  const perBin = dist.samples * dist.binWidth;
  const nPts = 120;
  for (let i = 0; i <= nPts; i++) {
    const x = dist.lo + ((dist.hi - dist.lo) * i) / nPts;
    pdf.push({ x, y: (smileDist ? smileDist.pdf(x) : lognormalPdf(x, vm, firstT)) * perBin });
    if (smileDist) pdfLognormal.push({ x, y: lognormalPdf(x, atm, firstT) * perBin });
  }

  return {
    paths, horizonT, expiries, strikes, firstT, dist, pdf, pdfLognormal,
    density: smileDist ? 'smile' : 'lognormal',
    analyticItm: !single ? null
      : smileDist ? (single.call ? smileDist.probAbove(single.K) : 1 - smileDist.probAbove(single.K))
      : probItm(single.call, m.S, single.K, firstT, vm.sigma, m.r, m.q),
    pProfit: profit / req.histSamples,
    expectedPnl: pnlSum / req.histSamples,
    forward: m.S * Math.exp((m.r - m.q) * firstT),
    pathSigma: vm.sigma,
    ms: now() - t0,
  };
}

function expiryPnl(legs: Leg[], s: number, cost: number): number {
  let v = 0;
  for (const l of legs) v += signedQty(l) * M * (l.call ? Math.max(s - l.K, 0) : Math.max(l.K - s, 0));
  return v - cost;
}

// ── Monte Carlo VaR ─────────────────────────────────────────────────────────

export interface McVarRequest {
  legs: Leg[]; market: Market; conf: number; hDays: number; nScen: number; seed: number;
  volFactor?: VolFactor;   // present → two-factor (spot + implied vol) scenarios
}

export const runMcVar = (r: McVarRequest): McVarResult =>
  mcVaR(r.legs, r.market, r.conf, r.hDays, r.nScen, r.seed, r.volFactor);

// ── dispatch ────────────────────────────────────────────────────────────────

export interface TaskMap {
  lab: [LabRequest, LabResult];
  mcviz: [McVizRequest, McVizResult];
  mcvar: [McVarRequest, McVarResult];
}
export type TaskKind = keyof TaskMap;

export function runTask<K extends TaskKind>(kind: K, req: TaskMap[K][0]): TaskMap[K][1] {
  switch (kind) {
    case 'lab': return runLab(req as LabRequest) as TaskMap[K][1];
    case 'mcviz': return runMcViz(req as McVizRequest) as TaskMap[K][1];
    case 'mcvar': return runMcVar(req as McVarRequest) as TaskMap[K][1];
    default: throw new Error(`unknown task ${String(kind)}`);
  }
}
