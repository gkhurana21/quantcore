#pragma once
#include <cmath>

namespace quantcore {

enum class OptionType { Call, Put };

struct Greeks {
    double delta;  // dV/dS
    double gamma;  // d²V/dS²
    double theta;  // dV/dt  (< 0 for long options: time decay, per year)
    double vega;   // dV/dσ  (per unit σ, not per 1%)
};

struct BSMResult {
    double price;
    Greeks greeks;
};

// Normal CDF via std::erfc.
// Method: N(x) = 0.5 * erfc(−x/√2)
// erfc is IEEE-754 accurate to ~machine epsilon on all major platforms.
inline double norm_cdf(double x) noexcept {
    static constexpr double kInvSqrt2 = 0.7071067811865475244;  // 1/√2
    return 0.5 * std::erfc(-x * kInvSqrt2);
}

// Standard normal PDF: φ(x) = exp(−x²/2) / √(2π)
inline double norm_pdf(double x) noexcept {
    static constexpr double kInvSqrt2Pi = 0.3989422804014326779;  // 1/√(2π)
    return kInvSqrt2Pi * std::exp(-0.5 * x * x);
}

// Price only — lightweight path used inside finite-difference loops.
double bsm_price(OptionType type,
                 double S, double K, double r, double sigma, double T);

// Price + analytic Greeks in a single pass (shared intermediate values).
BSMResult bsm_full(OptionType type,
                   double S, double K, double r, double sigma, double T);

} // namespace quantcore
