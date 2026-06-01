#include "quantcore/black_scholes_batch.hpp"

#include <Accelerate/Accelerate.h>
#include <cmath>
#include <vector>

namespace quantcore {

// ── Abramowitz-Stegun 26.2.17 batch N(x) ─────────────────────────────────────
//
// max |error| < 7.5e-8 — negligible for option pricing (impact < $0.00001).
//
// This is pure polynomial arithmetic; clang -O3 -march=native auto-vectorises
// the inner loop to NEON fmla (fused multiply-add) instructions since there
// are no inter-iteration dependencies.
//
// phi_arr must already hold φ(x) = (1/√2π)·exp(-½x²) for each element
// (we compute this separately with vvexp to use SIMD for the exp).

static inline void batch_norm_cdf(const double* __restrict__ x,
                                   const double* __restrict__ phi_arr,
                                   double*       __restrict__ y,
                                   std::size_t n)
{
    static constexpr double p  =  0.2316419;
    static constexpr double a1 =  0.319381530;
    static constexpr double a2 = -0.356563782;
    static constexpr double a3 =  1.781477937;
    static constexpr double a4 = -1.821255978;
    static constexpr double a5 =  1.330274429;

    // clang can vectorise this loop: all operations are element-wise,
    // no branches once the sign is baked into cdf_pos vs 1-cdf_pos.
    for (std::size_t i = 0; i < n; ++i) {
        double ax   = x[i] >= 0.0 ? x[i] : -x[i];
        double t    = 1.0 / (1.0 + p * ax);
        double poly = t * (a1 + t * (a2 + t * (a3 + t * (a4 + t * a5))));
        double cdf  = 1.0 - phi_arr[i] * poly;
        y[i] = x[i] >= 0.0 ? cdf : 1.0 - cdf;
    }
}

// ── batch_bs_full_accel ───────────────────────────────────────────────────────

void batch_bs_full_accel(bool        is_call,
                          const double* S,
                          const double* K,
                          const double* r,
                          const double* sigma,
                          const double* T,
                          std::size_t   n,
                          double*       out)    // (n × 5) row-major
{
    static constexpr double kInvSqrt2Pi = 0.3989422804014326779;

    int ni = static_cast<int>(n);

    // Working buffers (stack-allocated via vector; on hot path consider
    // a slab allocator, but for benchmarking this is fine).
    std::vector<double> sqrtT(n), logSK(n), d1(n), d2(n);
    std::vector<double> phi(n), disc(n), Nd1(n), Nd2(n), tmp(n);

    // ── 1. sqrtT = sqrt(T)  [SIMD via vvexp-family] ──────────────────────────
    vvsqrt(sqrtT.data(), T, &ni);

    // ── 2. log(S/K)  [SIMD via vvlog] ────────────────────────────────────────
    for (std::size_t i = 0; i < n; ++i) logSK[i] = S[i] / K[i];
    vvlog(logSK.data(), logSK.data(), &ni);

    // ── 3. d1, d2  [scalar loop — fast arithmetic, auto-vectorises] ──────────
    for (std::size_t i = 0; i < n; ++i) {
        double sigT = sigma[i] * sqrtT[i];
        d1[i] = (logSK[i] + (r[i] + 0.5 * sigma[i] * sigma[i]) * T[i]) / sigT;
        d2[i] = d1[i] - sigT;
    }

    // ── 4. φ(d1) = (1/√2π)·exp(-½d1²)  [SIMD via vvexp] ─────────────────────
    for (std::size_t i = 0; i < n; ++i) tmp[i] = -0.5 * d1[i] * d1[i];
    vvexp(phi.data(), tmp.data(), &ni);
    double c = kInvSqrt2Pi;
    vDSP_vsmulD(phi.data(), 1, &c, phi.data(), 1, n);

    // ── 5. disc = exp(-r·T)  [SIMD via vvexp] ────────────────────────────────
    for (std::size_t i = 0; i < n; ++i) tmp[i] = -r[i] * T[i];
    vvexp(disc.data(), tmp.data(), &ni);

    // ── 6. N(d1), N(d2) — A&S 26.2.17 polynomial (NEON auto-vectorised) ──────
    // Need φ(d2) for N(d2) computation — reuse the same A&S formula.
    // phi_arr argument to batch_norm_cdf needs φ(|x|) so recompute for d2.
    std::vector<double> phi_d2(n);
    for (std::size_t i = 0; i < n; ++i)
        phi_d2[i] = kInvSqrt2Pi * std::exp(-0.5 * d2[i] * d2[i]);

    batch_norm_cdf(d1.data(), phi.data(),    Nd1.data(), n);
    batch_norm_cdf(d2.data(), phi_d2.data(), Nd2.data(), n);

    // ── 7. Price + Greeks ─────────────────────────────────────────────────────
    for (std::size_t i = 0; i < n; ++i) {
        double* row = out + i * 5;
        double  gam = phi[i] / (S[i] * sigma[i] * sqrtT[i]);
        double  veg = S[i] * phi[i] * sqrtT[i];

        if (is_call) {
            row[0] = S[i]*Nd1[i] - K[i]*disc[i]*Nd2[i];
            row[1] = Nd1[i];
            row[3] = -(S[i]*phi[i]*sigma[i])/(2.0*sqrtT[i])
                     - r[i]*K[i]*disc[i]*Nd2[i];
        } else {
            double Nm1 = 1.0 - Nd1[i], Nm2 = 1.0 - Nd2[i];
            row[0] = K[i]*disc[i]*Nm2 - S[i]*Nm1;
            row[1] = Nd1[i] - 1.0;
            row[3] = -(S[i]*phi[i]*sigma[i])/(2.0*sqrtT[i])
                     + r[i]*K[i]*disc[i]*Nm2;
        }
        row[2] = gam;
        row[4] = veg;
    }
}

} // namespace quantcore
