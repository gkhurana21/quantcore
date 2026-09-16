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

LsmResult lsm_american(OptionType type, double K, double T, const VolSurface& s, long long policy_paths,
                       long long value_paths, uint64_t seed, int dates, double steps_per_year) {
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
        rule[k] = 1.0;
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
    release();
    return r;
}

} // namespace quantcore
