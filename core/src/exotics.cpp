#include "quantcore/exotics.hpp"

#include <algorithm>
#include <cmath>

namespace quantcore {

namespace {
double intrinsic(OptionType type, double S, double K) {
    return type == OptionType::Call ? std::max(S - K, 0.0) : std::max(K - S, 0.0);
}
}

BarrierPrices barrier_prices(OptionType type, bool up, double S, double K, double H, double T,
                             double sigma, double r, double q) {
    const bool call = type == OptionType::Call;
    const double vanilla = T > 0.0 ? bsm_price(type, S, K, r, sigma, T, q) : intrinsic(type, S, K);
    const bool touched = up ? S >= H : S <= H;
    if (touched) return BarrierPrices{0.0, vanilla, vanilla};
    if (!(T > 0.0) || !(sigma > 0.0)) return BarrierPrices{vanilla, 0.0, vanilla};

    const double sd = sigma * std::sqrt(T);
    const double mu = (r - q - (sigma * sigma) / 2) / (sigma * sigma);
    const double x1 = std::log(S / K) / sd + (1 + mu) * sd;
    const double x2 = std::log(S / H) / sd + (1 + mu) * sd;
    const double y1 = std::log((H * H) / (S * K)) / sd + (1 + mu) * sd;
    const double y2 = std::log(H / S) / sd + (1 + mu) * sd;
    const double phi = call ? 1.0 : -1.0, eta = up ? -1.0 : 1.0;
    const double dq = std::exp(-q * T), dr = std::exp(-r * T);
    const double hs = H / S, hs2mu = std::pow(hs, 2 * mu), hs2mu1 = hs2mu * hs * hs;
    const double A = phi * S * dq * norm_cdf(phi * x1) - phi * K * dr * norm_cdf(phi * (x1 - sd));
    const double B = phi * S * dq * norm_cdf(phi * x2) - phi * K * dr * norm_cdf(phi * (x2 - sd));
    const double C = phi * S * dq * hs2mu1 * norm_cdf(eta * y1) - phi * K * dr * hs2mu * norm_cdf(eta * (y1 - sd));
    const double D = phi * S * dq * hs2mu1 * norm_cdf(eta * y2) - phi * K * dr * hs2mu * norm_cdf(eta * (y2 - sd));

    double out;
    if (call && !up)       out = K > H ? A - C : B - D;              // down-and-out call
    else if (call && up)   out = K >= H ? 0.0 : A - B + C - D;       // up-and-out call
    else if (!call && !up) out = K <= H ? 0.0 : A - B + C - D;       // down-and-out put
    else                   out = K >= H ? B - D : A - C;             // up-and-out put
    out = std::min(vanilla, std::max(0.0, out));
    return BarrierPrices{out, vanilla - out, vanilla};
}

BarrierPrices barrier_prices_discrete(OptionType type, bool up, double S, double K, double H, double T,
                                      double sigma, double r, double q, int n_monitors) {
    if (n_monitors < 1 || !(T > 0.0) || !(sigma > 0.0) || !(H > 0.0)) {
        return barrier_prices(type, up, S, K, H, T, sigma, r, q);
    }
    // the barrier moves away from the spot, so it is breached less often than under continuous monitoring
    const double dt = T / static_cast<double>(n_monitors);
    const double shift = std::exp((up ? 1.0 : -1.0) * kBgkBeta * sigma * std::sqrt(dt));
    return barrier_prices(type, up, S, K, H * shift, T, sigma, r, q);
}

double geometric_asian_price(OptionType type, double S, double K, double T, int n_fixings,
                             double sigma, double r, double q) {
    if (!(T > 0.0) || !(sigma > 0.0) || n_fixings < 1) return intrinsic(type, S, K);
    const double n = static_cast<double>(n_fixings);
    const double tbar = (T * (n + 1)) / (2 * n);
    const double variance = (sigma * sigma * T * (n + 1) * (2 * n + 1)) / (6 * n * n);
    const double mean = std::log(S) + (r - q - (sigma * sigma) / 2) * tbar;
    const double sd = std::sqrt(variance);
    const double forward_g = std::exp(mean + variance / 2);
    const double d1 = (mean - std::log(K) + variance) / sd, d2 = d1 - sd;
    const double df = std::exp(-r * T);
    return type == OptionType::Call ? df * (forward_g * norm_cdf(d1) - K * norm_cdf(d2))
                                    : df * (K * norm_cdf(-d2) - forward_g * norm_cdf(-d1));
}

} // namespace quantcore
