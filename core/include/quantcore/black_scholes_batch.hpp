#pragma once
#include <cstddef>

namespace quantcore {

/*
 * batch_bs_full_accel
 * --------------------
 * Prices N European options in one batch call.
 *
 * SIMD strategy (Apple Silicon):
 *   log(S/K)       — Apple vForce vvlog   (NEON SIMD internally)
 *   sqrt(T)        — Apple vForce vvsqrt  (NEON SIMD internally)
 *   exp(-rT), φ    — Apple vForce vvexp   (NEON SIMD internally)
 *   N(x)           — Abramowitz-Stegun 26.2.17 polynomial approximation
 *                    (max error 7.5e-8); pure multiply-add, auto-vectorised
 *                    by clang -O3 -march=native to NEON fmla instructions
 *
 * All inputs must be the same length n.
 * out_full is written as a row-major (n × 5) array:
 *   col 0 = price, 1 = delta, 2 = gamma, 3 = theta, 4 = vega
 */
void batch_bs_full_accel(bool is_call,
                          const double* S,
                          const double* K,
                          const double* r,
                          const double* sigma,
                          const double* T,
                          std::size_t   n,
                          double*       out_full);   // (n × 5) row-major

} // namespace quantcore
