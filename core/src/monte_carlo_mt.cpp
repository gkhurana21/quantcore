#include "quantcore/monte_carlo_mt.hpp"

#if defined(__APPLE__) && !defined(QUANTCORE_NO_ACCELERATE)
#  define QUANTCORE_USE_ACCELERATE 1
#  include <Accelerate/Accelerate.h>
#endif
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

namespace {

// Apple vForce/vDSP where available, plain loops otherwise (the compiler vectorises them; only the
// last-bit rounding of exp differs between the two).

inline void chunk_affine(double* dst, const double* src, double scale, double offset, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    vDSP_vsmsaD(src, 1, &scale, &offset, dst, 1, static_cast<vDSP_Length>(n));
#else
    for (int i = 0; i < n; ++i) dst[i] = src[i] * scale + offset;
#endif
}

inline void chunk_exp(double* dst, const double* src, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    vvexp(dst, src, &n);
#else
    for (int i = 0; i < n; ++i) dst[i] = std::exp(src[i]);
#endif
}

inline void chunk_scale(double* dst, const double* src, double c, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    vDSP_vsmulD(src, 1, &c, dst, 1, static_cast<vDSP_Length>(n));
#else
    for (int i = 0; i < n; ++i) dst[i] = src[i] * c;
#endif
}

inline void chunk_add(double* dst, const double* src, double c, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    vDSP_vsaddD(src, 1, &c, dst, 1, static_cast<vDSP_Length>(n));
#else
    for (int i = 0; i < n; ++i) dst[i] = src[i] + c;
#endif
}

/** Clamp below at `floor_value` — vDSP_vthrD's "threshold" semantics. */
inline void chunk_floor(double* dst, const double* src, double floor_value, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    vDSP_vthrD(src, 1, &floor_value, dst, 1, static_cast<vDSP_Length>(n));
#else
    for (int i = 0; i < n; ++i) dst[i] = src[i] < floor_value ? floor_value : src[i];
#endif
}

inline double chunk_sum(const double* src, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    double total;
    vDSP_sveD(src, 1, &total, static_cast<vDSP_Length>(n));
    return total;
#else
    double total = 0.0;
    for (int i = 0; i < n; ++i) total += src[i];
    return total;
#endif
}

inline double chunk_dot(const double* a, const double* b, int n) {
#ifdef QUANTCORE_USE_ACCELERATE
    double total;
    vDSP_dotprD(a, 1, b, 1, &total, static_cast<vDSP_Length>(n));
    return total;
#else
    double total = 0.0;
    for (int i = 0; i < n; ++i) total += a[i] * b[i];
    return total;
#endif
}

} // namespace

// ── per-thread worker ─────────────────────────────────────────────────────────

static void mc_worker(OptionType type,
                       double S, double K, double r,
                       double sigma, double T, double q,
                       long long paths,
                       uint64_t  seed,
                       double&   out_sum,
                       double&   out_sum_sq)
{
    std::mt19937_64 rng(seed);
    std::normal_distribution<double> dist(0.0, 1.0);

    const double drift     = (r - q - 0.5 * sigma * sigma) * T;
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
        chunk_affine(buf_st, buf_z, vol_sqrtT, drift, n);

        // 3. buf_st[i] = exp(exponent[i])  [SIMD via vvexp — NEON internally]
        chunk_exp(buf_st, buf_st, n);

        // 4. buf_st[i] *= S  (scale to terminal price)
        chunk_scale(buf_st, buf_st, S, n);

        // 5. payoff = max(ST − K, 0)  or  max(K − ST, 0)
        if (is_call) {
            chunk_add(buf_pv, buf_st, -K, n);
        } else {
            chunk_scale(buf_pv, buf_st, -1.0, n);
            chunk_add(buf_pv, buf_pv, K, n);
        }
        chunk_floor(buf_pv, buf_pv, 0.0, n);

        // 6. pv = disc * payoff
        chunk_scale(buf_pv, buf_pv, disc, n);

        // 7. Accumulate sum and sum-of-squares
        sum += chunk_sum(buf_pv, n);
        sum_sq += chunk_dot(buf_pv, buf_pv, n);

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
                     int        n_threads,
                     double     q)
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
                             type, S, K, r, sigma, T, q, n, tseed,
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
