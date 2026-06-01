#include "quantcore/monte_carlo_mt.hpp"

#include <Accelerate/Accelerate.h>
#include <thread>
#include <vector>
#include <random>
#include <cmath>
#include <algorithm>
#include <cstring>

namespace quantcore {

// Chunk size for vvexp batching within each thread.
// Sized to fit comfortably in L1 cache (4096 × 8 bytes = 32 KB).
static constexpr int MC_CHUNK = 4096;

// ── per-thread worker ─────────────────────────────────────────────────────────

static void mc_worker(OptionType type,
                       double S, double K, double r,
                       double sigma, double T,
                       long long paths,
                       uint64_t  seed,
                       double&   out_sum,
                       double&   out_sum_sq)
{
    std::mt19937_64 rng(seed);
    std::normal_distribution<double> dist(0.0, 1.0);

    const double drift     = (r - 0.5 * sigma * sigma) * T;
    const double vol_sqrtT = sigma * std::sqrt(T);
    const double disc      = std::exp(-r * T);
    const bool   is_call   = (type == OptionType::Call);

    // Per-thread working buffers (stack lifetime, sized to MC_CHUNK)
    alignas(16) double buf_z  [MC_CHUNK];
    alignas(16) double buf_st [MC_CHUNK];   // reused as exponent then ST
    alignas(16) double buf_pv [MC_CHUNK];

    double sum = 0.0, sum_sq = 0.0;
    long long done = 0;

    while (done < paths) {
        int n = static_cast<int>(std::min((long long)MC_CHUNK, paths - done));

        // 1. Generate Z ~ N(0,1) via mt19937_64 — sequential (hard to SIMD)
        for (int i = 0; i < n; ++i) buf_z[i] = dist(rng);

        // 2. exponent[i] = drift + vol_sqrtT * Z[i]
        //    Uses vDSP scalar-multiply-add: D[i] = A[i]*B + C
        vDSP_vsmsaD(buf_z, 1, &vol_sqrtT, &drift, buf_st, 1, n);

        // 3. buf_st[i] = exp(exponent[i])  [SIMD via vvexp — NEON internally]
        vvexp(buf_st, buf_st, &n);

        // 4. buf_st[i] *= S  (scale to terminal price)
        vDSP_vsmulD(buf_st, 1, &S, buf_st, 1, n);

        // 5. payoff = max(ST − K, 0)  or  max(K − ST, 0)
        if (is_call) {
            double neg_K = -K;
            vDSP_vsaddD(buf_st, 1, &neg_K, buf_pv, 1, n);
        } else {
            double neg_one = -1.0;
            vDSP_vsmulD(buf_st, 1, &neg_one, buf_pv, 1, n);
            vDSP_vsaddD(buf_pv, 1, &K,       buf_pv, 1, n);
        }
        // Threshold: set negatives to zero
        double zero = 0.0;
        vDSP_vthrD(buf_pv, 1, &zero, buf_pv, 1, n);

        // 6. pv = disc * payoff
        vDSP_vsmulD(buf_pv, 1, &disc, buf_pv, 1, n);

        // 7. Accumulate sum and sum-of-squares
        double chunk_sum;
        vDSP_sveD(buf_pv, 1, &chunk_sum, n);
        sum += chunk_sum;

        double chunk_sq;
        vDSP_dotprD(buf_pv, 1, buf_pv, 1, &chunk_sq, n);
        sum_sq += chunk_sq;

        done += n;
    }

    out_sum    = sum;
    out_sum_sq = sum_sq;
}

// ── public entry point ────────────────────────────────────────────────────────

MCResult mc_price_mt(OptionType type,
                     double     S,
                     double     K,
                     double     r,
                     double     sigma,
                     double     T,
                     long long  paths,
                     uint64_t   seed,
                     int        n_threads)
{
    if (n_threads <= 0)
        n_threads = static_cast<int>(std::thread::hardware_concurrency());
    n_threads = std::max(1, std::min(n_threads, (int)paths));

    // Per-thread accumulation (no false sharing — each element on its own cache line)
    std::vector<double> sums   (n_threads, 0.0);
    std::vector<double> sum_sqs(n_threads, 0.0);
    std::vector<std::thread> threads;
    threads.reserve(n_threads);

    long long base  = paths / n_threads;
    long long extra = paths % n_threads;

    for (int t = 0; t < n_threads; ++t) {
        long long n = base + (t < extra ? 1 : 0);
        // Golden-ratio splitmix64 step — distinct, well-separated seeds per thread
        uint64_t tseed = seed + static_cast<uint64_t>(t) * 0x9e3779b97f4a7c15ULL;
        threads.emplace_back(mc_worker,
                             type, S, K, r, sigma, T, n, tseed,
                             std::ref(sums[t]), std::ref(sum_sqs[t]));
    }
    for (auto& th : threads) th.join();

    double total_sum = 0.0, total_sq = 0.0;
    for (int t = 0; t < n_threads; ++t) {
        total_sum += sums[t];
        total_sq  += sum_sqs[t];
    }

    double N    = static_cast<double>(paths);
    double mean = total_sum / N;
    double var  = (total_sq / N - mean * mean) / N;
    return MCResult{mean, std::sqrt(std::max(var, 0.0)), paths};
}

} // namespace quantcore
