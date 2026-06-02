#pragma once
#include <string>
#include "quantcore/monte_carlo.hpp"

namespace quantcore {

/*
 * mc_price_gpu
 * ------------
 * Apple Metal GPU Monte Carlo pricer (GBM, European options).
 *
 * RNG: Philox 4x32-10 counter-based PRNG (Salmon et al. 2011).
 *   Each GPU thread uses its global thread id as the Philox counter, with
 *   the caller-supplied seed as the key.  This guarantees statistically
 *   independent, uncorrelated streams between all threads — a property that
 *   sequential PRNGs like mt19937 do NOT provide when naively split across
 *   GPU threads.  The counter-based approach is the standard solution:
 *   independence is a mathematical consequence of the bijection property of
 *   Philox, not an assumption.
 *
 * One path per GPU thread.  Two Philox outputs → Box-Muller → one N(0,1).
 *
 * Reduction: two-stage.
 *   Stage 1 (GPU): parallel threadgroup reduction (256 threads/group).
 *                  Each group writes one partial sum + partial sum-of-squares.
 *   Stage 2 (CPU): host reduces the (typically ≤40k) partial sums in double,
 *                  avoiding float32 accumulation error on the final mean.
 *
 * Timing note: mc_price_gpu times the FULL round-trip —
 *   host param write → Metal command encoding → GPU dispatch → waitUntilCompleted
 *   → host readback reduction.  Transfer overhead is included by design.
 *
 * Precision: GPU kernel uses float32 (Metal default).  The per-path float32
 *   systematic error (~1e-7) is negligible vs MC statistical noise at any
 *   practical path count, and the host-side reduction accumulates in double.
 *
 * Thread safety: Metal device/queue/PSO initialised once via dispatch_once.
 */
MCResult mc_price_gpu(OptionType type,
                      double     S,
                      double     K,
                      double     r,
                      double     sigma,
                      double     T,
                      long long  paths,
                      uint64_t   seed = 42);

// Returns the MTLDevice name, e.g. "Apple M4 Pro".
// Triggers lazy Metal initialisation.
std::string mc_gpu_device_name();

} // namespace quantcore
