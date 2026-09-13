// Figures reported in the repository README, measured on an Apple M3 MacBook Air.
// Kept verbatim in scope: baseline, workload and what the timing includes.

export interface Benchmark { value: string; label: string; detail: string; }

export const BENCHMARKS: Benchmark[] = [
  { value: '69×', label: 'Metal GPU Monte Carlo',
    detail: '10M paths vs vectorized NumPy (23.5× at 1M) · timing includes host↔GPU transfer' },
  { value: '4.1×', label: 'CPU Monte Carlo', detail: '8 threads + Accelerate SIMD vs vectorized NumPy' },
  { value: '3.8×', label: 'Black-Scholes batch', detail: 'Accelerate vForce SIMD vs vectorized NumPy' },
  { value: '4.6 ms', label: 'WebSocket p99',
    detail: 'end-to-end on localhost loopback, 5 concurrent clients at 100 updates/s (3.1 ms with one client)' },
  { value: '4.5%', label: 'VaR backtest breaches',
    detail: 'historical-simulation 95% VaR, 851 trading days of multi-asset data (5% expected)' },
];

export const BENCH_SOURCE =
  'Apple M3 MacBook Air · reproduce with python/benchmark_v2.py, python/phase6_gate.py, ' +
  'python/phase3_gate.py and server/latency_harness.py';

export const VAR_BACKTEST =
  'The repository’s offline backtest (python/phase3_gate.py) of a historical-simulation 95% VaR over ' +
  '851 trading days of real multi-asset data recorded a 4.5% breach rate against 5% expected. It ' +
  'validates that backtesting pipeline; the parametric figures on this page are a separate ' +
  'single-underlying research model and have not been backtested here.';
