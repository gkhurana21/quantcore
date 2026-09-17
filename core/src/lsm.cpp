#include "quantcore/lsm.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>

namespace quantcore {
namespace {

const double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr long long kChunk = 8192;    // valuation paths simulated at a time
constexpr long long kMinItm = 32;     // in-the-money paths a regression needs

LsmResult invalid_lsm() {
    LsmResult r;
    r.price = r.std_error = r.policy_price = r.european = r.european_se = kNaN;
    return r;
}

inline double payoff(bool call, double S, double K) { return call ? std::max(S - K, 0.0) : std::max(K - S, 0.0); }

/** The fitted continuation value at x = S/K. */
inline double fitted(const double* b, double x) { return b[0] + x * (b[1] + x * (b[2] + x * b[3])); }

/** Normal equations solved by Cholesky with a ridge; false when the matrix is not positive definite. */
bool solve_normal(double* a, const double* rhs, double* out) {
    const double ridge = 1e-10 * (a[0] + a[5] + a[10] + a[15] + 1.0);
    for (int i = 0; i < kLsmBasis; ++i) a[i * kLsmBasis + i] += ridge;
    double L[kLsmBasis * kLsmBasis] = {};
    for (int i = 0; i < kLsmBasis; ++i) {
        for (int j = 0; j <= i; ++j) {
            double sum = a[i * kLsmBasis + j];
            for (int k = 0; k < j; ++k) sum -= L[i * kLsmBasis + k] * L[j * kLsmBasis + k];
            if (i == j) {
                if (!(sum > 0.0)) return false;
                L[i * kLsmBasis + i] = std::sqrt(sum);
            } else {
                L[i * kLsmBasis + j] = sum / L[j * kLsmBasis + j];
            }
        }
    }
    double y[kLsmBasis];
    for (int i = 0; i < kLsmBasis; ++i) {
        double sum = rhs[i];
        for (int k = 0; k < i; ++k) sum -= L[i * kLsmBasis + k] * y[k];
        y[i] = sum / L[i * kLsmBasis + i];
    }
    for (int i = kLsmBasis - 1; i >= 0; --i) {
        double sum = y[i];
        for (int k = i + 1; k < kLsmBasis; ++k) sum -= L[k * kLsmBasis + i] * out[k];
        out[i] = sum / L[i * kLsmBasis + i];
    }
    return true;
}

} // namespace

LsmResult lsm_american_policy(OptionType type, double K, double T, const VolSurface& s, long long policy_paths,
                              long long value_paths, uint64_t seed, int dates, double steps_per_year,
                              LsmPolicy* out_policy) {
    if (!vol_surface_valid(s) || !(K > 0.0) || !(T > 0.0) || !std::isfinite(K) || !std::isfinite(T) ||
        policy_paths < 100 || value_paths < 100 || dates < 1 || dates > kLsmMaxDates ||
        !(steps_per_year > 0.0) || !std::isfinite(steps_per_year) ||
        policy_paths > kLsmMaxCells / dates) {
        return invalid_lsm();
    }
    const bool call = type == OptionType::Call;
    const std::size_t M = static_cast<std::size_t>(dates);
    const double dt = T / static_cast<double>(dates), df = std::exp(-s.r * dt);
    const long long rows = std::max(policy_paths, kChunk);

    double* times = static_cast<double*>(std::calloc(M, sizeof(double)));
    double* beta = static_cast<double*>(std::calloc(M * kLsmBasis, sizeof(double)));
    double* rule = static_cast<double*>(std::calloc(M, sizeof(double)));       // 1 where the date has an exercise rule
    LsmPolicy policy;
    policy.type = type;
    policy.K = K;
    policy.T = T;
    policy.dates = dates;
    double* grid = static_cast<double*>(std::calloc(static_cast<std::size_t>(rows) * M, sizeof(double)));
    double* cash = static_cast<double*>(std::calloc(static_cast<std::size_t>(policy_paths), sizeof(double)));
    auto release = [&] { std::free(times); std::free(beta); std::free(rule); std::free(grid); std::free(cash); };
    if (!times || !beta || !rule || !grid || !cash) { release(); return invalid_lsm(); }
    for (std::size_t k = 0; k < M; ++k) times[k] = k + 1 == M ? T : dt * static_cast<double>(k + 1);

    // ── pass 1: the exercise policy, by backward induction on regressed continuation values ──
    const long long steps = simulate_local_vol_paths(s, times, M, policy_paths, seed, steps_per_year, grid);
    if (steps == 0) { release(); return invalid_lsm(); }
    for (long long i = 0; i < policy_paths; ++i) cash[i] = payoff(call, grid[static_cast<std::size_t>(i) * M + (M - 1)], K);
    int exercise_dates = 0;
    for (std::size_t k = M - 1; k-- > 0;) {
        for (long long i = 0; i < policy_paths; ++i) cash[i] *= df;             // one date step closer
        double a[kLsmBasis * kLsmBasis] = {}, rhs[kLsmBasis] = {}, b[kLsmBasis] = {};
        long long itm = 0;
        for (long long i = 0; i < policy_paths; ++i) {
            const double spot = grid[static_cast<std::size_t>(i) * M + k];
            if (!(payoff(call, spot, K) > 0.0)) continue;
            const double x = spot / K;
            const double f[kLsmBasis] = { 1.0, x, x * x, x * x * x };
            for (int r = 0; r < kLsmBasis; ++r) {
                for (int c = 0; c <= r; ++c) a[r * kLsmBasis + c] += f[r] * f[c];
                rhs[r] += f[r] * cash[i];
            }
            ++itm;
        }
        if (itm < kMinItm) continue;
        for (int r = 0; r < kLsmBasis; ++r) for (int c = r + 1; c < kLsmBasis; ++c) a[r * kLsmBasis + c] = a[c * kLsmBasis + r];
        if (!solve_normal(a, rhs, b)) continue;
        std::copy(b, b + kLsmBasis, beta + k * kLsmBasis);
        std::copy(b, b + kLsmBasis, policy.beta + k * kLsmBasis);
        rule[k] = 1.0;
        policy.rule[k] = true;
        ++exercise_dates;
        for (long long i = 0; i < policy_paths; ++i) {
            const double spot = grid[static_cast<std::size_t>(i) * M + k], intrinsic = payoff(call, spot, K);
            if (intrinsic > 0.0 && intrinsic >= fitted(b, spot / K)) cash[i] = intrinsic;
        }
    }
    double policy_sum = 0.0;
    for (long long i = 0; i < policy_paths; ++i) policy_sum += cash[i];
    const double policy_price = (policy_sum / static_cast<double>(policy_paths)) * df;

    // ── pass 2: fresh paths exercised by that policy, so the estimate is low biased ──
    const double df_T = std::exp(-s.r * T);
    double sum = 0.0, sum_sq = 0.0, eu_sum = 0.0, eu_sq = 0.0;
    for (long long done = 0; done < value_paths;) {
        const long long n = std::min(kChunk, value_paths - done);
        if (simulate_local_vol_paths(s, times, M, n, seed + 0x9e3779b97f4a7c15ULL + static_cast<uint64_t>(done), steps_per_year, grid) == 0) {
            release();
            return invalid_lsm();
        }
        for (long long i = 0; i < n; ++i) {
            const double* row = grid + static_cast<std::size_t>(i) * M;
            double v = 0.0, d = df;
            for (std::size_t k = 0; k < M; ++k, d *= df) {
                const double intrinsic = payoff(call, row[k], K);
                const bool last = k + 1 == M;
                if (last || (rule[k] != 0.0 && intrinsic > 0.0 && intrinsic >= fitted(beta + k * kLsmBasis, row[k] / K))) {
                    v = intrinsic * d;
                    break;
                }
            }
            const double eu = payoff(call, row[M - 1], K) * df_T;
            sum += v;
            sum_sq += v * v;
            eu_sum += eu;
            eu_sq += eu * eu;
        }
        done += n;
    }
    const double N = static_cast<double>(value_paths);
    const double mean = sum / N, eu_mean = eu_sum / N;
    LsmResult r;
    r.price = mean;
    r.std_error = std::sqrt(std::max(sum_sq / N - mean * mean, 0.0) / N);
    r.policy_price = policy_price;
    r.european = eu_mean;
    r.european_se = std::sqrt(std::max(eu_sq / N - eu_mean * eu_mean, 0.0) / N);
    r.policy_paths = policy_paths;
    r.value_paths = value_paths;
    r.dates = dates;
    r.steps = steps;
    r.exercise_dates = exercise_dates;
    if (out_policy) *out_policy = policy;
    release();
    return r;
}

LsmResult lsm_american(OptionType type, double K, double T, const VolSurface& s, long long policy_paths,
                       long long value_paths, uint64_t seed, int dates, double steps_per_year) {
    return lsm_american_policy(type, K, T, s, policy_paths, value_paths, seed, dates, steps_per_year, nullptr);
}

namespace {

LsmDualResult invalid_dual() {
    LsmDualResult r;
    r.upper = r.std_error = kNaN;
    return r;
}

/**
 * Discounted value of following the policy from date `from` at `spot`, to the option's expiry, averaged over `paths`
 * inner simulations. Discounting is to the option's start, matching the outer path's h values. `buf` must hold
 * paths × (M − from) doubles. Returns NaN if the simulation fails.
 */
double policy_value(const LsmPolicy& p, const VolSurface& s, const double* times, std::size_t M, std::size_t from,
                    double spot, long long paths, uint64_t seed, double steps_per_year, double df_step, double* buf,
                    long long* sims) {
    const bool call = p.type == OptionType::Call;
    if (from >= M) return 0.0;
    const std::size_t cols = M - from;
    if (simulate_local_vol_paths_from(s, times, M, from, spot, paths, seed, steps_per_year, buf) == 0) return kNaN;
    ++*sims;
    double prefix = 1.0;                                              // discount from t = 0 to dates[from - 1]
    for (std::size_t j = 0; j < from; ++j) prefix *= df_step;
    double total = 0.0;
    for (long long i = 0; i < paths; ++i) {
        const double* row = buf + static_cast<std::size_t>(i) * cols;
        double d = prefix, v = 0.0;
        for (std::size_t j = 0; j < cols; ++j) {
            d *= df_step;
            const std::size_t k = from + j;
            const double intrinsic = payoff(call, row[j], p.K);
            const bool last = k + 1 == M;
            if (last || (p.rule[k] && intrinsic > 0.0 && intrinsic >= fitted(p.beta + k * kLsmBasis, row[j] / p.K))) {
                v = intrinsic * d;
                break;
            }
        }
        total += v;
    }
    return total / static_cast<double>(paths);
}

} // namespace

LsmDualResult lsm_dual_bound(const LsmPolicy& policy, const VolSurface& s, long long outer_paths,
                             long long inner_paths, uint64_t seed, double steps_per_year) {
    if (!vol_surface_valid(s) || !(policy.K > 0.0) || !(policy.T > 0.0) || policy.dates < 1 ||
        policy.dates > kLsmMaxDates || outer_paths < 100 || inner_paths < 10 ||
        !(steps_per_year > 0.0) || !std::isfinite(steps_per_year)) {
        return invalid_dual();
    }
    const bool call = policy.type == OptionType::Call;
    const std::size_t M = static_cast<std::size_t>(policy.dates);
    const double dt = policy.T / static_cast<double>(policy.dates), df = std::exp(-s.r * dt);

    double* times = static_cast<double*>(std::calloc(M, sizeof(double)));
    double* outer = static_cast<double*>(std::calloc(static_cast<std::size_t>(kChunk) * M, sizeof(double)));
    double* inner = static_cast<double*>(std::calloc(static_cast<std::size_t>(inner_paths) * M, sizeof(double)));
    auto release = [&] { std::free(times); std::free(outer); std::free(inner); };
    if (!times || !outer || !inner) { release(); return invalid_dual(); }
    for (std::size_t k = 0; k < M; ++k) times[k] = k + 1 == M ? policy.T : dt * static_cast<double>(k + 1);

    double sum = 0.0, sum_sq = 0.0;
    long long sims = 0;
    uint64_t stream = seed + 0x1234567891234567ULL;
    for (long long done = 0; done < outer_paths;) {
        const long long n = std::min(kChunk, outer_paths - done);
        if (simulate_local_vol_paths(s, times, M, n, seed + static_cast<uint64_t>(done), steps_per_year, outer) == 0) {
            release();
            return invalid_dual();
        }
        for (long long i = 0; i < n; ++i) {
            const double* row = outer + static_cast<std::size_t>(i) * M;
            // Q at the previous date, and the conditional expectation of the next date's Q given it.
            double prev_q = policy_value(policy, s, times, M, 0, s.S, inner_paths, ++stream, steps_per_year, df, inner, &sims);
            if (std::isnan(prev_q)) { release(); return invalid_dual(); }
            // Q_k is the value of the policy restarted from S_k, a function of the state alone: it is defined at every
            // date whether or not the path has already exercised, and the maximum runs over all of them. Stopping the
            // scan at the policy's own exercise date truncates the maximum; freezing the exercised cash there leaves a
            // stale martingale that a later payoff is measured against, and either way the bound is not the option's
            // own value process.
            double martingale = 0.0, best = -1e300, d = 1.0;
            for (std::size_t k = 0; k < M; ++k) {
                d *= df;
                const double spot = row[k];
                const double intrinsic = payoff(call, spot, policy.K);
                const double h = intrinsic * d;                        // discounted payoff if exercised here
                const bool last = k + 1 == M;
                const bool exercises = last || (policy.rule[k] && intrinsic > 0.0 &&
                                                intrinsic >= fitted(policy.beta + k * kLsmBasis, spot / policy.K));
                // Where the restarted policy stops here Q_k is the intrinsic value, which is the one inner simulation
                // the estimator saves; otherwise Q_k is the policy's continuation value from the next date.
                double q;
                if (exercises) {
                    q = h;
                } else {
                    q = policy_value(policy, s, times, M, k + 1, spot, inner_paths, ++stream, steps_per_year, df, inner, &sims);
                    if (std::isnan(q)) { release(); return invalid_dual(); }
                }
                martingale += q - prev_q;                              // prev_q holds E[Q_k | S_{k-1}]
                const double candidate = h - martingale;
                if (candidate > best) best = candidate;
                if (last) break;
                // E[Q_{k+1} | S_k] is the policy restarted at date k+1. Where the policy continued that is exactly the
                // continuation value just drawn, and reusing it telescopes that draw's noise out of the two increments
                // it appears in; an exercise node has no such estimate and pays for one.
                if (exercises) {
                    prev_q = policy_value(policy, s, times, M, k + 1, spot, inner_paths, ++stream, steps_per_year, df, inner, &sims);
                    if (std::isnan(prev_q)) { release(); return invalid_dual(); }
                } else {
                    prev_q = q;
                }
            }
            sum += best;
            sum_sq += best * best;
        }
        done += n;
    }
    const double N = static_cast<double>(outer_paths);
    const double mean = sum / N;
    LsmDualResult r;
    r.upper = mean;
    r.std_error = std::sqrt(std::max(sum_sq / N - mean * mean, 0.0) / N);
    r.outer_paths = outer_paths;
    r.inner_paths = inner_paths;
    r.dates = policy.dates;
    r.inner_sims = sims;
    release();
    return r;
}

} // namespace quantcore
