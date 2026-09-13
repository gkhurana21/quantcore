#include "quantcore/black_scholes.hpp"
#include <cmath>

namespace quantcore {

static void compute_d1_d2(double S, double K, double r, double q, double sigma, double T,
                           double& d1, double& d2) noexcept {
    double sqrtT = std::sqrt(T);
    d1 = (std::log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    d2 = d1 - sigma * sqrtT;
}

double bsm_price(OptionType type,
                 double S, double K, double r, double sigma, double T, double q) {
    double d1, d2;
    compute_d1_d2(S, K, r, q, sigma, T, d1, d2);
    double disc  = std::exp(-r * T);
    double qdisc = std::exp(-q * T);   // 1 exactly when q = 0
    if (type == OptionType::Call)
        return S * qdisc * norm_cdf(d1) - K * disc * norm_cdf(d2);
    else
        return K * disc * norm_cdf(-d2) - S * qdisc * norm_cdf(-d1);
}

BSMResult bsm_full(OptionType type,
                   double S, double K, double r, double sigma, double T, double q) {
    double sqrtT = std::sqrt(T);
    double d1, d2;
    compute_d1_d2(S, K, r, q, sigma, T, d1, d2);

    double Nd1   = norm_cdf(d1);
    double Nd2   = norm_cdf(d2);
    double phid1 = norm_pdf(d1);   // φ(d1) — shared by gamma and vega
    double disc  = std::exp(-r * T);
    double qdisc = std::exp(-q * T);

    BSMResult res{};

    // Gamma and vega are identical for calls and puts
    res.greeks.gamma = qdisc * phid1 / (S * sigma * sqrtT);
    res.greeks.vega  = S * qdisc * phid1 * sqrtT;

    double decay = -(S * qdisc * phid1 * sigma) / (2.0 * sqrtT);

    if (type == OptionType::Call) {
        res.price        = S * qdisc * Nd1 - K * disc * Nd2;
        res.greeks.delta = qdisc * Nd1;
        // theta = dV/dt = -(S·e^{-qT}·φ(d1)·σ)/(2√T) - r·K·e^{-rT}·N(d2) + q·S·e^{-qT}·N(d1)
        res.greeks.theta = decay - r * K * disc * Nd2 + q * S * qdisc * Nd1;
    } else {
        res.price        = K * disc * norm_cdf(-d2) - S * qdisc * norm_cdf(-d1);
        res.greeks.delta = qdisc * (Nd1 - 1.0);
        // theta_put = -(S·e^{-qT}·φ(d1)·σ)/(2√T) + r·K·e^{-rT}·N(-d2) - q·S·e^{-qT}·N(-d1)
        res.greeks.theta = decay + r * K * disc * norm_cdf(-d2) - q * S * qdisc * norm_cdf(-d1);
    }

    return res;
}

} // namespace quantcore
