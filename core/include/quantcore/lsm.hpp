#pragma once
#include <cstddef>
#include <cstdint>
#include "quantcore/black_scholes.hpp"
#include "quantcore/local_vol.hpp"

namespace quantcore {

/*
 * Longstaff–Schwartz Monte Carlo for American options under the surface's local volatility — an independent check on
 * the finite-difference solver (core/src/pde.cpp), sharing only the diffusion with it.
 *
 * Pass 1 (policy): `policy_paths` paths recorded at `dates` equally spaced exercise dates. Backward induction: at each
 * date the discounted continuation value is regressed on 1, x, x², x³ (x = S/K) across the in-the-money paths, and a
 * path exercises where its intrinsic value is at least the fitted continuation. A date with fewer than 32 in-the-money
 * paths, or a regression that is not positive definite, simply carries no exercise rule; each regression is solved as
 * normal equations by Cholesky with a small ridge.
 *
 * Pass 2 (valuation): fresh paths from a different seed are walked forward and exercised by the stored policy. The
 * policy never saw these paths, so the estimate is low-biased — a suboptimal policy is still a policy — which is what
 * makes it a fair check on the PDE: it must not exceed the PDE by more than Monte Carlo error, and it falls short of it
 * only by the exercise dates being discrete and by the simulation's own discretisation. The same paths held to expiry
 * give the European value, so the difference is the early-exercise premium.
 */

inline constexpr int kLsmMaxDates = 512;
/** Recorded path cells (policy paths × dates) one run may allocate: 64 MB, well over the WebAssembly heap. */
inline constexpr long long kLsmMaxCells = 8'000'000;
inline constexpr int kLsmBasis = 4;

struct LsmResult {
    double    price = 0.0, std_error = 0.0;        // valuation pass, per unit of underlying (low biased)
    double    policy_price = 0.0;                  // in-sample backward induction (high biased)
    double    european = 0.0, european_se = 0.0;   // the same valuation paths held to expiry
    long long policy_paths = 0, value_paths = 0;
    int       dates = 0;
    long long steps = 0;                           // simulation time steps per path
    int       exercise_dates = 0;                  // dates whose regression produced an exercise rule
};

/** NaN values on invalid input (including policy_paths × dates over kLsmMaxCells) or allocation failure. */
LsmResult lsm_american(OptionType type, double K, double T, const VolSurface& s, long long policy_paths,
                       long long value_paths, uint64_t seed, int dates, double steps_per_year);

} // namespace quantcore
