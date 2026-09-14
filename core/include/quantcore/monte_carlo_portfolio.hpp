#pragma once
#include <cstddef>
#include <cstdint>
#include "quantcore/black_scholes.hpp"
#include "quantcore/monte_carlo.hpp"   // MCResult

namespace quantcore {

/*
 * mc_portfolio
 * ------------
 * Monte Carlo $ value of a European option portfolio under risk-neutral GBM.
 *
 * One Brownian path is observed at every distinct leg expiry, so legs with different
 * maturities stay correlated. Each leg is lognormal at its own volatility on that shared
 * path, S_T = S·exp((r − q − σ²/2)·T + σ·W_T), so its expected payoff is the Black-Scholes
 * value at that volatility — a volatility smile gives each strike its own σ. The standard
 * error is computed on per-path portfolio values (on antithetic pair means when antithetic
 * is on), so it is the real sampling error of the estimate; `paths` in the result counts
 * both draws of each antithetic pair.
 *
 * RNG: std::mt19937_64 + std::normal_distribution, as in mc_price — deterministic for a seed.
 */
/** Legs per portfolio; the kernel is allocation-free and returns NaN for more. */
inline constexpr std::size_t kPortfolioMaxLegs = 64;

struct PortfolioLeg {
    OptionType type;
    double K;
    double T;       // years to expiry; a leg with T ≤ 0 pays its intrinsic value at S
    double sigma;
    double weight;  // signed quantity × contract multiplier
};

MCResult mc_portfolio(const PortfolioLeg* legs, std::size_t n_legs,
                      double S, double r, double q,
                      long long paths, uint64_t seed = 42, bool antithetic = false);

#ifndef __EMSCRIPTEN__
/*
 * mc_portfolio_mt: the same estimator with paths split across std::threads. Thread t draws
 * from seed + t × 0x9e3779b97f4a7c15, so the result is deterministic for a fixed
 * (paths, seed, n_threads) and equals mc_portfolio exactly with n_threads = 1.
 * n_threads = -1 uses hardware_concurrency.
 */
MCResult mc_portfolio_mt(const PortfolioLeg* legs, std::size_t n_legs,
                         double S, double r, double q,
                         long long paths, uint64_t seed = 42, bool antithetic = false,
                         int n_threads = -1);
#endif

} // namespace quantcore
