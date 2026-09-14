#include "quantcore/local_vol.hpp"
#include "quantcore/ziggurat.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <random>
#ifndef __EMSCRIPTEN__
#  include <thread>
#  include <vector>
#endif

namespace quantcore {
namespace {

// Constants shared with dashboard/lib/quant/volSurface.ts and localVol.ts.
constexpr double kPivotT   = 30.0 / 365.0;            // σ is the 30-day ATM volatility with a term structure
constexpr double kMinT     = 1.0 / (365.0 * 24.0);    // local volatility at t = 0 is its one-hour value
constexpr double kGFloor   = 1e-10;
constexpr double kMaxSigma = 5.0;
constexpr double kMaxVar   = kMaxSigma * kMaxSigma;
constexpr double kLn2      = 0.69314718055994530942;  // Math.LN2

// Paths advanced together through each time step. Within a path every step depends on the last, a serial chain
// of square roots and divisions; across paths nothing does, so a block of paths per step lets the processor
// (out-of-order execution and SIMD) work on many chains at once.
constexpr std::size_t kBlock = 128;

const double kNaN = std::numeric_limits<double>::quiet_NaN();

bool has_term(const VolSurface& s) { return s.term != TermKind::Flat; }
bool has_surface(const VolSurface& s) { return s.smile || has_term(s); }
double centre(const VolSurface& s) { return s.smile_spot > 0.0 ? s.smile_spot : s.S; }

bool valid_surface(const VolSurface& s) {
    if (!(s.S > 0.0) || !(s.sigma > 0.0) || !std::isfinite(s.r) || !std::isfinite(s.q)) return false;
    if (s.smile && !(std::fabs(s.rho) < 1.0 && s.eta > 0.0 && s.gamma > 0.0 && s.gamma <= 0.5)) return false;
    if (s.smile_spot < 0.0 || !std::isfinite(s.smile_spot)) return false;
    if (s.term == TermKind::Curve) return s.ratio > 0.0 && s.half_life > 0.0 && std::isfinite(s.ratio) && std::isfinite(s.half_life);
    if (s.term == TermKind::Fitted) {
        if (s.n_pillars < 1 || s.n_pillars > static_cast<int>(kMaxTermPillars)) return false;
        for (int i = 0; i < s.n_pillars; ++i) {
            if (!(s.pillar_T[i] > 0.0 && s.pillar_w[i] > 0.0) || !std::isfinite(s.pillar_T[i]) || !std::isfinite(s.pillar_w[i])) return false;
            if (i > 0 && !(s.pillar_T[i] > s.pillar_T[i - 1] && s.pillar_w[i] >= s.pillar_w[i - 1])) return false;
        }
    }
    return true;
}

// W(T): ATM total variance per unit σ² (termShape).
double term_shape(const VolSurface& s, double T) {
    if (s.term == TermKind::Curve) {
        const double kappa = kLn2 / s.half_life, c = s.ratio * s.ratio - 1.0;
        auto A = [kappa, c](double x) { return x - (c * std::expm1(-kappa * x)) / kappa; };
        return (kPivotT * A(T)) / A(kPivotT);
    }
    const int n = s.n_pillars;
    const double* ts = s.pillar_T;
    const double* w = s.pillar_w;
    if (T <= ts[0]) return (w[0] * T) / ts[0];
    if (T >= ts[n - 1]) return (w[n - 1] * T) / ts[n - 1];
    int i = 1;
    while (ts[i] < T) ++i;
    if (ts[i] == T) return w[i];
    return w[i - 1] + ((T - ts[i - 1]) / (ts[i] - ts[i - 1])) * (w[i] - w[i - 1]);
}

// dW/dT (termSlope), right derivative at listed expiries.
double term_slope(const VolSurface& s, double T) {
    if (s.term == TermKind::Curve) {
        const double kappa = kLn2 / s.half_life, c = s.ratio * s.ratio - 1.0;
        const double A = kPivotT - (c * std::expm1(-kappa * kPivotT)) / kappa;
        return (kPivotT * (1.0 + c * std::exp(-kappa * T))) / A;
    }
    const int n = s.n_pillars;
    const double* ts = s.pillar_T;
    const double* w = s.pillar_w;
    if (T < ts[0]) return w[0] / ts[0];
    if (T >= ts[n - 1]) return w[n - 1] / ts[n - 1];
    int i = 1;
    while (ts[i] <= T) ++i;
    return (w[i] - w[i - 1]) / (ts[i] - ts[i - 1]);
}

double forward_variance(const VolSurface& s, double T) {
    return s.sigma * s.sigma * (has_term(s) ? term_slope(s, T) : 1.0);
}

double phi(const VolSurface& s, double theta) {
    return s.eta / (std::pow(theta, s.gamma) * std::pow(1.0 + theta, 1.0 - s.gamma));
}

// Everything about σ_loc² at one time that does not depend on the spot, with the products the
// three-division form below needs precomputed.
struct Slice {
    double theta, dTheta;   // ATM total variance and its maturity derivative
    double p;               // φ(θ)
    double lnFs, lnFa;      // log forward of the smile's centre and of the spot
    double half;            // θ/2
    double rhoP;            // ρ·φ
    double halfP;           // θ/2·φ
    double halfDp;          // θ/2·φ′(θ)
    double c2;              // θ/2·φ²·(1 − ρ²)
    double invTh;           // 1/θ
    double pad;
};

Slice make_slice(const VolSurface& s, double t) {
    const double T = std::max(t, kMinT);
    const double theta = atm_variance(s, T);
    const double rho = s.smile ? s.rho : 0.0;
    const double p = s.smile ? phi(s, theta) : 0.0;
    const double dp = s.smile ? p * (-s.gamma / theta + (s.gamma - 1.0) / (1.0 + theta)) : 0.0;
    const double carry = (s.r - s.q) * T;
    const double half = theta / 2;
    return Slice{theta, forward_variance(s, T), p, std::log(centre(s)) + carry, std::log(s.S) + carry,
                 half, rho * p, half * p, half * dp, half * p * p * (1 - rho * rho), 1.0 / theta, 0.0};
}

/*
 * σ_loc² at log spot x; the surface must carry a smile. The same quantities as lvar() in localVol.ts —
 *   w = θ/2·(1 + ρφk + R),  w′ = θ/2·φ·u,  w″ = θ/2·φ²(1 − ρ²)/R³,  ∂θw = w/θ + θ/2·k·u·φ′,  u = ρ + (φk + ρ)/R,
 *   g = (1 − kₐw′/(2w))² − (w′²/4)(1/w + 1/4) + w″/2,  σ_loc² = ∂θw·θ′/g
 * — rearranged around 1/R and 1/w so each evaluation takes three divisions instead of seven (agreement with the
 * browser's form is ~1e-15 relative).
 */
inline double lvar(double rho, double omr2, const Slice& c, double x) {
    const double k = x - c.lnFs, kAct = x - c.lnFa;
    const double y = c.p * k + rho;
    const double R = std::sqrt(y * y + omr2);
    const double invR = 1.0 / R;
    const double u = rho + y * invR;
    const double w = c.half * (1.0 + c.rhoP * k + R);
    const double invW = 1.0 / w;
    const double dw = c.halfP * u;
    const double d2w = c.c2 * invR * invR * invR;
    const double dwdTheta = w * c.invTh + c.halfDp * k * u;
    const double a = 1.0 - 0.5 * kAct * dw * invW;
    const double g = a * a - 0.25 * dw * dw * (invW + 0.25) + 0.5 * d2w;
    const double v = (dwdTheta * c.dTheta) / (g > kGFloor ? g : kGFloor);
    return v < kMaxVar ? (v > 0 ? v : (v <= 0 ? 0 : kMaxVar)) : kMaxVar;   // NaN → the cap
}

// ── simulation plan ──────────────────────────────────────────────────────────

struct Plan {
    double*       block = nullptr;   // one allocation for every per-step array
    std::size_t   n = 0;             // coarse steps
    const double* times = nullptr;   // n + 1
    const double* dt = nullptr, * sqdt = nullptr, * hdt = nullptr, * sqhdt = nullptr;   // n each
    const double* var_inc = nullptr; // n: exact integrated variance (no smile)
    const Slice*  mid = nullptr;     // n, at 0.5·(t_i + t_{i+1})       — plain log-Euler
    const Slice*  coarse = nullptr;  // n, at t_i + Δt/2                 — Richardson
    const Slice*  fine = nullptr;    // 2n, at t_i + Δt/4, t_i + 3Δt/4   — Richardson
    bool          smile = false;
    double        rho = 0.0, omr2 = 1.0, carry = 0.0, x0 = 0.0;
    // the log price is recorded at t = 0 (expired legs) and at every leg expiry
    std::size_t   n_rec = 0;
    std::size_t   rec_step[kPortfolioMaxLegs + 1] = {};
    std::size_t   n_legs = 0;
    std::size_t   leg_rec[kPortfolioMaxLegs] = {};
    double        weight[kPortfolioMaxLegs] = {};
    double        strike[kPortfolioMaxLegs] = {};
    bool          is_call[kPortfolioMaxLegs] = {};
};

// Coarse step count of timeGrid(): every expiry, at most 1/steps_per_year apart. 0 when too long.
std::size_t grid_steps(const double* expiries, std::size_t n_exp, double spy) {
    double prev = 0.0;
    std::size_t total = 0;
    for (std::size_t e = 0; e < n_exp; ++e) {
        const double raw = std::ceil((expiries[e] - prev) * spy - 1e-9);
        if (!(raw <= static_cast<double>(kMaxLocalVolSteps))) return 0;
        total += static_cast<std::size_t>(std::max(1.0, raw));
        if (total > kMaxLocalVolSteps) return 0;
        prev = expiries[e];
    }
    return total;
}

bool build_plan(Plan& p, const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s, double spy, bool richardson) {
    double expiries[kPortfolioMaxLegs];
    std::size_t n_exp = 0;
    for (std::size_t j = 0; j < n_legs; ++j) if (legs[j].T > 0.0) expiries[n_exp++] = legs[j].T;
    std::sort(expiries, expiries + n_exp);
    n_exp = static_cast<std::size_t>(std::unique(expiries, expiries + n_exp) - expiries);

    const std::size_t n = n_exp ? grid_steps(expiries, n_exp, spy) : 0;
    if (n_exp && n == 0) return false;
    const std::size_t n_slices = richardson ? 3 * n : n;
    const std::size_t doubles = (n + 1) + 5 * n + n_slices * (sizeof(Slice) / sizeof(double));
    p.block = static_cast<double*>(std::calloc(doubles, sizeof(double)));
    if (!p.block) return false;
    double* times = p.block;
    double* dt = times + (n + 1), * sqdt = dt + n, * hdt = sqdt + n, * sqhdt = hdt + n, * var_inc = sqhdt + n;
    Slice* slices = reinterpret_cast<Slice*>(var_inc + n);

    std::size_t k = 0;
    times[0] = 0.0;
    for (std::size_t e = 0; e < n_exp; ++e) {
        const double prev = times[k], T = expiries[e];
        const std::size_t m = static_cast<std::size_t>(std::max(1.0, std::ceil((T - prev) * spy - 1e-9)));
        for (std::size_t i = 1; i < m; ++i) times[++k] = prev + ((T - prev) * static_cast<double>(i)) / static_cast<double>(m);
        times[++k] = T;
    }

    const bool surface = has_surface(s);
    for (std::size_t i = 0; i < n; ++i) {
        dt[i] = times[i + 1] - times[i];
        sqdt[i] = std::sqrt(dt[i]);
        hdt[i] = dt[i] / 2;
        sqhdt[i] = std::sqrt(hdt[i]);
        var_inc[i] = std::max(surface ? atm_variance(s, times[i + 1]) - atm_variance(s, times[i]) : s.sigma * s.sigma * dt[i], 0.0);
        if (richardson) {
            slices[i] = make_slice(s, times[i] + dt[i] / 2);
            slices[n + 2 * i] = make_slice(s, times[i] + dt[i] / 4);
            slices[n + 2 * i + 1] = make_slice(s, times[i] + (3 * dt[i]) / 4);
        } else {
            slices[i] = make_slice(s, 0.5 * (times[i] + times[i + 1]));
        }
    }
    p.n = n;
    p.times = times; p.dt = dt; p.sqdt = sqdt; p.hdt = hdt; p.sqhdt = sqhdt; p.var_inc = var_inc;
    p.mid = richardson ? nullptr : slices;
    p.coarse = richardson ? slices : nullptr;
    p.fine = richardson ? slices + n : nullptr;
    p.smile = s.smile;
    p.rho = s.smile ? s.rho : 0.0;
    p.omr2 = 1 - p.rho * p.rho;
    p.carry = s.r - s.q;
    p.x0 = std::log(s.S);

    // recorded steps: 0 and each expiry, in increasing order (a step index per distinct expiry)
    p.n_rec = 0;
    p.rec_step[p.n_rec++] = 0;
    for (std::size_t e = 0; e < n_exp; ++e)
        p.rec_step[p.n_rec++] = static_cast<std::size_t>(std::lower_bound(times, times + n + 1, expiries[e]) - times);
    p.n_legs = n_legs;
    for (std::size_t j = 0; j < n_legs; ++j) {
        const double T = legs[j].T;
        const std::size_t step = T > 0.0 ? static_cast<std::size_t>(std::lower_bound(times, times + n + 1, T) - times) : 0;
        p.leg_rec[j] = static_cast<std::size_t>(std::lower_bound(p.rec_step, p.rec_step + p.n_rec, step) - p.rec_step);
        p.weight[j] = std::exp(-s.r * std::max(0.0, T)) * legs[j].weight;
        p.strike[j] = legs[j].K;
        p.is_call[j] = legs[j].type == OptionType::Call;
    }
    return true;
}

struct Sums {
    double sum = 0.0, sum_sq = 0.0, sum_gap = 0.0;
    bool   ok = true;
};

// $ value of path b from its recorded log prices (rec[r·kBlock + b] is the log price at recorded step r).
inline double path_value(const Plan& p, const double* rec, std::size_t b) {
    double pv = 0.0;
    for (std::size_t j = 0; j < p.n_legs; ++j) {
        const double s = std::exp(rec[p.leg_rec[j] * kBlock + b]);
        pv += p.weight[j] * (p.is_call[j] ? std::max(s - p.strike[j], 0.0) : std::max(p.strike[j] - s, 0.0));
    }
    return pv;
}

inline void record(double* rec, std::size_t r, const double* x, std::size_t B) {
    std::copy(x, x + B, rec + r * kBlock);
}

// Plain log-Euler (exact variance steps without a smile), a block of paths per time step.
Sums simulate_plain(const Plan& p, long long paths, uint64_t seed) {
    Sums out;
    double* rec = static_cast<double*>(std::calloc(p.n_rec * kBlock, sizeof(double)));
    if (!rec) { out.ok = false; return out; }
    std::mt19937_64 rng(seed);
    double x[kBlock], z[kBlock];
    const double rho = p.rho, omr2 = p.omr2, carry = p.carry;
    for (long long done = 0; done < paths;) {
        const std::size_t B = static_cast<std::size_t>(std::min<long long>(static_cast<long long>(kBlock), paths - done));
        std::fill(x, x + B, p.x0);
        record(rec, 0, x, B);
        std::size_t r = 1;
        for (std::size_t i = 0; i < p.n; ++i) {
            for (std::size_t b = 0; b < B; ++b) z[b] = normal_ziggurat(rng);
            const double dt = p.dt[i], sq = p.sqdt[i];
            if (p.smile) {
                const Slice& c = p.mid[i];
                for (std::size_t b = 0; b < B; ++b) {
                    const double v = lvar(rho, omr2, c, x[b]);
                    x[b] += (carry - 0.5 * v) * dt + std::sqrt(v) * sq * z[b];
                }
            } else {
                const double dv = p.var_inc[i], drift = carry * dt - 0.5 * dv, sd = std::sqrt(dv);
                for (std::size_t b = 0; b < B; ++b) x[b] += drift + sd * z[b];
            }
            if (r < p.n_rec && p.rec_step[r] == i + 1) record(rec, r++, x, B);
        }
        for (std::size_t b = 0; b < B; ++b) {
            const double v = path_value(p, rec, b);
            out.sum += v;
            out.sum_sq += v * v;
        }
        done += static_cast<long long>(B);
    }
    std::free(rec);
    return out;
}

// Coupled Richardson: fine and coarse grids on the same Brownian increments; 2·fine − coarse per path.
Sums simulate_richardson(const Plan& p, long long paths, uint64_t seed) {
    Sums out;
    double* recf = static_cast<double*>(std::calloc(2 * p.n_rec * kBlock, sizeof(double)));
    if (!recf) { out.ok = false; return out; }
    double* recc = recf + p.n_rec * kBlock;
    std::mt19937_64 rng(seed);
    double f[kBlock], c[kBlock], z1[kBlock], z2[kBlock];
    const double rho = p.rho, omr2 = p.omr2, carry = p.carry;
    for (long long done = 0; done < paths;) {
        const std::size_t B = static_cast<std::size_t>(std::min<long long>(static_cast<long long>(kBlock), paths - done));
        std::fill(f, f + B, p.x0);
        std::fill(c, c + B, p.x0);
        record(recf, 0, f, B);
        record(recc, 0, c, B);
        std::size_t r = 1;
        for (std::size_t i = 0; i < p.n; ++i) {
            for (std::size_t b = 0; b < B; ++b) {
                z1[b] = normal_ziggurat(rng);
                z2[b] = normal_ziggurat(rng);
            }
            const Slice& f0 = p.fine[2 * i], & f1 = p.fine[2 * i + 1], & c0 = p.coarse[i];
            const double dt = p.dt[i], hdt = p.hdt[i], sq = p.sqhdt[i];
            for (std::size_t b = 0; b < B; ++b) {
                const double v = lvar(rho, omr2, f0, f[b]);
                f[b] += (carry - 0.5 * v) * hdt + std::sqrt(v) * sq * z1[b];
            }
            for (std::size_t b = 0; b < B; ++b) {
                const double v = lvar(rho, omr2, f1, f[b]);
                f[b] += (carry - 0.5 * v) * hdt + std::sqrt(v) * sq * z2[b];
            }
            for (std::size_t b = 0; b < B; ++b) {
                const double v = lvar(rho, omr2, c0, c[b]);
                c[b] += (carry - 0.5 * v) * dt + std::sqrt(v) * sq * (z1[b] + z2[b]);
            }
            if (r < p.n_rec && p.rec_step[r] == i + 1) {
                record(recf, r, f, B);
                record(recc, r, c, B);
                ++r;
            }
        }
        for (std::size_t b = 0; b < B; ++b) {
            const double pf = path_value(p, recf, b), pc = path_value(p, recc, b);
            const double v = 2 * pf - pc;
            out.sum += v;
            out.sum_sq += v * v;
            out.sum_gap += pc - pf;
        }
        done += static_cast<long long>(B);
    }
    std::free(recf);
    return out;
}

LocalVolResult invalid() { return LocalVolResult{kNaN, kNaN, 0, 0, kNaN}; }

LocalVolResult finish(const Sums& s, long long paths, const Plan& p, bool richardson) {
    const double N = static_cast<double>(paths);
    const double mean = s.sum / N;
    const double se = std::sqrt(std::max(s.sum_sq / N - mean * mean, 0.0) / N);
    return LocalVolResult{mean, se, paths, static_cast<long long>(richardson ? 2 * p.n : p.n),
                          richardson ? s.sum_gap / N : kNaN};
}

bool valid_inputs(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s, long long paths, double spy) {
    if (n_legs > kPortfolioMaxLegs || paths < 1 || !(spy > 0.0) || !std::isfinite(spy) || !valid_surface(s)) return false;
    for (std::size_t j = 0; j < n_legs; ++j)
        if (!(legs[j].K > 0.0) || !std::isfinite(legs[j].T) || !std::isfinite(legs[j].weight)) return false;
    return true;
}

} // namespace

double atm_variance(const VolSurface& s, double T) {
    const double v = s.sigma * s.sigma;
    return has_term(s) ? v * term_shape(s, T) : v * T;
}

double implied_vol(const VolSurface& s, double K, double T) {
    if (!has_surface(s) || !(T > 0.0) || !(K > 0.0)) return s.sigma;
    double w = atm_variance(s, T);
    if (s.smile) {
        const double F = centre(s) * std::exp((s.r - s.q) * T);
        const double k = std::log(K / F);
        const double p = phi(s, w);
        const double x = p * k + s.rho;
        const double R = std::sqrt(x * x + 1 - s.rho * s.rho);
        w = (w / 2) * (1 + s.rho * p * k + R);
    }
    const double v = std::sqrt(w / T);
    return std::isfinite(v) && v > 0.0 ? std::min(v, kMaxSigma) : s.sigma;
}

double local_vol(const VolSurface& s, double spot, double t) {
    if (!has_surface(s)) return s.sigma;
    const Slice c = make_slice(s, t);
    const double v = s.smile ? lvar(s.rho, 1 - s.rho * s.rho, c, std::log(spot)) : std::min(c.dTheta, kMaxVar);
    return std::sqrt(v);
}

LocalVolResult mc_local_vol(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s,
                            long long paths, uint64_t seed, double steps_per_year, bool extrapolate) {
    if (!valid_inputs(legs, n_legs, s, paths, steps_per_year)) return invalid();
    const bool richardson = extrapolate && s.smile;
    Plan p;
    if (!build_plan(p, legs, n_legs, s, steps_per_year, richardson)) { std::free(p.block); return invalid(); }
    const Sums sums = richardson ? simulate_richardson(p, paths, seed) : simulate_plain(p, paths, seed);
    const LocalVolResult res = sums.ok ? finish(sums, paths, p, richardson) : invalid();
    std::free(p.block);
    return res;
}

#ifndef __EMSCRIPTEN__
LocalVolResult mc_local_vol_mt(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s,
                               long long paths, uint64_t seed, double steps_per_year, bool extrapolate,
                               int n_threads) {
    if (!valid_inputs(legs, n_legs, s, paths, steps_per_year)) return invalid();
    if (n_threads <= 0) n_threads = static_cast<int>(std::thread::hardware_concurrency());
    n_threads = static_cast<int>(std::max(1LL, std::min<long long>(n_threads, paths)));
    const bool richardson = extrapolate && s.smile;
    Plan p;
    if (!build_plan(p, legs, n_legs, s, steps_per_year, richardson)) { std::free(p.block); return invalid(); }

    std::vector<Sums> parts(static_cast<std::size_t>(n_threads));
    std::vector<std::thread> threads;
    threads.reserve(parts.size());
    const long long base = paths / n_threads, extra = paths % n_threads;
    for (int t = 0; t < n_threads; ++t) {
        const long long n = base + (t < extra ? 1 : 0);
        const uint64_t tseed = seed + static_cast<uint64_t>(t) * 0x9e3779b97f4a7c15ULL;
        threads.emplace_back([&p, &parts, t, n, tseed, richardson] {
            parts[static_cast<std::size_t>(t)] = richardson ? simulate_richardson(p, n, tseed) : simulate_plain(p, n, tseed);
        });
    }
    for (auto& th : threads) th.join();

    Sums total;
    for (const Sums& part : parts) {
        total.sum += part.sum;
        total.sum_sq += part.sum_sq;
        total.sum_gap += part.sum_gap;
        total.ok = total.ok && part.ok;
    }
    const LocalVolResult res = total.ok ? finish(total, paths, p, richardson) : invalid();
    std::free(p.block);
    return res;
}
#endif

} // namespace quantcore
