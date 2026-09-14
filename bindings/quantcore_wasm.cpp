// WebAssembly entry points for the C++ pricing core.
//
// Built by scripts/build-wasm.sh from the same core/src sources as the native
// library (black_scholes.cpp, monte_carlo.cpp) into a standalone .wasm with no
// JavaScript glue. Each call writes its results to a fixed output buffer that the
// caller reads through qc_out(). Inputs are validated by the TypeScript loader
// (dashboard/lib/engine/wasm.ts), which never passes non-positive S, K, sigma or T.

#include <cstdint>
#include <emscripten/emscripten.h>

#include "quantcore/black_scholes.hpp"
#include "quantcore/monte_carlo.hpp"
#include "quantcore/monte_carlo_portfolio.hpp"

using quantcore::OptionType;

namespace {
constexpr int kMaxLegs = static_cast<int>(quantcore::kPortfolioMaxLegs);
double g_out[8];
double g_legs[kMaxLegs * 5];   // portfolio input: [call (0/1), K, T, sigma, weight] per leg
}

extern "C" {

// Bumped whenever a signature or the output layout changes.
EMSCRIPTEN_KEEPALIVE int qc_abi_version() { return 2; }

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

}  // extern "C"
