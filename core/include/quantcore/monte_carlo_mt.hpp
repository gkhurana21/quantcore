#pragma once
#include <cstdint>
#include "quantcore/monte_carlo.hpp"   // reuses MCResult

namespace quantcore {

/*
 * mc_price_mt
 * -----------
 * Monte Carlo price via GBM, multithreaded + SIMD.
 *
 * Threading:
 *   Paths partitioned across n_threads std::threads (embarrassingly parallel).
 *   n_threads = -1  →  std::thread::hardware_concurrency()
 *   NumPy mc baseline is single-threaded, so this is where the gap opens.
 *
 * SIMD within each thread:
 *   GBM step  ST = S·exp(drift + σ√T·Z)  uses Apple vForce vvexp on chunks
 *   of CHUNK=4096 paths at a time — NEON 128-bit SIMD for exp() calls.
 *
 * Determinism:
 *   Per-thread seed = base_seed + t × 0x9e3779b97f4a7c15  (golden-ratio LCG).
 *   Result is deterministic for fixed (paths, seed, n_threads).
 *   DIFFERS from mc_price(same seed) — different RNG streams — but both
 *   converge to the same Black-Scholes price.
 *
 * RNG: std::mt19937_64 per thread (same family as scalar mc_price).
 */
MCResult mc_price_mt(OptionType type,
                     double    S,
                     double    K,
                     double    r,
                     double    sigma,
                     double    T,
                     long long paths,
                     uint64_t  seed      = 42,
                     int       n_threads = -1);

} // namespace quantcore
