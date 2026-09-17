#include "quantcore/local_vol.hpp"
#include "quantcore/exotics.hpp"
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

// ── time grid ────────────────────────────────────────────────────────────────

// Every per-step array of a simulation, for a set of anchor times (expiries, fixings) the grid must land on.
struct Grid {
    double*       block = nullptr;   // one allocation for all of it
    std::size_t   n = 0;             // coarse steps
    std::size_t   n_anchor = 0;
    const double* times = nullptr;   // n + 1
    const double* dt = nullptr, * sqdt = nullptr, * hdt = nullptr, * sqhdt = nullptr;   // n each
    const double* var_inc = nullptr; // n: exact integrated variance (no smile)
    const double* anchor_step = nullptr;   // n_anchor: step index of each anchor
    const Slice*  mid = nullptr;     // n, at 0.5·(t_i + t_{i+1})       — plain log-Euler
    const Slice*  coarse = nullptr;  // n, at t_i + Δt/2                 — Richardson
    const Slice*  fine = nullptr;    // 2n, at t_i + Δt/4, t_i + 3Δt/4   — Richardson
    bool          smile = false;
    double        rho = 0.0, omr2 = 1.0, carry = 0.0, x0 = 0.0;
};

// Coarse step count of timeGrid(): every anchor, at most 1/steps_per_year apart. 0 when too long.
std::size_t grid_steps(const double* anchors, std::size_t n_anchor, double spy, double t0 = 0.0) {
    double prev = t0;
    std::size_t total = 0;
    for (std::size_t e = 0; e < n_anchor; ++e) {
        const double raw = std::ceil((anchors[e] - prev) * spy - 1e-9);
        if (!(raw <= static_cast<double>(kMaxLocalVolSteps))) return 0;
        total += static_cast<std::size_t>(std::max(1.0, raw));
        if (total > kMaxLocalVolSteps) return 0;
        prev = anchors[e];
    }
    return total;
}

// anchors: strictly increasing positive times.
// t0: the calendar time the grid starts at (0 for a simulation from today; a date's time for one continuing from a
// state part-way through). Slices are made at absolute times either way, so the two agree on local volatility.
bool build_grid(Grid& g, const double* anchors, std::size_t n_anchor, const VolSurface& s, double spy, bool richardson,
                double t0 = 0.0) {
    const std::size_t n = n_anchor ? grid_steps(anchors, n_anchor, spy, t0) : 0;
    if (n_anchor && n == 0) return false;
    const std::size_t n_slices = richardson ? 3 * n : n;
    const std::size_t doubles = (n + 1) + 5 * n + n_anchor + n_slices * (sizeof(Slice) / sizeof(double));
    g.block = static_cast<double*>(std::calloc(doubles, sizeof(double)));
    if (!g.block) return false;
    double* times = g.block;
    double* dt = times + (n + 1), * sqdt = dt + n, * hdt = sqdt + n, * sqhdt = hdt + n, * var_inc = sqhdt + n;
    double* anchor_step = var_inc + n;
    Slice* slices = reinterpret_cast<Slice*>(anchor_step + n_anchor);

    std::size_t k = 0;
    times[0] = t0;
    for (std::size_t e = 0; e < n_anchor; ++e) {
        const double prev = times[k], T = anchors[e];
        const std::size_t m = static_cast<std::size_t>(std::max(1.0, std::ceil((T - prev) * spy - 1e-9)));
        for (std::size_t i = 1; i < m; ++i) times[++k] = prev + ((T - prev) * static_cast<double>(i)) / static_cast<double>(m);
        times[++k] = T;
        anchor_step[e] = static_cast<double>(k);
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
    g.n = n;
    g.n_anchor = n_anchor;
    g.times = times; g.dt = dt; g.sqdt = sqdt; g.hdt = hdt; g.sqhdt = sqhdt; g.var_inc = var_inc;
    g.anchor_step = anchor_step;
    g.mid = richardson ? nullptr : slices;
    g.coarse = richardson ? slices : nullptr;
    g.fine = richardson ? slices + n : nullptr;
    g.smile = s.smile;
    g.rho = s.smile ? s.rho : 0.0;
    g.omr2 = 1 - g.rho * g.rho;
    g.carry = s.r - s.q;
    g.x0 = std::log(s.S);
    return true;
}

// ── portfolio of European legs ───────────────────────────────────────────────

struct Plan {
    Grid          g;
    // the log price is recorded at t = 0 (expired legs) and at every leg expiry
    std::size_t   n_rec = 0;
    std::size_t   rec_step[kPortfolioMaxLegs + 1] = {};
    std::size_t   n_legs = 0;
    std::size_t   leg_rec[kPortfolioMaxLegs] = {};
    double        weight[kPortfolioMaxLegs] = {};
    double        strike[kPortfolioMaxLegs] = {};
    bool          is_call[kPortfolioMaxLegs] = {};
};

bool build_plan(Plan& p, const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s, double spy, bool richardson) {
    double expiries[kPortfolioMaxLegs];
    std::size_t n_exp = 0;
    for (std::size_t j = 0; j < n_legs; ++j) if (legs[j].T > 0.0) expiries[n_exp++] = legs[j].T;
    std::sort(expiries, expiries + n_exp);
    n_exp = static_cast<std::size_t>(std::unique(expiries, expiries + n_exp) - expiries);
    if (!build_grid(p.g, expiries, n_exp, s, spy, richardson)) return false;
    const Grid& g = p.g;

    p.n_rec = 0;
    p.rec_step[p.n_rec++] = 0;
    for (std::size_t e = 0; e < n_exp; ++e) p.rec_step[p.n_rec++] = static_cast<std::size_t>(g.anchor_step[e]);
    p.n_legs = n_legs;
    for (std::size_t j = 0; j < n_legs; ++j) {
        const double T = legs[j].T;
        const std::size_t step = T > 0.0 ? static_cast<std::size_t>(std::lower_bound(g.times, g.times + g.n + 1, T) - g.times) : 0;
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
    const Grid& g = p.g;
    Sums out;
    double* rec = static_cast<double*>(std::calloc(p.n_rec * kBlock, sizeof(double)));
    if (!rec) { out.ok = false; return out; }
    std::mt19937_64 rng(seed);
    double x[kBlock], z[kBlock];
    const double rho = g.rho, omr2 = g.omr2, carry = g.carry;
    for (long long done = 0; done < paths;) {
        const std::size_t B = static_cast<std::size_t>(std::min<long long>(static_cast<long long>(kBlock), paths - done));
        std::fill(x, x + B, g.x0);
        record(rec, 0, x, B);
        std::size_t r = 1;
        for (std::size_t i = 0; i < g.n; ++i) {
            for (std::size_t b = 0; b < B; ++b) z[b] = normal_ziggurat(rng);
            const double dt = g.dt[i], sq = g.sqdt[i];
            if (g.smile) {
                const Slice& c = g.mid[i];
                for (std::size_t b = 0; b < B; ++b) {
                    const double v = lvar(rho, omr2, c, x[b]);
                    x[b] += (carry - 0.5 * v) * dt + std::sqrt(v) * sq * z[b];
                }
            } else {
                const double dv = g.var_inc[i], drift = carry * dt - 0.5 * dv, sd = std::sqrt(dv);
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
    const Grid& g = p.g;
    Sums out;
    double* recf = static_cast<double*>(std::calloc(2 * p.n_rec * kBlock, sizeof(double)));
    if (!recf) { out.ok = false; return out; }
    double* recc = recf + p.n_rec * kBlock;
    std::mt19937_64 rng(seed);
    double f[kBlock], c[kBlock], z1[kBlock], z2[kBlock];
    const double rho = g.rho, omr2 = g.omr2, carry = g.carry;
    for (long long done = 0; done < paths;) {
        const std::size_t B = static_cast<std::size_t>(std::min<long long>(static_cast<long long>(kBlock), paths - done));
        std::fill(f, f + B, g.x0);
        std::fill(c, c + B, g.x0);
        record(recf, 0, f, B);
        record(recc, 0, c, B);
        std::size_t r = 1;
        for (std::size_t i = 0; i < g.n; ++i) {
            for (std::size_t b = 0; b < B; ++b) {
                z1[b] = normal_ziggurat(rng);
                z2[b] = normal_ziggurat(rng);
            }
            const Slice& f0 = g.fine[2 * i], & f1 = g.fine[2 * i + 1], & c0 = g.coarse[i];
            const double dt = g.dt[i], hdt = g.hdt[i], sq = g.sqhdt[i];
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
    return LocalVolResult{mean, se, paths, static_cast<long long>(richardson ? 2 * p.g.n : p.g.n),
                          richardson ? s.sum_gap / N : kNaN};
}

bool valid_inputs(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s, long long paths, double spy) {
    if (n_legs > kPortfolioMaxLegs || paths < 1 || !(spy > 0.0) || !std::isfinite(spy) || !valid_surface(s)) return false;
    for (std::size_t j = 0; j < n_legs; ++j)
        if (!(legs[j].K > 0.0) || !std::isfinite(legs[j].T) || !std::isfinite(legs[j].weight)) return false;
    return true;
}

// ── exotics: barriers (Brownian-bridge survival) and Asian averages ──────────

struct ExoticPlan {
    Grid   g;
    bool   barrier = false, call = true, up = false;
    std::size_t M = 0;                        // barrier levels
    double h[kMaxBarrierLevels] = {};         // log barriers
    std::size_t n_mon = 0;                    // barrier monitoring dates; 0 monitors continuously
    std::size_t n_fix = 0;
    double K = 0.0, df = 1.0;
    double rebate = 0.0, r = 0.0;             // r discounts a rebate to the step it is earned at
    bool   at_hit = true;
};

bool valid_exotic(const ExoticSpec& e, const VolSurface& s, long long paths, double spy) {
    if (paths < 1 || !(spy > 0.0) || !std::isfinite(spy) || !valid_surface(s)) return false;
    if (!(e.K > 0.0) || !std::isfinite(e.K) || !(e.T > 0.0) || !(e.T <= 30.0)) return false;
    if (e.kind == ExoticKind::Barrier) {
        if (e.n_levels < 1 || e.n_levels > static_cast<int>(kMaxBarrierLevels)) return false;
        for (int j = 0; j < e.n_levels; ++j) if (!(e.levels[j] > 0.0) || !std::isfinite(e.levels[j])) return false;
        return e.n_monitors >= 0 && e.n_monitors <= static_cast<int>(kMaxBarrierMonitors) &&
               e.rebate >= 0.0 && std::isfinite(e.rebate);
    }
    return e.kind == ExoticKind::Asian && e.n_fixings >= 1 && e.n_fixings <= static_cast<int>(kMaxAsianFixings);
}

bool build_exotic_plan(ExoticPlan& p, const ExoticSpec& e, const VolSurface& s, double spy, bool richardson) {
    p.barrier = e.kind == ExoticKind::Barrier;
    p.call = e.type == OptionType::Call;
    p.up = e.up;
    p.K = e.K;
    p.df = std::exp(-s.r * e.T);
    p.r = s.r;
    p.rebate = p.barrier ? e.rebate : 0.0;
    p.at_hit = e.rebate_at_hit;
    if (p.barrier) {
        p.M = static_cast<std::size_t>(e.n_levels);
        for (std::size_t j = 0; j < p.M; ++j) p.h[j] = std::log(e.levels[j]);
        p.n_mon = e.n_monitors > 0 ? static_cast<std::size_t>(e.n_monitors) : 0;
        if (!p.n_mon) {
            const double T = e.T;
            return build_grid(p.g, &T, 1, s, spy, richardson);
        }
        // the monitoring dates are grid anchors, so every one of them is a step the path lands on exactly
        double* anchors = static_cast<double*>(std::calloc(p.n_mon, sizeof(double)));
        if (!anchors) return false;
        for (std::size_t i = 0; i < p.n_mon; ++i) anchors[i] = (e.T * static_cast<double>(i + 1)) / static_cast<double>(p.n_mon);
        anchors[p.n_mon - 1] = e.T;   // the last monitoring date is the expiry
        const bool ok = build_grid(p.g, anchors, p.n_mon, s, spy, richardson);
        std::free(anchors);
        return ok;
    }
    p.n_fix = static_cast<std::size_t>(e.n_fixings);
    double* anchors = static_cast<double*>(std::calloc(p.n_fix, sizeof(double)));
    if (!anchors) return false;
    for (std::size_t i = 0; i < p.n_fix; ++i) anchors[i] = (e.T * static_cast<double>(i + 1)) / static_cast<double>(p.n_fix);
    anchors[p.n_fix - 1] = e.T;   // exactly on the expiry
    const bool ok = build_grid(p.g, anchors, p.n_fix, s, spy, richardson);
    std::free(anchors);
    return ok;
}

struct ExoticSums {
    double van = 0.0, van2 = 0.0, van_gap = 0.0;
    double out[kMaxBarrierLevels] = {}, out2[kMaxBarrierLevels] = {}, out_gap[kMaxBarrierLevels] = {};
    double in[kMaxBarrierLevels] = {}, in2[kMaxBarrierLevels] = {};
    double ar = 0.0, ar2 = 0.0, ar_gap = 0.0, ge = 0.0, ge2 = 0.0, ag = 0.0;
    bool   ok = true;

    void add(const ExoticSums& o) {
        van += o.van; van2 += o.van2; van_gap += o.van_gap;
        for (std::size_t j = 0; j < kMaxBarrierLevels; ++j) {
            out[j] += o.out[j]; out2[j] += o.out2[j]; out_gap[j] += o.out_gap[j];
            in[j] += o.in[j]; in2[j] += o.in2[j];
        }
        ar += o.ar; ar2 += o.ar2; ar_gap += o.ar_gap; ge += o.ge; ge2 += o.ge2; ag += o.ag;
        ok = ok && o.ok;
    }
};

// One grid's state for a block of paths: log price, survival per level (sv[j·kBlock + b]), the discounted rebate
// earned so far per level (reb[j·kBlock + b]; zero unless the barrier pays one), running average sums.
struct PathState { double* x; double* sv; double* reb; double* asum; double* gsum; };

ExoticSums simulate_exotic(const ExoticPlan& p, long long paths, uint64_t seed, bool richardson) {
    const Grid& g = p.g;
    ExoticSums out;
    const std::size_t M = p.M;
    const std::size_t per = kBlock * (3 + 2 * M);
    const std::size_t grids = richardson ? 2 : 1;
    double* mem = static_cast<double*>(std::calloc(grids * per + 2 * kBlock, sizeof(double)));
    if (!mem) { out.ok = false; return out; }
    auto state = [&](std::size_t k) {
        double* base = mem + k * per;
        return PathState{base, base + kBlock, base + kBlock * (1 + M), base + kBlock * (1 + 2 * M),
                         base + kBlock * (2 + 2 * M)};
    };
    const PathState F = state(0);
    const PathState C = richardson ? state(1) : PathState{nullptr, nullptr, nullptr, nullptr, nullptr};
    double* z1 = mem + grids * per, * z2 = z1 + kBlock;

    std::mt19937_64 rng(seed);
    const double rho = g.rho, omr2 = g.omr2, carry = g.carry;
    const double inv_n = p.n_fix ? 1.0 / static_cast<double>(p.n_fix) : 0.0;
    const bool up = p.up;
    const bool discrete = p.n_mon > 0;   // the barrier is tested on the monitoring dates only, never between them
    const bool rebate_on = p.rebate > 0.0;

    const double kInf = std::numeric_limits<double>::infinity();
    double xn[kBlock], inv_var[kBlock];
    // Barrier survival over a step from st.x to xn: a Brownian bridge with step variance 1/inv_var stays on the far side
    // of the log barrier h with probability 1 − exp(−2(x₀ − h)(x₁ − h)/v). One level at a time over the block, so the
    // loop is a plain pass the compiler can vectorise; the exponential is skipped once it is below e^−40.
    auto bridge = [&](const PathState& st, std::size_t B, double df_hit) {
        for (std::size_t j = 0; j < M; ++j) {
            const double h = p.h[j];
            double* sv = st.sv + j * kBlock;
            if (!rebate_on) {
                for (std::size_t b = 0; b < B; ++b) {
                    const double a = up ? h - st.x[b] : st.x[b] - h, c = up ? h - xn[b] : xn[b] - h;
                    if (!(a > 0.0) || !(c > 0.0)) { sv[b] = 0.0; continue; }
                    const double e = 2.0 * a * c * inv_var[b];
                    if (e <= 40.0) sv[b] *= -std::expm1(-e);
                }
                continue;
            }
            // paying a rebate, the probability of touching during this step is earned here, discounted to the step's
            // end — the hit's time is not sampled, so this carries an O(Δt) timing error that shrinks with the step
            double* reb = st.reb + j * kBlock;
            for (std::size_t b = 0; b < B; ++b) {
                const double a = up ? h - st.x[b] : st.x[b] - h, c = up ? h - xn[b] : xn[b] - h;
                if (!(a > 0.0) || !(c > 0.0)) { reb[b] += sv[b] * df_hit; sv[b] = 0.0; continue; }
                const double e = 2.0 * a * c * inv_var[b];
                if (e <= 40.0) {
                    const double w = -std::expm1(-e);
                    reb[b] += sv[b] * (1.0 - w) * df_hit;
                    sv[b] *= w;
                }
            }
        }
    };
    // one grid's paths by one log-Euler step at the local variance, then the bridge
    auto step_smile = [&](const PathState& st, std::size_t B, const Slice& sl, double h_dt, double sq, const double* z,
                          double df_hit) {
        for (std::size_t b = 0; b < B; ++b) {
            const double v = lvar(rho, omr2, sl, st.x[b]);
            xn[b] = st.x[b] + (carry - 0.5 * v) * h_dt + std::sqrt(v) * sq * z[b];
            const double var = v * h_dt;
            inv_var[b] = var > 0.0 ? 1.0 / var : kInf;
        }
        if (M && !discrete) bridge(st, B, df_hit);
        std::copy(xn, xn + B, st.x);
    };

    for (long long done = 0; done < paths;) {
        const std::size_t B = static_cast<std::size_t>(std::min<long long>(static_cast<long long>(kBlock), paths - done));
        for (std::size_t k = 0; k < grids; ++k) {
            const PathState st = k ? C : F;
            std::fill(st.x, st.x + B, g.x0);
            for (std::size_t j = 0; j < M; ++j) {
                std::fill(st.sv + j * kBlock, st.sv + j * kBlock + B, 1.0);
                std::fill(st.reb + j * kBlock, st.reb + j * kBlock + B, 0.0);
            }
            std::fill(st.asum, st.asum + B, 0.0);
            std::fill(st.gsum, st.gsum + B, 0.0);
        }
        std::size_t r = 0;   // next fixing
        for (std::size_t i = 0; i < g.n; ++i) {
            // the rebate earned in this step, discounted to where the hit is placed: the step's end, or the midpoint
            // for the fine grid's first half step. The amount is folded in here, so the accumulator holds money.
            const double df_end = rebate_on ? p.rebate * std::exp(-p.r * g.times[i + 1]) : 0.0;
            const double df_mid = rebate_on ? p.rebate * std::exp(-p.r * 0.5 * (g.times[i] + g.times[i + 1])) : 0.0;
            if (richardson) {
                for (std::size_t b = 0; b < B; ++b) {
                    z1[b] = normal_ziggurat(rng);
                    z2[b] = normal_ziggurat(rng);
                }
                const double dt = g.dt[i], hdt = g.hdt[i], sq = g.sqhdt[i];
                step_smile(F, B, g.fine[2 * i], hdt, sq, z1, df_mid);
                step_smile(F, B, g.fine[2 * i + 1], hdt, sq, z2, df_end);
                for (std::size_t b = 0; b < B; ++b) z2[b] += z1[b];   // the coarse step's increment
                step_smile(C, B, g.coarse[i], dt, sq, z2, df_end);
            } else {
                for (std::size_t b = 0; b < B; ++b) z1[b] = normal_ziggurat(rng);
                if (g.smile) {
                    step_smile(F, B, g.mid[i], g.dt[i], g.sqdt[i], z1, df_end);
                } else {
                    // no smile: the step's variance is exact, so the bridge weight is too
                    const double dv = g.var_inc[i], drift = carry * g.dt[i] - 0.5 * dv, sd = std::sqrt(dv);
                    const double inv = dv > 0.0 ? 1.0 / dv : kInf;
                    for (std::size_t b = 0; b < B; ++b) {
                        xn[b] = F.x[b] + drift + sd * z1[b];
                        inv_var[b] = inv;
                    }
                    if (M && !discrete) bridge(F, B, df_end);
                    std::copy(xn, xn + B, F.x);
                }
            }
            if (r < g.n_anchor && static_cast<std::size_t>(g.anchor_step[r]) == i + 1) {
                for (std::size_t k = 0; k < grids; ++k) {
                    const PathState st = k ? C : F;
                    if (p.n_fix) {
                        for (std::size_t b = 0; b < B; ++b) {
                            st.asum[b] += std::exp(st.x[b]);
                            st.gsum[b] += st.x[b];
                        }
                    }
                    // discrete monitoring: survival is an indicator on this date, not a probability over the step
                    if (discrete) {
                        for (std::size_t j = 0; j < M; ++j) {
                            const double h = p.h[j];
                            double*      sv = st.sv + j * kBlock;
                            double*      reb = st.reb + j * kBlock;
                            for (std::size_t b = 0; b < B; ++b) {
                                if (up ? st.x[b] >= h : st.x[b] <= h) {
                                    if (rebate_on) reb[b] += sv[b] * df_end;   // exact: the hit is on this date
                                    sv[b] = 0.0;
                                }
                            }
                        }
                    }
                }
                ++r;
            }
        }

        const double df = p.df, K = p.K;
        const double reb_expiry = p.rebate * p.df;   // a rebate paid at expiry, whichever side earns it
        const bool at_hit = p.at_hit;
        const bool call = p.call;
        auto pay = [call, K, df](double s) { return df * std::max(call ? s - K : K - s, 0.0); };
        for (std::size_t b = 0; b < B; ++b) {
            const double vf = pay(std::exp(F.x[b]));
            const double vc = richardson ? pay(std::exp(C.x[b])) : 0.0;
            const double van = richardson ? 2 * vf - vc : vf;
            out.van += van;
            out.van2 += van * van;
            out.van_gap += vc - vf;
            for (std::size_t j = 0; j < M; ++j) {
                // the knock-out keeps the payoff where it survived and adds the rebate it earned; the knock-in pays
                // where it did not survive, and earns its rebate at expiry where it did. Without a rebate these are
                // exactly the old sv·payoff and vanilla − knock-out.
                const double svf = F.sv[j * kBlock + b];
                const double svc = richardson ? C.sv[j * kBlock + b] : 0.0;
                const double of = svf * vf + (rebate_on ? (at_hit ? F.reb[j * kBlock + b] : reb_expiry * (1.0 - svf)) : 0.0);
                const double oc = richardson
                    ? svc * vc + (rebate_on ? (at_hit ? C.reb[j * kBlock + b] : reb_expiry * (1.0 - svc)) : 0.0)
                    : 0.0;
                const double o = richardson ? 2 * of - oc : of;
                const double in_f = (1.0 - svf) * vf + (rebate_on ? reb_expiry * svf : 0.0);
                const double in_c = richardson ? (1.0 - svc) * vc + (rebate_on ? reb_expiry * svc : 0.0) : 0.0;
                const double kin = richardson ? 2 * in_f - in_c : in_f;
                out.out[j] += o;
                out.out2[j] += o * o;
                out.out_gap[j] += oc - of;
                out.in[j] += kin;
                out.in2[j] += kin * kin;
            }
            if (p.n_fix) {
                const double af = pay(F.asum[b] * inv_n), gf = pay(std::exp(F.gsum[b] * inv_n));
                const double ac = richardson ? pay(C.asum[b] * inv_n) : 0.0;
                const double gc = richardson ? pay(std::exp(C.gsum[b] * inv_n)) : 0.0;
                const double a = richardson ? 2 * af - ac : af, ge = richardson ? 2 * gf - gc : gf;
                out.ar += a;
                out.ar2 += a * a;
                out.ar_gap += ac - af;
                out.ge += ge;
                out.ge2 += ge * ge;
                out.ag += a * ge;
            }
        }
        done += static_cast<long long>(B);
    }
    std::free(mem);
    return out;
}

ExoticResult invalid_exotic() {
    ExoticResult r;
    r.vanilla = r.vanilla_se = r.vanilla_fine_bias = kNaN;
    r.arith = r.arith_se = r.arith_fine_bias = r.geo = r.geo_se = r.arith_geo_cov = kNaN;
    for (std::size_t j = 0; j < kMaxBarrierLevels; ++j) r.out[j] = r.out_se[j] = r.out_fine_bias[j] = r.in[j] = r.in_se[j] = kNaN;
    return r;
}

ExoticResult finish_exotic(const ExoticSums& s, long long paths, const ExoticPlan& p, bool richardson) {
    const double N = static_cast<double>(paths);
    auto mean = [N](double sum) { return sum / N; };
    auto se = [N](double sum, double sq) { const double m = sum / N; return std::sqrt(std::max(sq / N - m * m, 0.0) / N); };
    ExoticResult r = invalid_exotic();
    r.paths = paths;
    r.steps = static_cast<long long>(richardson ? 2 * p.g.n : p.g.n);
    r.vanilla = mean(s.van);
    r.vanilla_se = se(s.van, s.van2);
    r.vanilla_fine_bias = richardson ? mean(s.van_gap) : kNaN;
    r.n_levels = static_cast<int>(p.M);
    r.n_monitors = static_cast<int>(p.n_mon);
    for (std::size_t j = 0; j < p.M; ++j) {
        r.out[j] = mean(s.out[j]);
        r.out_se[j] = se(s.out[j], s.out2[j]);
        r.out_fine_bias[j] = richardson ? mean(s.out_gap[j]) : kNaN;
        r.in[j] = mean(s.in[j]);
        r.in_se[j] = se(s.in[j], s.in2[j]);
    }
    if (p.n_fix) {
        r.arith = mean(s.ar);
        r.arith_se = se(s.ar, s.ar2);
        r.arith_fine_bias = richardson ? mean(s.ar_gap) : kNaN;
        r.geo = mean(s.ge);
        r.geo_se = se(s.ge, s.ge2);
        r.arith_geo_cov = s.ag / N - r.arith * r.geo;
    }
    return r;
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

void local_variance_row(const VolSurface& s, double t, const double* log_spots, std::size_t n, double* out) {
    if (!has_surface(s)) {
        std::fill(out, out + n, s.sigma * s.sigma);
        return;
    }
    const Slice c = make_slice(s, t);
    if (!s.smile) {
        std::fill(out, out + n, std::min(c.dTheta, kMaxVar));
        return;
    }
    const double omr2 = 1.0 - s.rho * s.rho;
    for (std::size_t i = 0; i < n; ++i) out[i] = lvar(s.rho, omr2, c, log_spots[i]);
}

bool vol_surface_valid(const VolSurface& s) { return valid_surface(s); }

long long simulate_local_vol_paths_from(const VolSurface& s, const double* dates, std::size_t n_dates, std::size_t start,
                                        double start_spot, long long paths, uint64_t seed, double steps_per_year,
                                        double* out) {
    if (!valid_surface(s) || n_dates == 0 || start + 1 > n_dates || paths < 1 || !(start_spot > 0.0) ||
        !std::isfinite(start_spot) || !(steps_per_year > 0.0) || !std::isfinite(steps_per_year)) return 0;
    for (std::size_t k = 0; k < n_dates; ++k) {
        if (!(dates[k] > 0.0) || !std::isfinite(dates[k]) || (k > 0 && !(dates[k] > dates[k - 1]))) return 0;
    }
    const std::size_t remaining = n_dates - start;     // dates still to simulate
    if (remaining == 0) return 0;
    const double t0 = start == 0 ? 0.0 : dates[start - 1];
    Grid g;
    if (!build_grid(g, dates + start, remaining, s, steps_per_year, false, t0)) return 0;
    std::mt19937_64 rng(seed);
    double x[kBlock], z[kBlock];
    const double rho = g.rho, omr2 = g.omr2, carry = g.carry;
    const double x_start = std::log(start_spot);
    for (long long done = 0; done < paths;) {
        const std::size_t B = static_cast<std::size_t>(std::min<long long>(static_cast<long long>(kBlock), paths - done));
        std::fill(x, x + B, x_start);
        std::size_t a = 0;
        for (std::size_t i = 0; i < g.n; ++i) {
            for (std::size_t b = 0; b < B; ++b) z[b] = normal_ziggurat(rng);
            const double dt = g.dt[i], sq = g.sqdt[i];
            if (g.smile) {
                const Slice& c = g.mid[i];
                for (std::size_t b = 0; b < B; ++b) {
                    const double v = lvar(rho, omr2, c, x[b]);
                    x[b] += (carry - 0.5 * v) * dt + std::sqrt(v) * sq * z[b];
                }
            } else {
                const double dv = g.var_inc[i], drift = carry * dt - 0.5 * dv, sd = std::sqrt(dv);
                for (std::size_t b = 0; b < B; ++b) x[b] += drift + sd * z[b];
            }
            if (a < remaining && static_cast<std::size_t>(g.anchor_step[a]) == i + 1) {
                for (std::size_t b = 0; b < B; ++b) out[(static_cast<std::size_t>(done) + b) * remaining + a] = std::exp(x[b]);
                ++a;
            }
        }
        done += static_cast<long long>(B);
    }
    const long long n = static_cast<long long>(g.n);
    std::free(g.block);
    return n;
}

long long simulate_local_vol_paths(const VolSurface& s, const double* dates, std::size_t n_dates, long long paths,
                                   uint64_t seed, double steps_per_year, double* out) {
    return simulate_local_vol_paths_from(s, dates, n_dates, 0, s.S, paths, seed, steps_per_year, out);
}

LocalVolResult mc_local_vol(const PortfolioLeg* legs, std::size_t n_legs, const VolSurface& s,
                            long long paths, uint64_t seed, double steps_per_year, bool extrapolate) {
    if (!valid_inputs(legs, n_legs, s, paths, steps_per_year)) return invalid();
    const bool richardson = extrapolate && s.smile;
    Plan p;
    if (!build_plan(p, legs, n_legs, s, steps_per_year, richardson)) { std::free(p.g.block); return invalid(); }
    const Sums sums = richardson ? simulate_richardson(p, paths, seed) : simulate_plain(p, paths, seed);
    const LocalVolResult res = sums.ok ? finish(sums, paths, p, richardson) : invalid();
    std::free(p.g.block);
    return res;
}

ExoticResult mc_exotic(const ExoticSpec& e, const VolSurface& s, long long paths, uint64_t seed,
                       double steps_per_year, bool extrapolate) {
    if (!valid_exotic(e, s, paths, steps_per_year)) return invalid_exotic();
    const bool richardson = extrapolate && s.smile;
    ExoticPlan p;
    if (!build_exotic_plan(p, e, s, steps_per_year, richardson)) { std::free(p.g.block); return invalid_exotic(); }
    const ExoticSums sums = simulate_exotic(p, paths, seed, richardson);
    const ExoticResult res = sums.ok ? finish_exotic(sums, paths, p, richardson) : invalid_exotic();
    std::free(p.g.block);
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
    if (!build_plan(p, legs, n_legs, s, steps_per_year, richardson)) { std::free(p.g.block); return invalid(); }

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
    std::free(p.g.block);
    return res;
}

ExoticResult mc_exotic_mt(const ExoticSpec& e, const VolSurface& s, long long paths, uint64_t seed,
                          double steps_per_year, bool extrapolate, int n_threads) {
    if (!valid_exotic(e, s, paths, steps_per_year)) return invalid_exotic();
    if (n_threads <= 0) n_threads = static_cast<int>(std::thread::hardware_concurrency());
    n_threads = static_cast<int>(std::max(1LL, std::min<long long>(n_threads, paths)));
    const bool richardson = extrapolate && s.smile;
    ExoticPlan p;
    if (!build_exotic_plan(p, e, s, steps_per_year, richardson)) { std::free(p.g.block); return invalid_exotic(); }

    std::vector<ExoticSums> parts(static_cast<std::size_t>(n_threads));
    std::vector<std::thread> threads;
    threads.reserve(parts.size());
    const long long base = paths / n_threads, extra = paths % n_threads;
    for (int t = 0; t < n_threads; ++t) {
        const long long n = base + (t < extra ? 1 : 0);
        const uint64_t tseed = seed + static_cast<uint64_t>(t) * 0x9e3779b97f4a7c15ULL;
        threads.emplace_back([&p, &parts, t, n, tseed, richardson] {
            parts[static_cast<std::size_t>(t)] = simulate_exotic(p, n, tseed, richardson);
        });
    }
    for (auto& th : threads) th.join();

    ExoticSums total;
    for (const ExoticSums& part : parts) total.add(part);
    const ExoticResult res = total.ok ? finish_exotic(total, paths, p, richardson) : invalid_exotic();
    std::free(p.g.block);
    return res;
}
#endif

} // namespace quantcore
