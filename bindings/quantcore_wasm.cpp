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
#include "quantcore/local_vol.hpp"
#include "quantcore/monte_carlo.hpp"
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
EMSCRIPTEN_KEEPALIVE int qc_abi_version() { return 3; }

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

}  // extern "C"
