// WebAssembly entry points for the C++ pricing core.
//
// Built by scripts/build-wasm.sh from the same core/src sources as the native library
// (black_scholes.cpp, monte_carlo.cpp, monte_carlo_portfolio.cpp, local_vol.cpp) into a
// standalone .wasm with no JavaScript glue. Each call writes its results to a fixed output
// buffer that the caller reads through qc_out(). Inputs are validated by the TypeScript loader
// (dashboard/lib/engine/wasm.ts), which never passes non-positive S, K, sigma or T.

#include <cstdint>
#include <emscripten/emscripten.h>

#include "quantcore/black_scholes.hpp"
#include "quantcore/exotics.hpp"
#include "quantcore/local_vol.hpp"
#include "quantcore/monte_carlo.hpp"
#include "quantcore/lsm.hpp"
#include "quantcore/pde.hpp"
#include "quantcore/monte_carlo_portfolio.hpp"

using quantcore::OptionType;

namespace {
constexpr int kMaxLegs = static_cast<int>(quantcore::kPortfolioMaxLegs);
constexpr int kPillars = static_cast<int>(quantcore::kMaxTermPillars);
constexpr int kSurfaceSize = 13 + 2 * kPillars;
double g_out[8];
double g_legs[kMaxLegs * 5];   // portfolio input: [call (0/1), K, T, sigma, weight] per leg
// surface input: S, r, q, sigma, smile (0/1), rho, eta, gamma, smile_spot, term (0 flat, 1 curve, 2 fitted),
// ratio, half_life, n_pillars, pillar T × 32, pillar w × 32
double g_surface[kSurfaceSize];
constexpr int kLevels = static_cast<int>(quantcore::kMaxBarrierLevels);
constexpr int kMonitors = static_cast<int>(quantcore::kMaxBarrierMonitors);
// exotic input: kind (0 barrier, 1 asian), call (0/1), K, T, up (0/1), n_levels, levels × 16, n_fixings, n_monitors,
// rebate, rebate_at_hit (0/1)
constexpr int kExoticSpecSize = 10 + kLevels;
double g_exotic_spec[kExoticSpecSize];
// exotic output: paths, steps, vanilla, vanilla_se, vanilla_fine_bias, n_levels, out × 16, out_se × 16,
// out_fine_bias × 16, in × 16, in_se × 16, arith, arith_se, arith_fine_bias, geo, geo_se, arith_geo_cov, n_monitors
constexpr int kExoticOutSize = 6 + 5 * kLevels + 7;
double g_exotic_out[kExoticOutSize];
constexpr int kPdePoints = static_cast<int>(quantcore::kPdeBoundaryPoints);
// PDE output: price, delta, gamma, theta, nodes, steps, n_boundary, boundary_tau × 64, boundary_S × 64, vega
// (appended, so the existing offsets do not move)
constexpr int kPdeOutSize = 7 + 2 * kPdePoints + 1;
double g_pde_out[kPdeOutSize];
// Longstaff–Schwartz output: price, std_error, policy_price, european, european_se, policy_paths, value_paths,
// dates, steps, exercise_dates
constexpr int kLsmOutSize = 10;
double g_lsm_out[kLsmOutSize];

quantcore::VolSurface read_surface() {
    const double* v = g_surface;
    quantcore::VolSurface s;
    s.S = v[0]; s.r = v[1]; s.q = v[2]; s.sigma = v[3];
    s.smile = v[4] != 0.0;
    s.rho = v[5]; s.eta = v[6]; s.gamma = v[7];
    s.smile_spot = v[8];
    const int kind = static_cast<int>(v[9]);
    s.term = kind == 1 ? quantcore::TermKind::Curve : kind == 2 ? quantcore::TermKind::Fitted : quantcore::TermKind::Flat;
    s.ratio = v[10]; s.half_life = v[11];
    const int n = static_cast<int>(v[12]);
    s.n_pillars = n < 0 ? 0 : (n > kPillars ? kPillars + 1 : n);   // more than 32 fails validation
    for (int i = 0; i < kPillars; ++i) {
        s.pillar_T[i] = v[13 + i];
        s.pillar_w[i] = v[13 + kPillars + i];
    }
    return s;
}
}

extern "C" {

// Bumped whenever a signature or the output layout changes.
EMSCRIPTEN_KEEPALIVE int qc_abi_version() { return 10; }

EMSCRIPTEN_KEEPALIVE double* qc_out() { return g_out; }

// out: price, delta, gamma, theta (per year), vega (per 1.00 of sigma)
EMSCRIPTEN_KEEPALIVE void qc_bs_full(int call, double S, double K, double r, double sigma, double T, double q) {
    const quantcore::BSMResult res =
        quantcore::bsm_full(call ? OptionType::Call : OptionType::Put, S, K, r, sigma, T, q);
    g_out[0] = res.price;
    g_out[1] = res.greeks.delta;
    g_out[2] = res.greeks.gamma;
    g_out[3] = res.greeks.theta;
    g_out[4] = res.greeks.vega;
}

// out: price, std_error, paths. paths and seed arrive as doubles (exact integers below 2^53).
EMSCRIPTEN_KEEPALIVE void qc_mc_price(int call, double S, double K, double r, double sigma, double T,
                                      double paths, double seed, double q) {
    const quantcore::MCResult res =
        quantcore::mc_price(call ? OptionType::Call : OptionType::Put, S, K, r, sigma, T,
                            static_cast<long long>(paths), static_cast<uint64_t>(seed), q);
    g_out[0] = res.price;
    g_out[1] = res.std_error;
    g_out[2] = static_cast<double>(res.paths);
}

EMSCRIPTEN_KEEPALIVE double* qc_legs() { return g_legs; }
EMSCRIPTEN_KEEPALIVE int qc_max_legs() { return kMaxLegs; }

// Portfolio Monte Carlo over the first n legs written to qc_legs(). out: price, std_error, paths.
EMSCRIPTEN_KEEPALIVE void qc_mc_portfolio(int n, double S, double r, double q,
                                          double paths, double seed, int antithetic) {
    n = n < 0 ? 0 : (n > kMaxLegs ? kMaxLegs : n);
    quantcore::PortfolioLeg legs[kMaxLegs];
    for (int i = 0; i < n; ++i) {
        const double* row = g_legs + 5 * i;
        legs[i] = quantcore::PortfolioLeg{row[0] != 0.0 ? OptionType::Call : OptionType::Put,
                                          row[1], row[2], row[3], row[4]};
    }
    const quantcore::MCResult res =
        quantcore::mc_portfolio(legs, static_cast<std::size_t>(n), S, r, q,
                                static_cast<long long>(paths), static_cast<uint64_t>(seed), antithetic != 0);
    g_out[0] = res.price;
    g_out[1] = res.std_error;
    g_out[2] = static_cast<double>(res.paths);
}

EMSCRIPTEN_KEEPALIVE double* qc_surface() { return g_surface; }
EMSCRIPTEN_KEEPALIVE int qc_surface_size() { return kSurfaceSize; }

// Implied and Dupire local volatility on the surface written to qc_surface().
EMSCRIPTEN_KEEPALIVE double qc_implied_vol(double K, double T) { return quantcore::implied_vol(read_surface(), K, T); }
EMSCRIPTEN_KEEPALIVE double qc_local_vol(double spot, double t) { return quantcore::local_vol(read_surface(), spot, t); }

// Local-volatility Monte Carlo over the first n legs of qc_legs() (sigma ignored) on the surface in qc_surface().
// out: price, std_error, paths, steps, fine_bias (NaN without extrapolation).
EMSCRIPTEN_KEEPALIVE void qc_mc_local_vol(int n, double paths, double seed, double steps_per_year, int extrapolate) {
    n = n < 0 ? 0 : (n > kMaxLegs ? kMaxLegs : n);
    quantcore::PortfolioLeg legs[kMaxLegs];
    for (int i = 0; i < n; ++i) {
        const double* row = g_legs + 5 * i;
        legs[i] = quantcore::PortfolioLeg{row[0] != 0.0 ? OptionType::Call : OptionType::Put,
                                          row[1], row[2], row[3], row[4]};
    }
    const quantcore::LocalVolResult res =
        quantcore::mc_local_vol(legs, static_cast<std::size_t>(n), read_surface(), static_cast<long long>(paths),
                                static_cast<uint64_t>(seed), steps_per_year, extrapolate != 0);
    g_out[0] = res.price;
    g_out[1] = res.std_error;
    g_out[2] = static_cast<double>(res.paths);
    g_out[3] = static_cast<double>(res.steps);
    g_out[4] = res.fine_bias;
}

EMSCRIPTEN_KEEPALIVE double* qc_exotic_spec() { return g_exotic_spec; }
EMSCRIPTEN_KEEPALIVE int qc_exotic_spec_size() { return kExoticSpecSize; }
EMSCRIPTEN_KEEPALIVE double* qc_exotic_out() { return g_exotic_out; }
EMSCRIPTEN_KEEPALIVE int qc_exotic_out_size() { return kExoticOutSize; }

// out: knock-out, knock-in, vanilla
EMSCRIPTEN_KEEPALIVE void qc_barrier_prices(int call, int up, double S, double K, double H, double T,
                                            double sigma, double r, double q) {
    const quantcore::BarrierPrices p =
        quantcore::barrier_prices(call ? OptionType::Call : OptionType::Put, up != 0, S, K, H, T, sigma, r, q);
    g_out[0] = p.out;
    g_out[1] = p.in;
    g_out[2] = p.vanilla;
}

// out: knock-out, knock-in, vanilla — monitored at n_monitors equally spaced dates by the Broadie-Glasserman-Kou
// correction; n_monitors < 1 prices continuous monitoring.
EMSCRIPTEN_KEEPALIVE void qc_barrier_prices_discrete(int call, int up, double S, double K, double H, double T,
                                                     double sigma, double r, double q, int n_monitors) {
    const quantcore::BarrierPrices p =
        quantcore::barrier_prices_discrete(call ? OptionType::Call : OptionType::Put, up != 0, S, K, H, T, sigma, r, q,
                                           n_monitors);
    g_out[0] = p.out;
    g_out[1] = p.in;
    g_out[2] = p.vanilla;
}

// out: knock-out, knock-in, vanilla — the knock-out pays `rebate` on hitting the barrier when at_hit, otherwise at
// expiry, and the knock-in pays it at expiry when the barrier is never touched (Reiner-Rubinstein E and F).
EMSCRIPTEN_KEEPALIVE void qc_barrier_prices_rebate(int call, int up, double S, double K, double H, double T,
                                                   double sigma, double r, double q, double rebate, int at_hit) {
    const quantcore::BarrierPrices p =
        quantcore::barrier_prices_rebate(call ? OptionType::Call : OptionType::Put, up != 0, S, K, H, T, sigma, r, q,
                                         rebate, at_hit != 0);
    g_out[0] = p.out;
    g_out[1] = p.in;
    g_out[2] = p.vanilla;
}

EMSCRIPTEN_KEEPALIVE double qc_geometric_asian(int call, double S, double K, double T, int n, double sigma, double r, double q) {
    return quantcore::geometric_asian_price(call ? OptionType::Call : OptionType::Put, S, K, T, n, sigma, r, q);
}

// The exotic in qc_exotic_spec() on the surface in qc_surface(); results in qc_exotic_out().
EMSCRIPTEN_KEEPALIVE void qc_mc_exotic(double paths, double seed, double steps_per_year, int extrapolate) {
    const double* v = g_exotic_spec;
    quantcore::ExoticSpec e;
    e.kind = v[0] == 1.0 ? quantcore::ExoticKind::Asian : quantcore::ExoticKind::Barrier;
    e.type = v[1] != 0.0 ? OptionType::Call : OptionType::Put;
    e.K = v[2];
    e.T = v[3];
    e.up = v[4] != 0.0;
    const int n_levels = static_cast<int>(v[5]);
    e.n_levels = n_levels < 0 ? 0 : (n_levels > kLevels ? kLevels + 1 : n_levels);   // more than 16 fails validation
    for (int j = 0; j < kLevels; ++j) e.levels[j] = v[6 + j];
    e.n_fixings = static_cast<int>(v[6 + kLevels]);
    const int n_monitors = static_cast<int>(v[7 + kLevels]);
    e.n_monitors = n_monitors < 0 ? -1 : (n_monitors > kMonitors ? kMonitors + 1 : n_monitors);   // out of range fails validation
    e.rebate = v[8 + kLevels];                    // negative or not finite fails validation
    e.rebate_at_hit = v[9 + kLevels] != 0.0;
    const quantcore::ExoticResult r =
        quantcore::mc_exotic(e, read_surface(), static_cast<long long>(paths), static_cast<uint64_t>(seed), steps_per_year, extrapolate != 0);
    double* o = g_exotic_out;
    o[0] = static_cast<double>(r.paths);
    o[1] = static_cast<double>(r.steps);
    o[2] = r.vanilla;
    o[3] = r.vanilla_se;
    o[4] = r.vanilla_fine_bias;
    o[5] = r.n_levels;
    for (int j = 0; j < kLevels; ++j) {
        o[6 + j] = r.out[j];
        o[6 + kLevels + j] = r.out_se[j];
        o[6 + 2 * kLevels + j] = r.out_fine_bias[j];
        o[6 + 3 * kLevels + j] = r.in[j];
        o[6 + 4 * kLevels + j] = r.in_se[j];
    }
    const int k = 6 + 5 * kLevels;
    o[k] = r.arith;
    o[k + 1] = r.arith_se;
    o[k + 2] = r.arith_fine_bias;
    o[k + 3] = r.geo;
    o[k + 4] = r.geo_se;
    o[k + 5] = r.arith_geo_cov;
    o[k + 6] = static_cast<double>(r.n_monitors);
}

EMSCRIPTEN_KEEPALIVE double* qc_pde_out() { return g_pde_out; }
EMSCRIPTEN_KEEPALIVE int qc_pde_out_size() { return kPdeOutSize; }

// Finite differences on the surface in qc_surface(). kind: 0 European, 1 American, 2 knock-out; a knock-out's rebate
// is paid at the hit when rebate_at_hit, otherwise at expiry, and n_monitors tests the barrier on that many equally
// spaced dates instead of continuously. Results in qc_pde_out().
EMSCRIPTEN_KEEPALIVE void qc_pde(int kind, int call, double K, double T, double H, int up, int nodes, int steps,
                                 double rebate, int rebate_at_hit, int n_monitors, int want_vega) {
    quantcore::PdeSpec p;
    p.kind = kind == 1 ? quantcore::PdeKind::American : kind == 2 ? quantcore::PdeKind::KnockOut : quantcore::PdeKind::European;
    p.type = call ? OptionType::Call : OptionType::Put;
    p.K = K;
    p.T = T;
    p.H = H;
    p.up = up != 0;
    p.rebate = rebate;
    p.rebate_at_hit = rebate_at_hit != 0;
    p.n_monitors = n_monitors < 0 ? -1 : n_monitors;   // out of range fails validation
    const quantcore::PdeResult r = quantcore::pde_price(p, read_surface(), nodes, steps, want_vega != 0);
    double* o = g_pde_out;
    o[0] = r.price;
    o[1] = r.delta;
    o[2] = r.gamma;
    o[3] = r.theta;
    o[4] = r.nodes;
    o[5] = r.steps;
    o[6] = r.n_boundary;
    for (int j = 0; j < kPdePoints; ++j) {
        o[7 + j] = r.boundary_tau[j];
        o[7 + kPdePoints + j] = r.boundary_S[j];
    }
    o[7 + 2 * kPdePoints] = r.vega;
}

EMSCRIPTEN_KEEPALIVE double* qc_lsm_out() { return g_lsm_out; }
EMSCRIPTEN_KEEPALIVE int qc_lsm_out_size() { return kLsmOutSize; }

// American option by Longstaff–Schwartz on the surface in qc_surface(); results in qc_lsm_out().
EMSCRIPTEN_KEEPALIVE void qc_lsm(int call, double K, double T, double policy_paths, double value_paths, double seed,
                                 int dates, double steps_per_year) {
    const quantcore::LsmResult r =
        quantcore::lsm_american(call ? OptionType::Call : OptionType::Put, K, T, read_surface(),
                                static_cast<long long>(policy_paths), static_cast<long long>(value_paths),
                                static_cast<uint64_t>(seed), dates, steps_per_year);
    double* o = g_lsm_out;
    o[0] = r.price;
    o[1] = r.std_error;
    o[2] = r.policy_price;
    o[3] = r.european;
    o[4] = r.european_se;
    o[5] = static_cast<double>(r.policy_paths);
    o[6] = static_cast<double>(r.value_paths);
    o[7] = r.dates;
    o[8] = static_cast<double>(r.steps);
    o[9] = r.exercise_dates;
}

}  // extern "C"
