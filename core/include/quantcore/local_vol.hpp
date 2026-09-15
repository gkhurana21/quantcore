#pragma once
#include <cstddef>
#include <cstdint>
#include "quantcore/monte_carlo_portfolio.hpp"   // PortfolioLeg, kPortfolioMaxLegs

namespace quantcore {

/*
 * Arbitrage-free SSVI volatility surface and the Dupire local volatility it implies — the model
 * in dashboard/lib/quant/volSurface.ts and localVol.ts, formula for formula, so the browser, the
 * WebAssembly build and the native engine price the same surface.
 *
 *   ATM total variance   θ(T) = σ²·W(T)       (σ²·T without a term structure)
 *     curve              W(T) = T₃₀·A(T)/A(T₃₀),  A(T) = T + (r² − 1)(1 − e^{−κT})/κ,  κ = ln 2 / half-life
 *     fitted             W linear in T between listed expiries, constant volatility outside
 *   SSVI smile           w(k, θ) = θ/2·(1 + ρφk + √((φk + ρ)² + 1 − ρ²)),  φ(θ) = η/(θ^γ (1 + θ)^(1−γ))
 *   local variance       σ_loc² = ∂T w(k, T) / g(k),  ∂T w = ∂θ w·θ′(T)   (Gatheral; g is Durrleman's)
 *
 * k = ln(K/F) is measured from the forward of the spot the smile is centred on; Durrleman's g uses the
 * moneyness against the underlying's own forward, so sticky-strike scenario surfaces stay consistent.
 */

inline constexpr std::size_t kMaxTermPillars = 32;
/** Coarse time steps per simulation (27 years of daily steps); longer grids are rejected (NaN) to bound memory. */
inline constexpr std::size_t kMaxLocalVolSteps = 10000;

enum class TermKind : int { Flat = 0, Curve = 1, Fitted = 2 };

struct VolSurface {
    double S = 0.0, r = 0.0, q = 0.0;
    double sigma = 0.0;              // ATM volatility; the 30-day ATM volatility with a term structure
    bool   smile = false;
    double rho = 0.0, eta = 0.0, gamma = 0.0;
    double smile_spot = 0.0;         // spot the smile is centred on; ≤ 0 means S
    TermKind term = TermKind::Flat;
    double ratio = 1.0, half_life = 1.0;              // curve: short-end ÷ long-run vol, years
    int    n_pillars = 0;                             // fitted
    double pillar_T[kMaxTermPillars] = {};
    double pillar_w[kMaxTermPillars] = {};
};

/** θ(T): ATM total variance at maturity T. */
double atm_variance(const VolSurface& s, double T);

/** Implied volatility of strike K at expiry T (legSigma in the browser); σ when the surface is flat. */
double implied_vol(const VolSurface& s, double K, double T);

/** Dupire local volatility at spot S and time t (localVol in the browser); σ when the surface is flat. */
double local_vol(const VolSurface& s, double spot, double t);

/** σ_loc² at time t for n log spots — the simulation's own evaluation, capped at 500% volatility; σ² when flat. */
void local_variance_row(const VolSurface& s, double t, const double* log_spots, std::size_t n, double* out);

/** Whether the surface's parameters are usable (positive S and σ, the SSVI region, a valid term structure). */
bool vol_surface_valid(const VolSurface& s);

struct LocalVolResult {
    double    price;      // $ value of the portfolio
    double    std_error;
    long long paths;
    long long steps;      // time steps per path — the fine grid when extrapolating
    double    fine_bias;  // coarse − fine mean when extrapolating (the fine grid's own bias); NaN otherwise
};

/*
 * mc_local_vol
 * ------------
 * Monte Carlo $ value of a European portfolio under the surface's local volatility. Leg `sigma` fields are
 * ignored: every leg is read off the one simulated diffusion. Log-Euler steps of at most 1/steps_per_year,
 * landing on every expiry, with σ_loc read at the step's start price and mid-time. Without a smile the local
 * volatility depends on time only and each step's variance is integrated exactly (no discretisation bias).
 *
 * extrapolate: coupled Richardson extrapolation — each path also runs on the grid with every step halved,
 * driven by the same Brownian increments, and the estimator is 2·V_fine − V_coarse per path, cancelling the
 * O(Δt) weak error at a nearly unchanged standard error.
 *
 * RNG: std::mt19937_64 with ziggurat normals (quantcore/ziggurat.hpp), deterministic for a seed and identical in the
 * native and WebAssembly builds. Returns NaN price for more than
 * kPortfolioMaxLegs legs, more than kMaxLocalVolSteps coarse steps, or an invalid surface.
 */
LocalVolResult mc_local_vol(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s,
                            long long paths, uint64_t seed, double steps_per_year, bool extrapolate);

#ifndef __EMSCRIPTEN__
/*
 * mc_local_vol_mt: paths split across std::threads; thread t draws from seed + t × 0x9e3779b97f4a7c15, so the
 * result is deterministic for (paths, seed, n_threads) and equals mc_local_vol exactly with n_threads = 1.
 */
LocalVolResult mc_local_vol_mt(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s,
                               long long paths, uint64_t seed, double steps_per_year, bool extrapolate,
                               int n_threads = -1);
#endif

} // namespace quantcore
