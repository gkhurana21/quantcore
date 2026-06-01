#pragma once
#include <cstdint>
#include "quantcore/black_scholes.hpp"

namespace quantcore {

struct MCResult {
    double    price;      // discounted mean payoff
    double    std_error;  // standard error of the MC estimate
    long long paths;
};

// European option price via GBM Monte Carlo.
// Fully deterministic given (paths, seed).
MCResult mc_price(OptionType type,
                  double S, double K, double r, double sigma, double T,
                  long long paths, uint64_t seed = 42);

} // namespace quantcore
