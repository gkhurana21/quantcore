#pragma once
#include <cstddef>
#include <cstdint>
#include "quantcore/black_scholes.hpp"
#include "quantcore/local_vol.hpp"

namespace quantcore {

/*
 * Path-dependent options: closed forms under flat volatility, and Monte Carlo under any volatility surface —
 * dashboard/lib/quant/exotics.ts in C++, plus the simulation.
 *
 * Barriers are monitored continuously. Between two simulated log prices x₀, x₁ with step variance v, a Brownian
 * bridge touches the log barrier h with probability exp(−2(x₀ − h)(x₁ − h)/v); the estimator multiplies the path's
 * survival probability by one minus that at every step instead of sampling the touch. The weight is exact for GBM
 * and for a time-only local volatility (v is the step's integrated variance), and uses σ_loc at the step's start
 * with a smile. Knock-in values are vanilla − knock-out on each path, so in-out parity holds exactly.
 *
 * Asian options average S on n equally spaced fixings T·i/n; the fixings are time-grid points. The geometric average
 * is computed on the same paths: under GBM its closed form makes it a control variate for the arithmetic average.
 */

struct BarrierPrices { double out, in, vanilla; };

/** Continuously monitored barrier option without rebate (Reiner & Rubinstein). `up`: the barrier is above spot. */
BarrierPrices barrier_prices(OptionType type, bool up, double S, double K, double H, double T,
                             double sigma, double r, double q);

/** Geometric-average Asian option on n equally spaced fixings, flat volatility. */
double geometric_asian_price(OptionType type, double S, double K, double T, int n_fixings,
                             double sigma, double r, double q);

inline constexpr std::size_t kMaxBarrierLevels = 16;
inline constexpr std::size_t kMaxAsianFixings = 2000;

enum class ExoticKind : int { Barrier = 0, Asian = 1 };

struct ExoticSpec {
    ExoticKind kind = ExoticKind::Barrier;
    OptionType type = OptionType::Call;
    double K = 0.0;
    double T = 0.0;
    bool   up = false;                          // barrier: above spot
    int    n_levels = 0;                        // barrier: levels priced on the same paths
    double levels[kMaxBarrierLevels] = {};
    int    n_fixings = 0;                       // asian
};

/** Discounted values per unit of underlying. fine_bias entries are coarse − fine when extrapolating, else NaN. */
struct ExoticResult {
    long long paths = 0;
    long long steps = 0;
    double vanilla = 0.0, vanilla_se = 0.0, vanilla_fine_bias = 0.0;
    int    n_levels = 0;
    double out[kMaxBarrierLevels] = {}, out_se[kMaxBarrierLevels] = {}, out_fine_bias[kMaxBarrierLevels] = {};
    double in[kMaxBarrierLevels] = {}, in_se[kMaxBarrierLevels] = {};
    double arith = 0.0, arith_se = 0.0, arith_fine_bias = 0.0;
    double geo = 0.0, geo_se = 0.0;
    double arith_geo_cov = 0.0;                 // covariance of the per-path arithmetic and geometric values
};

/*
 * mc_exotic: the option under the surface's local volatility — log-Euler steps of at most 1/steps_per_year landing
 * on the expiry and every fixing, with coupled Richardson extrapolation when `extrapolate` and the surface has a
 * smile (exact variance steps otherwise). RNG as mc_local_vol. NaN values on invalid input.
 */
ExoticResult mc_exotic(const ExoticSpec& e, const VolSurface& s, long long paths, uint64_t seed,
                       double steps_per_year, bool extrapolate);

#ifndef __EMSCRIPTEN__
/** mc_exotic across std::threads (seed + t × 0x9e3779b97f4a7c15); one thread equals mc_exotic exactly. */
ExoticResult mc_exotic_mt(const ExoticSpec& e, const VolSurface& s, long long paths, uint64_t seed,
                          double steps_per_year, bool extrapolate, int n_threads = -1);
#endif

} // namespace quantcore
