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

/**
 * The exercise policy pass 1 produces: at date k a path exercises when it is in the money and its intrinsic value is at
 * least the fitted continuation β(k)·(1, x, x², x³) with x = S/K. `rule[k]` is false where the regression was dropped
 * (too few in-the-money paths, or not positive definite), which means "never exercise at that date". Exposed so the
 * dual upper bound can replay exactly the policy the lower bound was valued under.
 */
struct LsmPolicy {
    OptionType type = OptionType::Put;
    double     K = 0.0, T = 0.0;
    int        dates = 0;
    double     beta[512 * 4] = {};
    bool       rule[512] = {};
};

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

/**
 * As lsm_american, and `out_policy` receives the fitted exercise policy — what the dual upper bound replays. Left
 * untouched when the result is invalid.
 */
LsmResult lsm_american_policy(OptionType type, double K, double T, const VolSurface& s, long long policy_paths,
                              long long value_paths, uint64_t seed, int dates, double steps_per_year,
                              LsmPolicy* out_policy);

/*
 * Andersen–Broadie dual upper bound for the policy above.
 *
 * Any exercise policy defines a martingale M with M₀ = 0, and for every such martingale
 *   V ≤ E[ maxₖ (hₖ − Mₖ) ],
 * so the right-hand side is an upper bound on the American value — high biased, where the
 * Longstaff–Schwartz price is low biased. Taking M from the policy's own value process makes the
 * bound tight: the gap closes as the policy approaches optimal.
 *
 * Along each outer path the increment at date k is
 *   ΔMₖ = Qₖ(Sₖ) − E[ Qₖ | S_{k−1} ],
 * with Q the discounted value of restarting the policy from that state. Q is a function of the state
 * alone, so it is defined at every date whether or not the path has already exercised, and the maximum
 * runs over all of them: stopping the scan at the path's own exercise date truncates it, and freezing
 * the exercised cash there leaves a stale martingale for later payoffs to be measured against.
 *
 * Where the restarted policy stops, Q is the intrinsic value and costs no inner simulation. Where it
 * continues, one inner simulation serves both as Qₖ and as E[ Qₖ₊₁ | Sₖ ] — the same quantity — so that
 * draw's sampling noise telescopes out of the two increments it appears in; an exercise date has no such
 * estimate to reuse and pays for one. Cost is about outer × dates × inner paths, far heavier than the
 * lower bound; `inner_paths` in the low hundreds is usual. What remains of the inner noise biases the
 * bound upwards, and that bias falls as 1/√inner_paths.
 *
 * The bound is on the Bermudan the policy exercises — `dates` equally spaced dates — which is worth less
 * than the continuously exercisable American value the PDE solver returns.
 */
struct LsmDualResult {
    double    upper = 0.0, std_error = 0.0;    // high-biased estimate, per unit of underlying
    long long outer_paths = 0, inner_paths = 0;
    int       dates = 0;
    long long inner_sims = 0;                  // inner simulations actually run (exercise dates need none)
};

/** NaN on invalid input. `policy` must come from lsm_american_policy on the same option and surface. */
LsmDualResult lsm_dual_bound(const LsmPolicy& policy, const VolSurface& s, long long outer_paths,
                             long long inner_paths, uint64_t seed, double steps_per_year);

} // namespace quantcore
