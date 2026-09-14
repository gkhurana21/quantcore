#include "quantcore/monte_carlo_portfolio.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <random>
#ifndef __EMSCRIPTEN__
#  include <thread>
#  include <vector>
#endif

namespace quantcore {
namespace {

using Row = std::array<double, kPortfolioMaxLegs>;

// Everything about the portfolio that does not change from path to path. Fixed-size arrays
// keep the kernel allocation-free, which also keeps the WebAssembly build free of imports.
struct Plan {
    std::size_t n_times = 0;
    std::size_t n_legs = 0;
    Row inc_sd{};                                   // √Δt between consecutive distinct expiries
    std::array<int, kPortfolioMaxLegs> leg_time{};  // each leg's expiry, as an index into those times
    Row drift{};                                    // (r − q − σ²/2)·T per leg
    Row vol{};                                      // σ per leg
    Row weight{};                                   // e^{−rT} × signed quantity × multiplier
    Row strike{};
    std::array<bool, kPortfolioMaxLegs> is_call{};
};

Plan make_plan(const PortfolioLeg* legs, std::size_t n, double r, double q) {
    Plan p;
    p.n_legs = n;
    Row times{};
    for (std::size_t j = 0; j < n; ++j) times[j] = std::max(0.0, legs[j].T);
    std::sort(times.begin(), times.begin() + static_cast<std::ptrdiff_t>(n));
    p.n_times = static_cast<std::size_t>(
        std::unique(times.begin(), times.begin() + static_cast<std::ptrdiff_t>(n)) - times.begin());
    double prev = 0.0;
    for (std::size_t i = 0; i < p.n_times; ++i) {
        p.inc_sd[i] = std::sqrt(std::max(times[i] - prev, 0.0));
        prev = times[i];
    }
    const auto times_end = times.begin() + static_cast<std::ptrdiff_t>(p.n_times);
    for (std::size_t j = 0; j < n; ++j) {
        const double T = std::max(0.0, legs[j].T), s = legs[j].sigma;
        p.leg_time[j] = static_cast<int>(std::lower_bound(times.begin(), times_end, T) - times.begin());
        p.drift[j]    = (r - q - 0.5 * s * s) * T;
        p.vol[j]      = s;
        p.weight[j]   = std::exp(-r * T) * legs[j].weight;
        p.strike[j]   = legs[j].K;
        p.is_call[j]  = legs[j].type == OptionType::Call;
    }
    return p;
}

struct Sums {
    double sum = 0.0;
    double sum_sq = 0.0;
};

// `units` independent draws of the portfolio value (antithetic pair means when antithetic).
Sums simulate(const Plan& p, double S, long long units, uint64_t seed, bool antithetic) {
    std::mt19937_64 rng(seed);
    std::normal_distribution<double> dist(0.0, 1.0);
    Row z{}, w{};

    auto value = [&](double sign) {
        double acc = 0.0;
        for (std::size_t i = 0; i < p.n_times; ++i) {
            acc += sign * p.inc_sd[i] * z[i];
            w[i] = acc;
        }
        double pv = 0.0;
        for (std::size_t j = 0; j < p.n_legs; ++j) {
            const double st = S * std::exp(p.drift[j] + p.vol[j] * w[static_cast<std::size_t>(p.leg_time[j])]);
            pv += p.weight[j] * (p.is_call[j] ? std::max(st - p.strike[j], 0.0)
                                              : std::max(p.strike[j] - st, 0.0));
        }
        return pv;
    };

    Sums out;
    for (long long u = 0; u < units; ++u) {
        for (std::size_t i = 0; i < p.n_times; ++i) z[i] = dist(rng);
        const double v = antithetic ? 0.5 * (value(1.0) + value(-1.0)) : value(1.0);
        out.sum += v;
        out.sum_sq += v * v;
    }
    return out;
}

MCResult finish(double sum, double sum_sq, long long units, int per_unit) {
    const double N    = static_cast<double>(units);
    const double mean = sum / N;
    const double var  = (sum_sq / N - mean * mean) / N;   // variance of the mean
    return MCResult{mean, std::sqrt(std::max(var, 0.0)), units * per_unit};
}

MCResult too_many_legs() {
    const double nan = std::numeric_limits<double>::quiet_NaN();
    return MCResult{nan, nan, 0};
}

} // namespace

MCResult mc_portfolio(const PortfolioLeg* legs, std::size_t n_legs,
                      double S, double r, double q,
                      long long paths, uint64_t seed, bool antithetic) {
    if (n_legs > kPortfolioMaxLegs) return too_many_legs();
    const int per_unit = antithetic ? 2 : 1;
    const long long units = std::max(1LL, paths / per_unit);
    if (n_legs == 0) return MCResult{0.0, 0.0, units * per_unit};
    const Plan p = make_plan(legs, n_legs, r, q);
    const Sums s = simulate(p, S, units, seed, antithetic);
    return finish(s.sum, s.sum_sq, units, per_unit);
}

#ifndef __EMSCRIPTEN__
MCResult mc_portfolio_mt(const PortfolioLeg* legs, std::size_t n_legs,
                         double S, double r, double q,
                         long long paths, uint64_t seed, bool antithetic, int n_threads) {
    if (n_legs > kPortfolioMaxLegs) return too_many_legs();
    const int per_unit = antithetic ? 2 : 1;
    const long long units = std::max(1LL, paths / per_unit);
    if (n_legs == 0) return MCResult{0.0, 0.0, units * per_unit};
    if (n_threads <= 0) n_threads = static_cast<int>(std::thread::hardware_concurrency());
    n_threads = static_cast<int>(std::max(1LL, std::min<long long>(n_threads, units)));

    const Plan p = make_plan(legs, n_legs, r, q);
    std::vector<Sums> parts(static_cast<std::size_t>(n_threads));
    std::vector<std::thread> threads;
    threads.reserve(parts.size());
    const long long base = units / n_threads, extra = units % n_threads;
    for (int t = 0; t < n_threads; ++t) {
        const long long n = base + (t < extra ? 1 : 0);
        const uint64_t tseed = seed + static_cast<uint64_t>(t) * 0x9e3779b97f4a7c15ULL;
        threads.emplace_back([&p, &parts, S, t, n, tseed, antithetic] {
            parts[static_cast<std::size_t>(t)] = simulate(p, S, n, tseed, antithetic);
        });
    }
    for (auto& th : threads) th.join();

    double sum = 0.0, sum_sq = 0.0;
    for (const Sums& s : parts) {
        sum += s.sum;
        sum_sq += s.sum_sq;
    }
    return finish(sum, sum_sq, units, per_unit);
}
#endif

} // namespace quantcore
