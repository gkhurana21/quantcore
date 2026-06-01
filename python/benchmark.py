"""
QuantCore Phase 2 — Benchmark
==============================
Workloads
  (a) BS batch   — 10 000 call options, price + 4 Greeks
  (b) MC single  — 1 000 000 paths, single call option

Timing methodology
  - 3 warmup runs (discarded)
  - 20 timed runs; report mean ± std and median
  - Inputs fixed (seeded RNG) — C++ and Python price identical batches
  - Time measured with time.perf_counter (monotonic, sub-µs resolution)
  - The Python→C++ module-import cost is not included in any timed section

Baselines
  NumPy-vectorized : the fair comparison (natural Python/NumPy implementation)
  Scalar Python    : the unfair comparison (Python for-loop over options);
                     shown separately and labelled as such
"""

import sys, time, statistics
import numpy as np
import quantcore          # C++ module (pybind11)
import quantcore_ref as ref

# ── parameters ────────────────────────────────────────────────────────────────

N_OPTIONS  = 10_000
MC_PATHS   = 1_000_000
N_RUNS     = 20
N_WARMUP   = 3

# Fixed inputs — same arrays used for every C++ and Python timed call
_rng = np.random.default_rng(seed=1)
S     = _rng.uniform(80,  120, N_OPTIONS)
K     = _rng.uniform(80,  120, N_OPTIONS)
r_arr = np.full(N_OPTIONS, 0.05)
sig   = _rng.uniform(0.15, 0.40, N_OPTIONS)
T_arr = _rng.uniform(0.1,  2.0,  N_OPTIONS)

# Single option for MC benchmark (Hull 9e example)
MC_S, MC_K, MC_r, MC_sig, MC_T = 42.0, 40.0, 0.10, 0.20, 0.5

# ── timing helper ─────────────────────────────────────────────────────────────

def timeit(fn, n_runs=N_RUNS, n_warmup=N_WARMUP):
    for _ in range(n_warmup):
        fn()
    times = []
    for _ in range(n_runs):
        t0 = time.perf_counter()
        fn()
        times.append((time.perf_counter() - t0) * 1e3)   # ms
    return times

def summarise(times):
    return statistics.mean(times), statistics.stdev(times), statistics.median(times)

# ── correctness check ─────────────────────────────────────────────────────────

def check_correctness():
    """
    Three checks:
      1. Scalar binding == Phase 1 gate values (printed to 4 d.p.; tolerance 5e-5)
      2. batch_bs_full prices == scalar binding prices (boundary must be lossless)
      3. Scalar binding == Python NumPy reference (same erfc formula; tolerance 1e-10)
    """
    print("── Correctness: bound module vs Phase 1 gate + Python reference ──")

    specs = [
        (0, 42,  40,  0.10, 0.20, 0.5,  4.7594),   # Hull 9e call (gate printed value)
        (1, 42,  40,  0.10, 0.20, 0.5,  0.8086),   # Hull 9e put
        (0, 100, 100, 0.05, 0.25, 1.0, 12.3360),   # ATM 1yr call
    ]

    ok = True

    # Check 1: scalar binding vs Phase 1 gate (4 d.p. → tolerance 5e-5)
    print("\n  Check 1 — scalar binding vs Phase 1 gate values (tol 5e-5)")
    print(f"  {'Type':<4}  {'bound':>12}  {'gate':>8}  {'diff':>10}")
    for type_int, S_, K_, r_, sg_, T_, gate_val in specs:
        v    = quantcore.bs_price(type_int, S_, K_, r_, sg_, T_)
        diff = abs(v - gate_val)
        flag = "" if diff < 5e-5 else "  *** FAIL"
        ok   = ok and (diff < 5e-5)
        label = "Call" if type_int == 0 else "Put"
        print(f"  {label:<4}  {v:>12.6f}  {gate_val:>8.4f}  {diff:>10.2e}{flag}")

    # Check 2: batch prices == scalar prices (exact equality — same code path)
    print("\n  Check 2 — batch_bs_full price column == scalar bs_price (exact)")
    S_chk  = np.array([42., 42., 100.])
    K_chk  = np.array([40., 40., 100.])
    r_chk  = np.array([0.10, 0.10, 0.05])
    sg_chk = np.array([0.20, 0.20, 0.25])
    T_chk  = np.array([0.5,  0.5,  1.0])
    call_flags = [True, False, True]
    for call in [True, False]:
        mask   = np.array(call_flags) == call
        idxs   = np.where(mask)[0]
        if len(idxs) == 0:
            continue
        batch  = quantcore.batch_bs_full(call, S_chk[mask], K_chk[mask],
                                          r_chk[mask], sg_chk[mask], T_chk[mask])
        for j, i in enumerate(idxs):
            sc    = quantcore.bs_price(int(not call), S_chk[i], K_chk[i],
                                        r_chk[i], sg_chk[i], T_chk[i])
            # scalar used correct type_int
            sc2   = quantcore.bs_price(0 if call else 1, S_chk[i], K_chk[i],
                                        r_chk[i], sg_chk[i], T_chk[i])
            diff  = abs(batch[j, 0] - sc2)
            flag  = "" if diff == 0.0 else f"  *** FAIL (diff {diff:.2e})"
            label = "Call" if call else "Put"
            print(f"  [{label} i={i}]  batch={batch[j,0]:.8f}  scalar={sc2:.8f}  diff={diff:.2e}{flag}")
            ok = ok and (diff == 0.0)

    # Check 3: scalar binding == Python NumPy ref (tol 1e-10; same erfc formula)
    print("\n  Check 3 — scalar binding vs Python NumPy reference (tol 1e-10)")
    for type_int, S_, K_, r_, sg_, T_, _ in specs:
        call   = (type_int == 0)
        v_cpp  = quantcore.bs_price(type_int, S_, K_, r_, sg_, T_)
        v_py   = float(ref.bs_price_numpy(S_, K_, r_, sg_, T_, call=call))
        diff   = abs(v_cpp - v_py)
        flag   = "" if diff < 1e-10 else "  *** FAIL"
        ok     = ok and (diff < 1e-10)
        label  = "Call" if call else "Put"
        print(f"  {label:<4}  cpp={v_cpp:.10f}  py={v_py:.10f}  diff={diff:.2e}{flag}")

    print(f"\n  Overall correctness: {'PASS' if ok else 'FAIL'}\n")
    return ok

# ── workload (a): BS batch ────────────────────────────────────────────────────

def bench_bs_batch():
    print("── Workload (a): BS batch — 10 000 calls, price + 4 Greeks ──")
    print(f"  Runs: {N_WARMUP} warmup + {N_RUNS} timed\n")

    # --- C++ batch (single boundary crossing) ---
    def cpp_fn():
        quantcore.batch_bs_full(True, S, K, r_arr, sig, T_arr)

    # --- NumPy vectorized (fair baseline) ---
    def numpy_fn():
        ref.bs_full_numpy(S, K, r_arr, sig, T_arr, call=True)

    # --- Scalar Python (unfair baseline) ---
    def scalar_fn():
        for i in range(N_OPTIONS):
            ref.bs_price_scalar(S[i], K[i], r_arr[i], sig[i], T_arr[i], call=True)

    t_cpp    = timeit(cpp_fn)
    t_numpy  = timeit(numpy_fn)
    t_scalar = timeit(scalar_fn)

    m_cpp,   s_cpp,   med_cpp   = summarise(t_cpp)
    m_numpy, s_numpy, med_numpy = summarise(t_numpy)
    m_scal,  s_scal,  med_scal  = summarise(t_scalar)

    speedup_fair   = med_numpy  / med_cpp
    speedup_unfair = med_scal   / med_cpp

    print(f"  {'Implementation':<30}  {'mean ms':>8}  {'std ms':>7}  {'median ms':>9}")
    print(f"  {'C++ pybind11 batch_bs_full':<30}  {m_cpp:>8.3f}  {s_cpp:>7.4f}  {med_cpp:>9.3f}")
    print(f"  {'Python NumPy vectorized':<30}  {m_numpy:>8.3f}  {s_numpy:>7.4f}  {med_numpy:>9.3f}")
    print(f"  {'Python scalar for-loop':<30}  {m_scal:>8.1f}  {s_scal:>7.2f}  {med_scal:>9.1f}")
    print()
    print(f"  Speedup C++ vs NumPy-vectorized (FAIR)  : {speedup_fair:.1f}x")
    print(f"  Speedup C++ vs scalar Python    (UNFAIR) : {speedup_unfair:.0f}x")
    print()

    return speedup_fair, speedup_unfair

# ── workload (b): Monte Carlo ─────────────────────────────────────────────────

def bench_mc():
    print("── Workload (b): Monte Carlo — 1 000 000 paths, single call ──")
    print(f"  Runs: {N_WARMUP} warmup + {N_RUNS} timed\n")
    print("  Python MC baseline: NumPy-vectorized paths")
    print("    — np.random.default_rng (PCG64) generates all Z at once,")
    print("      payoff via np.maximum, no Python loop over paths.\n")

    def cpp_fn():
        quantcore.mc_price(0, MC_S, MC_K, MC_r, MC_sig, MC_T, MC_PATHS, 42)

    def numpy_fn():
        ref.mc_price_numpy(MC_S, MC_K, MC_r, MC_sig, MC_T, MC_PATHS, seed=42, call=True)

    t_cpp   = timeit(cpp_fn)
    t_numpy = timeit(numpy_fn)

    m_cpp,   s_cpp,   med_cpp   = summarise(t_cpp)
    m_numpy, s_numpy, med_numpy = summarise(t_numpy)

    speedup = med_numpy / med_cpp

    print(f"  {'Implementation':<35}  {'mean ms':>8}  {'std ms':>7}  {'median ms':>9}")
    print(f"  {'C++ pybind11 mc_price':<35}  {m_cpp:>8.2f}  {s_cpp:>7.3f}  {med_cpp:>9.2f}")
    print(f"  {'Python NumPy vectorized mc':<35}  {m_numpy:>8.2f}  {s_numpy:>7.3f}  {med_numpy:>9.2f}")
    print()
    print(f"  Speedup C++ vs NumPy-vectorized (FAIR): {speedup:.1f}x")
    print()

    return speedup

# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("QuantCore Phase 2 — Benchmark Report")
    print(f"Python {sys.version.split()[0]}, NumPy {np.__version__}")
    print(f"Inputs: N_OPTIONS={N_OPTIONS}, MC_PATHS={MC_PATHS:,}, N_RUNS={N_RUNS}\n")

    ok = check_correctness()
    if not ok:
        print("ABORT: correctness check failed — do not trust benchmark numbers.")
        sys.exit(1)

    su_bs_fair, su_bs_unfair = bench_bs_batch()
    su_mc = bench_mc()

    print("── Summary ──")
    print(f"  BS batch  speedup vs NumPy-vectorized  : {su_bs_fair:.1f}x  (fair)")
    print(f"  BS batch  speedup vs scalar Python      : {su_bs_unfair:.0f}x  (unfair — scalar baseline)")
    print(f"  MC single speedup vs NumPy-vectorized  : {su_mc:.1f}x  (fair)")
    print()
    print("  The 'fair' numbers are the honest comparison for the resume.")
    print("  The scalar number shows C++ advantage in a Python-loop context.")
