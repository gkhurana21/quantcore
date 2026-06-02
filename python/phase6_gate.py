#!/usr/bin/env python3
"""
QuantCore Phase 6 — Metal GPU Monte Carlo gate
===============================================
CORRECTNESS FIRST, then benchmark.  A wrong-but-fast price is useless.

Correctness gate
----------------
GPU MC at 1e5, 1e6, 1e7 paths vs Black-Scholes closed form.
Same convergence test as Phase 1 (Hull 9e case), now on GPU.
Expected: error shrinks ~3× per decade (1/√N); |Err|/SE ≈ O(1) (no bias).

Benchmark gate
--------------
Full end-to-end timing:
  host→GPU param write + Metal command encode/dispatch
  + [cmd waitUntilCompleted] + GPU→host readback + host reduction.
Transfer overhead is INCLUDED.  Kernel-only time is NOT reported.

Baselines:
  (a) Phase 2b multithreaded+SIMD CPU MC (mc_price_mt)
  (b) Vectorized NumPy MC (quantcore_ref.mc_price_numpy)

Methodology: 20 timed runs, 3 warmup (discarded), report mean±std and median.
Path counts tested: 1e5, 1e6, 1e7 (crossover from CPU→GPU visible).
"""

import sys, os, statistics, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import quantcore
import quantcore_ref as ref

# ── Hull 9e case (same as Phase 1 gate) ──────────────────────────────────────
S, K, r, sigma, T = 42.0, 40.0, 0.10, 0.20, 0.5
BS_PRICE = quantcore.bs_price(0, S, K, r, sigma, T)   # closed-form reference
CALL_INT = 0

N_RUNS   = 20
N_WARMUP = 3


def banner(s):
    print(f"\n{'═'*66}\n  {s}\n{'═'*66}")


def timeit(fn, n_runs=N_RUNS, n_warmup=N_WARMUP):
    for _ in range(n_warmup):
        fn()
    ts = []
    for _ in range(n_runs):
        t0 = time.perf_counter()
        fn()
        ts.append((time.perf_counter() - t0) * 1e3)  # ms
    return ts


def summarise(ts):
    return statistics.mean(ts), statistics.stdev(ts), statistics.median(ts)


# ─────────────────────────────────────────────────────────────────────────────
# Section 1 — correctness gate
# ─────────────────────────────────────────────────────────────────────────────

def section_correctness():
    banner("1. CORRECTNESS GATE  GPU MC converges to Black-Scholes closed form")
    print(f"  Parameters: S={S} K={K} r={r} σ={sigma} T={T} (Hull 9e call)")
    print(f"  BS closed-form: {BS_PRICE:.6f}\n")

    print(f"  {'Paths':<12} {'GPU Price':>10} {'Std Err':>10} {'Error':>10} {'|Err|/SE':>10}")
    print(f"  {'----------':<12} {'----------':>10} {'----------':>10} {'----------':>10} {'----------':>10}")

    results = {}
    all_ok = True
    for n in [100_000, 1_000_000, 10_000_000]:
        res = quantcore.mc_price_gpu(CALL_INT, S, K, r, sigma, T, n, 42)
        err  = res['price'] - BS_PRICE
        z    = abs(err) / res['std_error'] if res['std_error'] > 0 else float('nan')
        flag = "" if z < 4.0 else "  *** BIAS — check RNG/reduction"
        if z >= 4.0:
            all_ok = False
        print(f"  {n:<12,} {res['price']:>10.5f} {res['std_error']:>10.5f} {err:>+10.5f} {z:>10.2f}{flag}")
        results[n] = res

    # Check error ratio between consecutive rows (should be ~√10 ≈ 3.16)
    errs = [abs(results[n]['price'] - BS_PRICE)
            for n in [100_000, 1_000_000, 10_000_000]]
    r1 = errs[0] / errs[1] if errs[1] > 0 else float('nan')
    r2 = errs[1] / errs[2] if errs[2] > 0 else float('nan')
    print(f"\n  Error reduction ratios (expect ≈3.16 per decade):")
    print(f"    1e5→1e6 : {r1:.2f}×")
    print(f"    1e6→1e7 : {r2:.2f}×")
    print(f"\n  Convergence: {'PASS — no bias detected' if all_ok else 'FAIL — see flagged rows'}")
    return all_ok


# ─────────────────────────────────────────────────────────────────────────────
# Section 2 — benchmark
# ─────────────────────────────────────────────────────────────────────────────

def section_benchmark():
    banner("2. BENCHMARK  GPU end-to-end vs CPU MT vs NumPy (20-run median)")
    dev = quantcore.mc_gpu_device_name()
    cpu_count = os.cpu_count() or "?"
    print(f"  GPU     : {dev}")
    print(f"  CPU     : Apple Silicon, {cpu_count} logical cores")
    print(f"  Timing  : host→GPU write + dispatch + waitUntilCompleted + readback")
    print(f"  Baseline: mc_price_mt (Phase 2b, {cpu_count} threads, vvexp SIMD)")
    print(f"            mc_price_numpy (NumPy PCG64, fully vectorized)\n")

    path_counts = [100_000, 1_000_000, 10_000_000]

    for n in path_counts:
        def gpu_fn():   quantcore.mc_price_gpu(CALL_INT, S, K, r, sigma, T, n, 42)
        def cpu_fn():   quantcore.mc_price_mt (CALL_INT, S, K, r, sigma, T, n, 42)
        def numpy_fn(): ref.mc_price_numpy(S, K, r, sigma, T, n, seed=42, call=True)

        t_gpu   = timeit(gpu_fn)
        t_cpu   = timeit(cpu_fn)
        t_numpy = timeit(numpy_fn)

        mg, sg, medg     = summarise(t_gpu)
        mc_, sc, medc    = summarise(t_cpu)
        mn, sn, medn     = summarise(t_numpy)

        su_vs_cpu   = medc  / medg
        su_vs_numpy = medn  / medg

        print(f"  ── {n:>10,} paths ─────────────────────────────────────")
        print(f"  {'Implementation':<34}  {'mean ms':>8}  {'std ms':>7}  {'median ms':>9}")
        print(f"  {'GPU Metal (full round-trip)':<34}  {mg:>8.2f}  {sg:>7.3f}  {medg:>9.2f}")
        print(f"  {'CPU MT+SIMD (Phase 2b)':<34}  {mc_:>8.2f}  {sc:>7.3f}  {medc:>9.2f}")
        print(f"  {'NumPy vectorized':<34}  {mn:>8.2f}  {sn:>7.3f}  {medn:>9.2f}")
        print(f"  Speedup GPU vs CPU MT (fair)  : {su_vs_cpu:.1f}×")
        print(f"  Speedup GPU vs NumPy   (fair) : {su_vs_numpy:.1f}×")
        print()

    print(f"  Note on small path counts: GPU launch overhead (~1–2 ms) dominates")
    print(f"  at 1e5 paths.  The crossover where GPU wins is visible above.")


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("QuantCore Phase 6 — Metal GPU Monte Carlo gate")
    # Warm up Metal JIT (first call triggers shader compilation, ~100 ms)
    print("  Warming up Metal JIT ...", end=' ', flush=True)
    quantcore.mc_price_gpu(CALL_INT, S, K, r, sigma, T, 1000, 42)
    print("done")

    ok = section_correctness()
    if not ok:
        print("\n  ABORT: correctness gate failed — do not trust benchmark numbers.")
        sys.exit(1)

    section_benchmark()
    banner("End of Phase 6 report — stop for review")
