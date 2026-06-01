#include "quantcore/monte_carlo.hpp"
#include <random>
#include <cmath>

namespace quantcore {

MCResult mc_price(OptionType type,
                  double S, double K, double r, double sigma, double T,
                  long long paths, uint64_t seed) {
    // std::mt19937_64 seeded deterministically — same seed → same price.
    std::mt19937_64 rng(seed);
    std::normal_distribution<double> dist(0.0, 1.0);

    // GBM terminal price: S·exp((r - σ²/2)·T + σ·√T·Z),  Z ~ N(0,1)
    const double drift     = (r - 0.5 * sigma * sigma) * T;
    const double vol_sqrtT = sigma * std::sqrt(T);
    const double disc      = std::exp(-r * T);

    double sum = 0.0, sum_sq = 0.0;
    for (long long i = 0; i < paths; ++i) {
        double ST      = S * std::exp(drift + vol_sqrtT * dist(rng));
        double payoff  = (type == OptionType::Call)
                         ? std::max(ST - K, 0.0)
                         : std::max(K - ST, 0.0);
        double pv      = disc * payoff;
        sum    += pv;
        sum_sq += pv * pv;
    }

    double n    = static_cast<double>(paths);
    double mean = sum / n;
    double var  = (sum_sq / n - mean * mean) / n;   // variance of the mean

    return MCResult{mean, std::sqrt(var), paths};
}

} // namespace quantcore
