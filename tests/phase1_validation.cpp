/*
 * QuantCore Phase 1 — Acceptance Gate
 *
 * Validates the C++ pricing core against three requirements:
 *   1. Black-Scholes prices vs published textbook values
 *   2. Analytic Greeks vs central finite-difference (bump-and-reprice)
 *   3. Monte Carlo convergence toward the Black-Scholes closed form
 *
 * No network calls, no external data, no yfinance.  Pure math only.
 */

#include "quantcore/black_scholes.hpp"
#include "quantcore/monte_carlo.hpp"
#include "quantcore/monte_carlo_mt.hpp"
#include "quantcore/monte_carlo_portfolio.hpp"
#include "quantcore/local_vol.hpp"
#include "quantcore/exotics.hpp"
#include "quantcore/lsm.hpp"
#include "quantcore/pde.hpp"
#include "quantcore/ziggurat.hpp"

#include <algorithm>
#include <vector>
#include <random>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <initializer_list>

using namespace quantcore;

// ── formatting ───────────────────────────────────────────────────────────────

static void banner(const char* title) {
    printf("\n══════════════════════════════════════════════════════════════\n");
    printf("  %s\n", title);
    printf("══════════════════════════════════════════════════════════════\n");
}

// ── Section 1: Black-Scholes prices ──────────────────────────────────────────
//
// Reference values
//   [A] Hull "Options, Futures, and Other Derivatives" 9th ed., p. 338
//       S=42, K=40, r=0.10, σ=0.20, T=0.5  →  call=4.76
//   [B] Put from same parameters via put-call parity
//       S=42, K=40, r=0.10, σ=0.20, T=0.5  →  put=0.81
//   [C] ATM 1-year call, widely tabulated
//       S=100, K=100, r=0.05, σ=0.25, T=1.0 →  call=12.34
//
// Hull's values are rounded to 2 decimal places; our erfc-based computation
// is more precise, so sub-cent residuals are rounding in the reference only.

struct BSCase {
    const char* label;
    OptionType  type;
    double S, K, r, sigma, T;
    double expected;
    const char* source;
};

static const BSCase kBSCases[] = {
    { "Hull 9e p.338 Call", OptionType::Call,  42,  40, 0.10, 0.20, 0.5,  4.76, "Hull 9e p.338" },
    { "Hull 9e p.338 Put",  OptionType::Put,   42,  40, 0.10, 0.20, 0.5,  0.81, "Hull 9e p.338" },
    { "ATM 1yr Call",       OptionType::Call, 100, 100, 0.05, 0.25, 1.0, 12.34, "Textbook ATM"  },
};

static void section_bs_prices() {
    banner("1. BLACK-SCHOLES PRICES  vs textbook reference");

    printf("  %-22s  %-4s  %9s  %9s  %9s  %s\n",
           "Case", "Type", "Computed", "Expected", "Error", "Source");
    printf("  %-22s  %-4s  %9s  %9s  %9s\n",
           "----------------------", "----",
           "---------", "---------", "---------");

    bool all_ok = true;
    for (const auto& c : kBSCases) {
        double v   = bsm_price(c.type, c.S, c.K, c.r, c.sigma, c.T);
        double err = v - c.expected;
        bool   ok  = std::fabs(err) < 0.01;
        if (!ok) all_ok = false;
        printf("  %-22s  %-4s  %9.4f  %9.4f  %+9.4f  [%s]%s\n",
               c.label,
               c.type == OptionType::Call ? "Call" : "Put",
               v, c.expected, err, c.source,
               ok ? "" : "  *** FAIL ***");
    }

    // Put-call parity sanity check on Hull case
    {
        double S=42, K=40, r=0.10, sigma=0.20, T=0.5;
        double C   = bsm_price(OptionType::Call, S, K, r, sigma, T);
        double P   = bsm_price(OptionType::Put,  S, K, r, sigma, T);
        double lhs = C - P;
        double rhs = S - K * std::exp(-r * T);
        printf("\n  Put-call parity (Hull case):  C−P = %.8f,  S−Ke^{-rT} = %.8f,  residual = %.2e\n",
               lhs, rhs, lhs - rhs);
    }

    printf("\n  %-22s  %s\n", "Overall:", all_ok ? "ALL PASS" : "FAIL — fix before proceeding");
}

// ── Section 2: Greeks analytic vs finite-difference ──────────────────────────
//
// Central-difference approximations:
//   delta_num = [V(S+h)  − V(S−h)]        / 2h       h = 0.01·S
//   gamma_num = [V(S+h)  − 2V(S) + V(S−h)] / h²      h = 0.01·S
//   theta_num = [V(T−dt) − V(T+dt)]        / 2dt      dt = 1e-4 yr (central)
//   vega_num  = [V(σ+dσ) − V(σ−dσ)]       / 2dσ      dσ = 0.001
//
// theta sign convention: dV/dt where t is calendar time (T = maturity−t
// decreases as time passes), so theta < 0 means the option loses value daily.
// Both analytic and numerical use the same convention — they must match.
//
// Tolerances: delta/gamma 1e-4, vega 1e-3, theta 5e-3 (unchanged).

struct GreeksSpec {
    const char* label;
    OptionType  type;
    double S, K, r, sigma, T;
};

static const GreeksSpec kGreeksSpecs[] = {
    { "Hull 9e Call",  OptionType::Call,  42,  40, 0.10, 0.20, 0.5 },
    { "ATM 1yr Put",   OptionType::Put,  100, 100, 0.05, 0.25, 1.0 },
};

struct NumGreeks { double delta, gamma, theta, vega; };

static NumGreeks finite_diff(OptionType type,
                              double S, double K, double r, double sigma, double T,
                              double q = 0.0) {
    const double hS  = 0.001 * S;   // 0.1% of spot
    // Theta: central difference with a 1e-4-year (~53 min) bump. The earlier
    // one-sided 1-day bump had truncation error ≈ ½·dt·|∂²V/∂T²|, which grows
    // like S·σ·T^(-3/2) — ~0.003 on the Hull case and ~0.37 on a short-dated
    // index option — so it could not verify theta at a fixed tolerance.
    // Central-difference truncation here is ~1e-6; roundoff ~ε·V/hT ~1e-10.
    const double hT  = 1.0e-4;
    const double hSg = 0.001;        // 0.1 vol-point

    double v0  = bsm_price(type, S,     K, r, sigma,       T,      q);
    double vUp = bsm_price(type, S+hS,  K, r, sigma,       T,      q);
    double vDn = bsm_price(type, S-hS,  K, r, sigma,       T,      q);
    double vTm = bsm_price(type, S,     K, r, sigma,       T - hT, q);
    double vTp = bsm_price(type, S,     K, r, sigma,       T + hT, q);
    double vVu = bsm_price(type, S,     K, r, sigma + hSg, T,      q);
    double vVd = bsm_price(type, S,     K, r, sigma - hSg, T,      q);

    NumGreeks g;
    g.delta = (vUp - vDn) / (2.0 * hS);
    g.gamma = (vUp - 2.0*v0 + vDn) / (hS * hS);
    g.theta = (vTm - vTp) / (2.0 * hT);      // −∂V/∂T ≡ ∂V/∂t
    g.vega  = (vVu - vVd) / (2.0 * hSg);
    return g;
}

static void section_greeks() {
    banner("2. GREEKS  analytic vs finite-difference (bump-and-reprice)");

    for (const auto& spec : kGreeksSpecs) {
        BSMResult  res = bsm_full(spec.type, spec.S, spec.K, spec.r, spec.sigma, spec.T);
        NumGreeks  num = finite_diff(spec.type, spec.S, spec.K, spec.r, spec.sigma, spec.T);

        printf("\n  %s  (S=%.0f  K=%.0f  r=%.2f  σ=%.2f  T=%.2f)\n",
               spec.label, spec.S, spec.K, spec.r, spec.sigma, spec.T);
        printf("  %-6s  %12s  %12s  %12s  %7s\n",
               "Greek", "Analytic", "Numerical", "Diff", "Pass?");
        printf("  %-6s  %12s  %12s  %12s\n",
               "------", "------------", "------------", "------------");

        struct Row { const char* name; double analytic; double numerical; double tol; };
        Row rows[] = {
            { "delta", res.greeks.delta, num.delta, 1e-4 },
            { "gamma", res.greeks.gamma, num.gamma, 1e-4 },
            { "theta", res.greeks.theta, num.theta, 5e-3 },
            { "vega",  res.greeks.vega,  num.vega,  1e-3 },
        };

        for (const auto& row : rows) {
            double diff = row.analytic - row.numerical;
            bool   ok   = std::fabs(diff) <= row.tol;
            printf("  %-6s  %12.6f  %12.6f  %+12.6f  %s\n",
                   row.name, row.analytic, row.numerical, diff,
                   ok ? "OK" : "*** FAIL — investigate before Phase 2 ***");
        }
    }
}

// ── Section 3: Monte Carlo convergence ───────────────────────────────────────
//
// Parameters: Hull 9e Call (S=42 K=40 r=0.10 σ=0.20 T=0.5)
// Theory: MC std-error ∝ 1/√N  →  each 10× path increase shrinks error ~3.16×.
// |Error|/SE should be O(1) at every row — large values indicate a bias.

static void section_mc_convergence() {
    banner("3. MONTE CARLO CONVERGENCE  (Hull 9e Call: S=42 K=40 r=0.10 σ=0.20 T=0.5)");

    const double S=42, K=40, r=0.10, sigma=0.20, T=0.5;
    const double bs = bsm_price(OptionType::Call, S, K, r, sigma, T);
    printf("  Black-Scholes closed-form: %.6f\n\n", bs);

    printf("  %-10s  %10s  %10s  %10s  %10s\n",
           "Paths", "MC Price", "Std Error", "Error", "|Err|/SE");
    printf("  %-10s  %10s  %10s  %10s  %10s\n",
           "----------", "----------", "----------", "----------", "----------");

    for (long long n : { 10'000LL, 100'000LL, 1'000'000LL }) {
        MCResult mc  = mc_price(OptionType::Call, S, K, r, sigma, T, n, /*seed=*/42);
        double   err = mc.price - bs;
        double   z   = std::fabs(err) / mc.std_error;
        printf("  %-10lld  %10.5f  %10.5f  %+10.5f  %10.2f\n",
               n, mc.price, mc.std_error, err, z);
    }

    printf("\n  Each row should show ~3× error reduction and |Err|/SE ≈ O(1).\n");
}

// ── Section 4: continuous dividend yield (Black-Scholes-Merton) ──────────────
//
// Reference: Hull, "Options, Futures, and Other Derivatives" — European call on
// a stock index: S=930, K=900, r=0.08, q=0.03, σ=0.20, T=2/12  →  call = 51.83.
// Plus put-call parity with dividends (C − P = S·e^{-qT} − K·e^{-rT}), Greeks vs
// finite differences with the same bumps/tolerances as section 2, and Monte
// Carlo (scalar and multithreaded) converging within 3 standard errors.

static void section_dividend_yield() {
    banner("4. DIVIDEND YIELD  (Hull index call: S=930 K=900 r=0.08 q=0.03 σ=0.20 T=2/12)");

    const double S=930, K=900, r=0.08, q=0.03, sigma=0.20, T=2.0/12.0;
    bool all_ok = true;

    double call = bsm_price(OptionType::Call, S, K, r, sigma, T, q);
    double put  = bsm_price(OptionType::Put,  S, K, r, sigma, T, q);
    bool price_ok = std::fabs(call - 51.83) < 0.01;
    all_ok = all_ok && price_ok;
    printf("  Call price:  computed %.4f  expected 51.83  error %+.4f  %s\n",
           call, call - 51.83, price_ok ? "OK" : "*** FAIL ***");

    double parity = (call - put) - (S * std::exp(-q * T) - K * std::exp(-r * T));
    bool parity_ok = std::fabs(parity) < 1e-10;
    all_ok = all_ok && parity_ok;
    printf("  Put-call parity with q:  residual %.2e  %s\n", parity, parity_ok ? "OK" : "*** FAIL ***");

    for (OptionType type : { OptionType::Call, OptionType::Put }) {
        BSMResult res = bsm_full(type, S, K, r, sigma, T, q);
        NumGreeks num = finite_diff(type, S, K, r, sigma, T, q);
        struct Row { const char* name; double analytic; double numerical; double tol; };
        Row rows[] = {
            { "delta", res.greeks.delta, num.delta, 1e-4 },
            { "gamma", res.greeks.gamma, num.gamma, 1e-4 },
            { "theta", res.greeks.theta, num.theta, 5e-3 },
            { "vega",  res.greeks.vega,  num.vega,  1e-3 },
        };
        printf("\n  %s with q — Greeks analytic vs finite-difference\n",
               type == OptionType::Call ? "Call" : "Put");
        for (const auto& row : rows) {
            double diff = row.analytic - row.numerical;
            bool   ok   = std::fabs(diff) <= row.tol;
            all_ok = all_ok && ok;
            printf("  %-6s  %12.6f  %12.6f  %+12.6f  %s\n",
                   row.name, row.analytic, row.numerical, diff, ok ? "OK" : "*** FAIL ***");
        }
    }

    printf("\n  Monte Carlo with q (seed 42)\n");
    for (long long n : { 100'000LL, 1'000'000LL }) {
        MCResult mc   = mc_price(OptionType::Call, S, K, r, sigma, T, n, 42, q);
        MCResult mcmt = mc_price_mt(OptionType::Call, S, K, r, sigma, T, n, 42, -1, q);
        double z   = std::fabs(mc.price - call) / mc.std_error;
        double zmt = std::fabs(mcmt.price - call) / mcmt.std_error;
        bool ok = z < 3.0 && zmt < 3.0;
        all_ok = all_ok && ok;
        printf("  %-9lld  scalar %9.4f ± %.4f (|z| %.2f)   mt %9.4f ± %.4f (|z| %.2f)  %s\n",
               n, mc.price, mc.std_error, z, mcmt.price, mcmt.std_error, zmt, ok ? "OK" : "*** FAIL ***");
    }

    printf("\n  %-22s  %s\n", "Dividend yield overall:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 5: portfolio Monte Carlo ─────────────────────────────────────────
//
// An iron condor with its own volatility per strike (a skew) plus a longer-dated call: the
// estimate must sit within 3 standard errors of the sum of Black-Scholes leg values at those
// volatilities, the multithreaded kernel must reproduce the scalar one exactly on one thread,
// a single leg must agree with mc_price on the same seed, and antithetic variates must cut
// the standard error for a monotone payoff (for a condor they need not).

static void section_portfolio_mc() {
    banner("5. PORTFOLIO MONTE CARLO  (skewed iron condor + 6-month call, S=756.48 r=0.045 q=0.01)");

    const double S = 756.48, r = 0.045, q = 0.01;
    const PortfolioLeg legs[] = {
        { OptionType::Put,  715.0, 0.129, 0.181, +1000.0 },
        { OptionType::Put,  735.0, 0.129, 0.162, -1000.0 },
        { OptionType::Call, 775.0, 0.129, 0.125, -1000.0 },
        { OptionType::Call, 795.0, 0.129, 0.109, +1000.0 },
        { OptionType::Call, 760.0, 0.500, 0.140,  +500.0 },
    };
    const std::size_t n = sizeof(legs) / sizeof(legs[0]);
    double bs = 0.0;
    for (const auto& l : legs) bs += l.weight * bsm_price(l.type, S, l.K, r, l.sigma, l.T, q);
    printf("  Black-Scholes sum of legs: %.4f\n\n", bs);
    bool all_ok = true;

    for (long long paths : { 200'000LL, 2'000'000LL }) {
        MCResult plain = mc_portfolio(legs, n, S, r, q, paths, 42, false);
        MCResult anti  = mc_portfolio(legs, n, S, r, q, paths, 42, true);
        double zp = std::fabs(plain.price - bs) / plain.std_error;
        double za = std::fabs(anti.price - bs) / anti.std_error;
        bool ok = zp < 3.0 && za < 3.0;
        all_ok = all_ok && ok;
        printf("  %-9lld  plain %10.4f ± %.4f (|z| %.2f)   antithetic %10.4f ± %.4f (|z| %.2f)  %s\n",
               paths, plain.price, plain.std_error, zp, anti.price, anti.std_error, za, ok ? "OK" : "*** FAIL ***");
    }

    MCResult one = mc_portfolio(legs, n, S, r, q, 300'000, 7, true);
    MCResult mt1 = mc_portfolio_mt(legs, n, S, r, q, 300'000, 7, true, 1);
    MCResult mt  = mc_portfolio_mt(legs, n, S, r, q, 2'000'000, 7, false, -1);
    bool same = one.price == mt1.price && one.std_error == mt1.std_error && one.paths == mt1.paths;
    double zmt = std::fabs(mt.price - bs) / mt.std_error;
    bool mt_ok = same && zmt < 3.0;
    all_ok = all_ok && mt_ok;
    printf("  multithreaded: one thread %s the scalar kernel · all threads %.4f ± %.4f (|z| %.2f)  %s\n",
           same ? "reproduces" : "DIFFERS FROM", mt.price, mt.std_error, zmt, mt_ok ? "OK" : "*** FAIL ***");

    const PortfolioLeg call[] = { { OptionType::Call, 40.0, 0.5, 0.2, 1.0 } };
    MCResult port = mc_portfolio(call, 1, 42.0, 0.10, 0.0, 1'000'000, 42, false);
    MCResult ref  = mc_price(OptionType::Call, 42.0, 40.0, 0.10, 0.2, 0.5, 1'000'000, 42);
    MCResult anti = mc_portfolio(call, 1, 42.0, 0.10, 0.0, 1'000'000, 42, true);
    double rel = std::fabs(port.price - ref.price) / ref.price;
    bool single_ok = rel < 1e-12 && anti.std_error < port.std_error;
    all_ok = all_ok && single_ok;
    printf("  single call vs mc_price (seed 42): %.10f vs %.10f (rel %.1e) · antithetic SE %.5f < %.5f  %s\n",
           port.price, ref.price, rel, anti.std_error, port.std_error, single_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "Portfolio MC overall:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 6: Local volatility ──────────────────────────────────────────────
//
// The SSVI surface (equity-index smile × upward ATM term structure, as in the dashboard presets) and the
// Dupire local volatility it implies. Local vol is checked against Dupire's formula evaluated by finite
// differences of the surface's own call prices; the local-vol Monte Carlo must reprice the portfolio at each
// leg's implied volatility.

static double surface_value(const PortfolioLeg* legs, std::size_t n, const VolSurface& s) {
    double v = 0.0;
    for (std::size_t j = 0; j < n; ++j)
        v += legs[j].weight * bsm_price(legs[j].type, s.S, legs[j].K, s.r, implied_vol(s, legs[j].K, legs[j].T), legs[j].T, s.q);
    return v;
}

static void section_local_vol() {
    banner("6. LOCAL VOLATILITY  (SSVI smile x ATM term structure -> Dupire)");

    bool all_ok = true;

    // The simulation's normal variates: 128-layer ziggurat (quantcore/ziggurat.hpp). Bounds fixed in advance:
    // 4 standard errors for the moments and tail frequencies, and 1.95/√N (Kolmogorov 99.9%) for the CDF gap.
    {
        const long long N = 20'000'000;
        std::mt19937_64 rng(2024);
        const double R = 3.442619855899;
        const int G = 81;
        long long below[81] = {};
        double m1 = 0.0, m2 = 0.0;
        long long beyond2 = 0, beyondR = 0;
        using clk = std::chrono::steady_clock;
        auto t0 = clk::now();
        for (long long i = 0; i < N; ++i) {
            const double z = normal_ziggurat(rng);
            m1 += z;
            m2 += z * z;
            beyond2 += std::fabs(z) > 2.0;
            beyondR += std::fabs(z) > R;
            const int g = static_cast<int>(std::floor((z + 4.0) * 10.0)) + 1;   // grid x_g = −4 + g/10
            if (g <= 0) ++below[0]; else if (g < G) ++below[g];
        }
        const double ns = std::chrono::duration<double, std::nano>(clk::now() - t0).count() / static_cast<double>(N);
        std::mt19937_64 rng2(2024);
        std::normal_distribution<double> nd(0.0, 1.0);
        t0 = clk::now();
        double sink = 0.0;
        for (long long i = 0; i < N; ++i) sink += nd(rng2);
        const double ns_std = std::chrono::duration<double, std::nano>(clk::now() - t0).count() / static_cast<double>(N);
        const double n = static_cast<double>(N);
        const double mean = m1 / n, var = m2 / n - mean * mean;
        auto Phi = [](double x) { return 0.5 * std::erfc(-x / std::sqrt(2.0)); };
        const double p2 = 2.0 * (1.0 - Phi(2.0)), pR = 2.0 * (1.0 - Phi(R));
        double gap = 0.0;
        long long cum = 0;
        for (int g = 0; g < G; ++g) {
            cum += below[g];
            gap = std::max(gap, std::fabs(static_cast<double>(cum) / n - Phi(-4.0 + g / 10.0)));
        }
        const bool zig_ok = std::fabs(mean) < 4.0 / std::sqrt(n) && std::fabs(var - 1.0) < 4.0 * std::sqrt(2.0 / n) &&
                            std::fabs(beyond2 / n - p2) < 4.0 * std::sqrt(p2 * (1 - p2) / n) &&
                            std::fabs(beyondR / n - pR) < 4.0 * std::sqrt(pR * (1 - pR) / n) && gap < 1.95 / std::sqrt(n);
        all_ok = all_ok && zig_ok;
        printf("  ziggurat normals, 20M draws: mean %+.1e · var %.5f · P(|Z|>2) %.5f vs %.5f · P(|Z|>R) %.2e vs %.2e · CDF gap %.1e\n",
               mean, var, beyond2 / n, p2, beyondR / n, pR, gap);
        printf("    %.1f ns a draw vs %.1f ns for std::normal_distribution (sink %.1f)  %s\n",
               ns, ns_std, sink, zig_ok ? "OK" : "*** FAIL ***");
    }

    VolSurface s;
    s.S = 756.48; s.r = 0.045; s.q = 0.01; s.sigma = 0.138;
    s.smile = true; s.rho = -0.7; s.eta = 1.0; s.gamma = 0.45;
    s.term = TermKind::Curve; s.ratio = 0.5; s.half_life = 0.15;

    // σ is the 30-day ATM-forward implied volatility
    const double T30 = 30.0 / 365.0, F30 = s.S * std::exp((s.r - s.q) * T30);
    const double iv30 = implied_vol(s, F30, T30);
    const bool atm_ok = std::fabs(iv30 - s.sigma) < 1e-12;
    all_ok = all_ok && atm_ok;
    printf("  30-day ATM-forward implied vol %.15f vs sigma %.3f  %s\n", iv30, s.sigma, atm_ok ? "OK" : "*** FAIL ***");

    // Dupire from call prices: σ² = (∂C/∂T + (r − q)·K·∂C/∂K + q·C) / (½·K²·∂²C/∂K²), Richardson-extrapolated
    // central differences with strike steps scaled to K·σ·√T
    double worst = 0.0;
    for (double T : { 0.1, 0.5, 1.5 }) {
        const double F = s.S * std::exp((s.r - s.q) * T);
        const double sd = implied_vol(s, F, T) * std::sqrt(T);
        for (double x : { -1.0, -0.5, 0.0, 0.5, 1.0 }) {
            const double K = F * std::exp(x * sd);
            auto C = [&s](double k, double t) { return bsm_price(OptionType::Call, s.S, k, s.r, implied_vol(s, k, t), t, s.q); };
            auto rich = [](auto f, double h) { return (4.0 * f(h / 2) - f(h)) / 3.0; };
            const double width = K * implied_vol(s, K, T) * std::sqrt(T), hK = 1e-3 * width, hT = 1e-3 * T;
            const double dT  = rich([&](double h) { return (C(K, T + h) - C(K, T - h)) / (2 * h); }, hT);
            const double dK  = rich([&](double h) { return (C(K + h, T) - C(K - h, T)) / (2 * h); }, hK);
            const double dKK = rich([&](double h) { return (C(K + h, T) - 2 * C(K, T) + C(K - h, T)) / (h * h); }, 20 * hK);
            const double dupire = (dT + (s.r - s.q) * K * dK + s.q * C(K, T)) / (0.5 * K * K * dKK);
            const double lv = local_vol(s, K, T);
            worst = std::max(worst, std::fabs(lv * lv - dupire) / dupire);
        }
    }
    const bool dupire_ok = worst < 1e-4;
    all_ok = all_ok && dupire_ok;
    printf("  local vol vs Dupire from call prices: worst relative error %.2e over 15 strikes x expiries  %s\n",
           worst, dupire_ok ? "OK" : "*** FAIL ***");

    // no smile: local vol depends on time only and each step's variance is integrated exactly
    VolSurface term_only = s;
    term_only.smile = false;
    const PortfolioLeg spread[] = {
        { OptionType::Call, 780.0, 0.1, 0.0, 100.0 },
        { OptionType::Put,  720.0, 0.6, 0.0, 100.0 },
        { OptionType::Call, 760.0, 1.7, 0.0, 100.0 },
    };
    const double ref_t = surface_value(spread, 3, term_only);
    const LocalVolResult ex = mc_local_vol(spread, 3, term_only, 400'000, 11, 4.0, false);
    const double zex = std::fabs(ex.price - ref_t) / ex.std_error;
    const bool exact_ok = zex < 3.0 && std::isnan(ex.fine_bias);
    all_ok = all_ok && exact_ok;
    printf("  term structure only, 4 steps a year: %.4f ± %.4f vs %.4f (|z| %.2f)  %s\n",
           ex.price, ex.std_error, ref_t, zex, exact_ok ? "OK" : "*** FAIL ***");

    // smile + term: SPY iron condor at 47 days plus a 6-month call — plain log-Euler against coupled Richardson
    const PortfolioLeg book[] = {
        { OptionType::Put,  715.0, 0.129, 0.0, +1000.0 },
        { OptionType::Put,  735.0, 0.129, 0.0, -1000.0 },
        { OptionType::Call, 775.0, 0.129, 0.0, -1000.0 },
        { OptionType::Call, 795.0, 0.129, 0.0, +1000.0 },
        { OptionType::Call, 760.0, 0.500, 0.0,  +500.0 },
    };
    const std::size_t nb = sizeof(book) / sizeof(book[0]);
    const double ref = surface_value(book, nb, s);
    printf("  surface value of the book (Black-Scholes at each leg's implied vol): %.4f\n", ref);
    using clock = std::chrono::steady_clock;
    auto t0 = clock::now();
    const LocalVolResult eu = mc_local_vol(book, nb, s, 400'000, 7, 365.0, false);
    const double ms_eu = std::chrono::duration<double, std::milli>(clock::now() - t0).count();
    t0 = clock::now();
    const LocalVolResult ri = mc_local_vol(book, nb, s, 400'000, 7, 365.0, true);
    const double ms_ri = std::chrono::duration<double, std::milli>(clock::now() - t0).count();
    const double zeu = (eu.price - ref) / eu.std_error, zri = (ri.price - ref) / ri.std_error;
    const bool rich_ok = std::fabs(zri) < 3.0 && ri.steps == 2 * eu.steps;
    all_ok = all_ok && rich_ok;
    printf("  log-Euler  %lld steps: %.4f ± %.4f (z %+.2f) · %.0f ms\n", eu.steps, eu.price, eu.std_error, zeu, ms_eu);
    printf("  Richardson %lld steps: %.4f ± %.4f (z %+.2f) · fine-grid bias estimate %+.4f · %.0f ms  %s\n",
           ri.steps, ri.price, ri.std_error, zri, ri.fine_bias, ms_ri, rich_ok ? "OK" : "*** FAIL ***");

    // multithreaded: one thread reproduces the scalar kernel exactly
    const LocalVolResult one = mc_local_vol(book, nb, s, 50'000, 3, 365.0, true);
    const LocalVolResult mt1 = mc_local_vol_mt(book, nb, s, 50'000, 3, 365.0, true, 1);
    t0 = clock::now();
    const LocalVolResult mt = mc_local_vol_mt(book, nb, s, 2'000'000, 3, 365.0, true, -1);
    const double ms_mt = std::chrono::duration<double, std::milli>(clock::now() - t0).count();
    const bool same = one.price == mt1.price && one.std_error == mt1.std_error && one.fine_bias == mt1.fine_bias;
    const double zmt = (mt.price - ref) / mt.std_error;
    const bool mt_ok = same && std::fabs(zmt) < 3.0;
    all_ok = all_ok && mt_ok;
    printf("  multithreaded: one thread %s the scalar kernel · 2M Richardson paths %.4f ± %.4f (z %+.2f) in %.0f ms  %s\n",
           same ? "reproduces" : "DIFFERS FROM", mt.price, mt.std_error, zmt, ms_mt, mt_ok ? "OK" : "*** FAIL ***");

    // a flat surface is Black-Scholes; invalid inputs are rejected
    VolSurface flat;
    flat.S = 42.0; flat.r = 0.10; flat.sigma = 0.2;
    const PortfolioLeg hull[] = { { OptionType::Call, 40.0, 0.5, 0.0, 1.0 } };
    const LocalVolResult fl = mc_local_vol(hull, 1, flat, 400'000, 5, 12.0, true);
    const double bs_hull = bsm_price(OptionType::Call, 42.0, 40.0, 0.10, 0.2, 0.5, 0.0);
    const double zfl = std::fabs(fl.price - bs_hull) / fl.std_error;
    VolSurface bad = s;
    bad.eta = -1.0;
    const bool flat_ok = zfl < 3.0 && local_vol(flat, 30.0, 0.3) == 0.2 && implied_vol(flat, 50.0, 1.0) == 0.2 &&
                         std::isnan(mc_local_vol(book, nb, bad, 1000, 1, 365.0, true).price) &&
                         std::isnan(mc_local_vol(book, nb, s, 1000, 1, 1e7, false).price);
    all_ok = all_ok && flat_ok;
    printf("  flat surface: Hull call %.4f ± %.4f vs %.4f (|z| %.2f) · invalid surface and oversized grid → NaN  %s\n",
           fl.price, fl.std_error, bs_hull, zfl, flat_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "Local volatility:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 7: Exotics ───────────────────────────────────────────────────────
//
// Barrier options (continuous monitoring through Brownian-bridge survival weights) and Asian options, against the
// closed forms under flat volatility, then under local volatility. Several z-scores are checked per case, so the
// bound is 4 standard errors, fixed in advance.

static double zscore(double v, double ref, double se) {
    return se > 0.0 ? std::fabs(v - ref) / se : (std::fabs(v - ref) < 1e-12 ? 0.0 : INFINITY);
}

static void section_exotics() {
    banner("7. EXOTICS  (barrier and Asian options: closed forms, bridge Monte Carlo, local volatility)");
    bool all_ok = true;
    using clk = std::chrono::steady_clock;

    // flat GBM: the bridge weight is exact, so one step per half year is enough
    VolSurface flat;
    flat.S = 100.0; flat.r = 0.08; flat.q = 0.04; flat.sigma = 0.25;
    struct Case { OptionType type; bool up; double K; double levels[3]; const char* name; };
    const Case cases[] = {
        { OptionType::Call, false, 100.0, { 85.0, 92.0, 97.0 }, "down call" },
        { OptionType::Put,  true,  100.0, { 103.0, 108.0, 115.0 }, "up put" },
        { OptionType::Call, true,   95.0, { 105.0, 115.0, 130.0 }, "up call" },
        { OptionType::Put,  false, 105.0, { 80.0, 90.0, 98.0 }, "down put" },
    };
    double worst = 0.0;
    for (const Case& c : cases) {
        ExoticSpec e;
        e.kind = ExoticKind::Barrier; e.type = c.type; e.K = c.K; e.T = 0.5; e.up = c.up; e.n_levels = 3;
        std::copy(c.levels, c.levels + 3, e.levels);
        const ExoticResult r = mc_exotic(e, flat, 400'000, 21, 2.0, true);
        for (int j = 0; j < 3; ++j) {
            const BarrierPrices cf = barrier_prices(c.type, c.up, 100.0, c.K, c.levels[j], 0.5, 0.25, 0.08, 0.04);
            worst = std::max({ worst, zscore(r.out[j], cf.out, r.out_se[j]), zscore(r.in[j], cf.in, r.in_se[j]) });
        }
        worst = std::max(worst, zscore(r.vanilla, bsm_price(c.type, 100.0, c.K, 0.08, 0.25, 0.5, 0.04), r.vanilla_se));
    }
    const bool bridge_ok = worst < 4.0;
    all_ok = all_ok && bridge_ok;
    printf("  flat GBM, 4 barrier types x 3 levels, knock-out and knock-in (1 step): worst |z| vs closed form %.2f  %s\n",
           worst, bridge_ok ? "OK" : "*** FAIL ***");

    // exact monitoring: one step and daily steps price the same barrier
    ExoticSpec d;
    d.kind = ExoticKind::Barrier; d.type = OptionType::Call; d.K = 100.0; d.T = 0.5; d.n_levels = 1; d.levels[0] = 92.0;
    const ExoticResult d1 = mc_exotic(d, flat, 400'000, 5, 2.0, true), d365 = mc_exotic(d, flat, 400'000, 6, 365.0, true);
    const double zd = std::fabs(d1.out[0] - d365.out[0]) / std::hypot(d1.out_se[0], d365.out_se[0]);
    const bool steps_ok = zd < 4.0 && d365.steps == 183;
    all_ok = all_ok && steps_ok;
    printf("  down-and-out call H=92: 1 step %.4f ± %.4f · 183 steps %.4f ± %.4f (|z| %.2f)  %s\n",
           d1.out[0], d1.out_se[0], d365.out[0], d365.out_se[0], zd, steps_ok ? "OK" : "*** FAIL ***");

    // Asian under flat GBM: geometric vs closed form, arithmetic ≥ geometric, geometric control variate
    ExoticSpec a;
    a.kind = ExoticKind::Asian; a.type = OptionType::Call; a.K = 100.0; a.T = 1.0; a.n_fixings = 12;
    const ExoticResult ra = mc_exotic(a, flat, 400'000, 7, 12.0, true);
    const double gcf = geometric_asian_price(OptionType::Call, 100.0, 100.0, 1.0, 12, 0.25, 0.08, 0.04);
    const double N = static_cast<double>(ra.paths);
    const double var_a = ra.arith_se * ra.arith_se * N, var_g = ra.geo_se * ra.geo_se * N;
    const double beta = ra.arith_geo_cov / var_g;
    const double cv = ra.arith - beta * (ra.geo - gcf);
    const double se_cv = std::sqrt(std::max(var_a - ra.arith_geo_cov * ra.arith_geo_cov / var_g, 0.0) / N);
    const double zg = zscore(ra.geo, gcf, ra.geo_se);
    const bool asian_ok = zg < 4.0 && ra.arith >= ra.geo && ra.arith_se / se_cv > 5.0 && ra.steps == 12;
    all_ok = all_ok && asian_ok;
    printf("  Asian call, 12 fixings: geometric %.4f ± %.4f vs %.4f (|z| %.2f) · arithmetic %.4f ± %.4f → with control variate %.4f ± %.5f (SE %.0fx smaller)  %s\n",
           ra.geo, ra.geo_se, gcf, zg, ra.arith, ra.arith_se, cv, se_cv, ra.arith_se / se_cv, asian_ok ? "OK" : "*** FAIL ***");

    // local volatility: the vanilla on the same paths reprices at σ(K, T); the barrier does not match flat vol at σ(K, T)
    VolSurface lv;
    lv.S = 756.48; lv.r = 0.045; lv.q = 0.0; lv.sigma = 0.138;
    lv.smile = true; lv.rho = -0.7; lv.eta = 1.0; lv.gamma = 0.45;
    lv.term = TermKind::Curve; lv.ratio = 0.5; lv.half_life = 0.15;
    ExoticSpec b;
    b.kind = ExoticKind::Barrier; b.type = OptionType::Call; b.K = 755.0; b.T = 0.25; b.n_levels = 3;
    b.levels[0] = 680.0; b.levels[1] = 700.0; b.levels[2] = 720.0;
    auto t0 = clk::now();
    const ExoticResult rl = mc_exotic(b, lv, 400'000, 9, 365.0, true);
    const double ms_lv = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
    const double vol_k = implied_vol(lv, 755.0, 0.25);
    const double bs_van = bsm_price(OptionType::Call, lv.S, 755.0, lv.r, vol_k, 0.25, lv.q);
    const double zv = (rl.vanilla - bs_van) / rl.vanilla_se;
    const bool lv_ok = std::fabs(zv) < 4.0 && rl.steps == 184;
    all_ok = all_ok && lv_ok;
    printf("  local vol (equity smile, upward term), 755 call 91d: vanilla %.4f ± %.4f vs BS at σ(K) %.2f%% %.4f (z %+.2f), %lld steps, %.0f ms  %s\n",
           rl.vanilla, rl.vanilla_se, vol_k * 100, bs_van, zv, rl.steps, ms_lv, lv_ok ? "OK" : "*** FAIL ***");
    for (int j = 0; j < 3; ++j) {
        const BarrierPrices cf = barrier_prices(OptionType::Call, false, lv.S, 755.0, b.levels[j], 0.25, vol_k, lv.r, lv.q);
        printf("    down-and-out H=%.0f: local vol %.4f ± %.4f vs flat σ(K) %.4f — %+.1f SE (fine-grid bias %+.4f)\n",
               b.levels[j], rl.out[j], rl.out_se[j], cf.out, (rl.out[j] - cf.out) / rl.out_se[j], rl.out_fine_bias[j]);
    }

    // threads: one thread reproduces the scalar kernel exactly
    const ExoticResult one = mc_exotic(b, lv, 20'000, 3, 365.0, true);
    const ExoticResult mt1 = mc_exotic_mt(b, lv, 20'000, 3, 365.0, true, 1);
    t0 = clk::now();
    const ExoticResult mt = mc_exotic_mt(b, lv, 2'000'000, 3, 365.0, true, -1);
    const double ms_mt = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
    const bool same = one.vanilla == mt1.vanilla && one.out[1] == mt1.out[1] && one.out_se[1] == mt1.out_se[1] &&
                      one.in[2] == mt1.in[2];
    const bool mt_ok = same && std::fabs((mt.vanilla - bs_van) / mt.vanilla_se) < 4.0;
    all_ok = all_ok && mt_ok;
    printf("  multithreaded: one thread %s the scalar kernel · 2M paths in %.0f ms, vanilla z %+.2f  %s\n",
           same ? "reproduces" : "DIFFERS FROM", ms_mt, (mt.vanilla - bs_van) / mt.vanilla_se, mt_ok ? "OK" : "*** FAIL ***");

    // invalid specifications are rejected
    ExoticSpec bad_levels = b; bad_levels.n_levels = 0;
    ExoticSpec bad_fix = a; bad_fix.n_fixings = 0;
    const bool invalid_ok = std::isnan(mc_exotic(bad_levels, lv, 100, 1, 365.0, true).vanilla) &&
                            std::isnan(mc_exotic(bad_fix, flat, 100, 1, 12.0, true).arith);
    all_ok = all_ok && invalid_ok;
    printf("  no barrier levels, no fixings → NaN  %s\n", invalid_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "Exotics:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 8: local-volatility PDE ─────────────────────────────────────────
//
// Finite differences on the local-volatility PDE against the closed forms and a 20,000-step binomial lattice under flat
// volatility; Dupire consistency under the smile (a local-volatility model must reprice its surface's vanillas —
// here with no Monte Carlo noise to hide behind); and the barrier Monte Carlo kernel under local volatility.
// Tolerances fixed before the first run.

// American option on a Cox-Ross-Rubinstein lattice, an independent reference for the PDE's early exercise.
static double crr_american(OptionType type, double S, double K, double T, double sigma, double r, double q, int n) {
    const double dt = T / n, lnu = sigma * std::sqrt(dt), u = std::exp(lnu), d = 1.0 / u;
    const double p = (std::exp((r - q) * dt) - d) / (u - d), disc = std::exp(-r * dt);
    const double pu = disc * p, pd = disc * (1.0 - p);
    auto exercise = [type, K](double spot) { return type == OptionType::Call ? std::max(spot - K, 0.0) : std::max(K - spot, 0.0); };
    std::vector<double> level(2 * static_cast<std::size_t>(n) + 1), v(static_cast<std::size_t>(n) + 1);
    for (int k = -n; k <= n; ++k) level[static_cast<std::size_t>(k + n)] = S * std::exp(k * lnu);
    for (int i = 0; i <= n; ++i) v[static_cast<std::size_t>(i)] = exercise(level[static_cast<std::size_t>(2 * n - 2 * i)]);
    for (int step = n - 1; step >= 0; --step) {
        for (int i = 0; i <= step; ++i) {
            const double cont = pu * v[static_cast<std::size_t>(i)] + pd * v[static_cast<std::size_t>(i + 1)];
            v[static_cast<std::size_t>(i)] = std::max(cont, exercise(level[static_cast<std::size_t>(step - 2 * i + n)]));
        }
    }
    return v[0];
}

static void section_pde() {
    banner("8. LOCAL-VOLATILITY PDE  (graded BDF2, policy iteration: European, American, knock-out, grid Greeks)");
    bool all_ok = true;
    using clk = std::chrono::steady_clock;

    // European vs Black-Scholes: relative error at three grids (second order: each doubling divides it by ~4), Greeks
    VolSurface flat;
    flat.S = 100.0; flat.r = 0.05; flat.q = 0.02; flat.sigma = 0.25;
    const int grids[3][2] = { { 201, 200 }, { 401, 400 }, { 801, 800 } };
    double err[3] = { 0.0, 0.0, 0.0 }, d_err = 0.0, g_err = 0.0, t_err = 0.0;
    for (OptionType type : { OptionType::Call, OptionType::Put }) {
        for (double K : { 90.0, 100.0, 110.0 }) {
            PdeSpec e;
            e.type = type; e.K = K; e.T = 1.0;
            const BSMResult bs = bsm_full(type, 100.0, K, 0.05, 0.25, 1.0, 0.02);
            for (int g = 0; g < 3; ++g) {
                const PdeResult p = pde_price(e, flat, grids[g][0], grids[g][1]);
                err[g] = std::max(err[g], std::fabs(p.price - bs.price) / bs.price);
                if (g == 2) {
                    d_err = std::max(d_err, std::fabs(p.delta - bs.greeks.delta));
                    g_err = std::max(g_err, std::fabs(p.gamma - bs.greeks.gamma) / bs.greeks.gamma);
                    t_err = std::max(t_err, std::fabs(p.theta - bs.greeks.theta) / std::fabs(bs.greeks.theta));
                }
            }
        }
    }
    const bool euro_ok = err[2] < 2e-4 && err[1] / err[2] > 3.0 && err[0] / err[1] > 3.0;
    const bool greeks_ok = d_err < 1e-4 && g_err < 1e-3 && t_err < 1e-3;
    all_ok = all_ok && euro_ok && greeks_ok;
    printf("  European calls and puts K 90/100/110, 1y: worst relative error %.2e (201) → %.2e (401) → %.2e (801), ratios %.1f, %.1f  %s\n",
           err[0], err[1], err[2], err[0] / err[1], err[1] / err[2], euro_ok ? "OK" : "*** FAIL ***");
    printf("  grid Greeks at 801 × 800: |Δ − Δ_BS| %.1e, Γ relative %.1e, Θ relative %.1e  %s\n",
           d_err, g_err, t_err, greeks_ok ? "OK" : "*** FAIL ***");

    // American put, Hull's example (S = K = 50, r = 10%, σ = 40%, 5 months), against a 20,000-step lattice
    VolSurface hull;
    hull.S = 50.0; hull.r = 0.10; hull.q = 0.0; hull.sigma = 0.40;
    PdeSpec am;
    am.kind = PdeKind::American; am.type = OptionType::Put; am.K = 50.0; am.T = 5.0 / 12.0;
    auto t0 = clk::now();
    const PdeResult pa = pde_price(am, hull, 801, 800);
    const double ms_am = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
    const double crr = 0.5 * (crr_american(OptionType::Put, 50.0, 50.0, 5.0 / 12.0, 0.40, 0.10, 0.0, 20000) +
                              crr_american(OptionType::Put, 50.0, 50.0, 5.0 / 12.0, 0.40, 0.10, 0.0, 20001));
    PdeSpec eu = am;
    eu.kind = PdeKind::European;
    const PdeResult pe = pde_price(eu, hull, 801, 800);
    bool boundary_ok = pa.n_boundary == 64;
    for (int j = 0; j < pa.n_boundary; ++j) {
        boundary_ok = boundary_ok && pa.boundary_S[j] < 50.0 && (j == 0 || pa.boundary_S[j] <= pa.boundary_S[j - 1]);
    }
    const bool am_ok = std::fabs(pa.price - crr) < 2e-3 && pa.price > pe.price && boundary_ok;
    all_ok = all_ok && am_ok;
    printf("  American put (Hull): PDE %.4f vs lattice %.4f (|diff| %.1e) · European %.4f · boundary %.2f (1 step) → %.2f (5 months), %d samples · %.1f ms  %s\n",
           pa.price, crr, std::fabs(pa.price - crr), pe.price, pa.boundary_S[0], pa.boundary_S[pa.n_boundary - 1],
           pa.n_boundary, ms_am, am_ok ? "OK" : "*** FAIL ***");

    // American calls: no dividends → never exercised (equals European); an 8% yield → exercised, above the strike
    PdeSpec ac;
    ac.kind = PdeKind::American; ac.type = OptionType::Call; ac.K = 100.0; ac.T = 1.0;
    PdeSpec ec = ac;
    ec.kind = PdeKind::European;
    VolSurface nodiv = flat, div = flat;
    nodiv.q = 0.0; div.q = 0.08;
    const PdeResult c0 = pde_price(ac, nodiv, 801, 800), e0 = pde_price(ec, nodiv, 801, 800);
    const PdeResult c8 = pde_price(ac, div, 801, 800), e8 = pde_price(ec, div, 801, 800);
    const double crr8 = 0.5 * (crr_american(OptionType::Call, 100.0, 100.0, 1.0, 0.25, 0.05, 0.08, 20000) +
                               crr_american(OptionType::Call, 100.0, 100.0, 1.0, 0.25, 0.05, 0.08, 20001));
    const bool calls_ok = std::fabs(c0.price - e0.price) <= 1e-9 * e0.price && c8.price > e8.price &&
                          std::fabs(c8.price - crr8) < 2e-3 && c8.boundary_S[c8.n_boundary - 1] > 100.0;
    all_ok = all_ok && calls_ok;
    printf("  American call: q = 0 %.6f = European %.6f · q = 8%% %.4f vs lattice %.4f, European %.4f, exercised above %.2f  %s\n",
           c0.price, e0.price, c8.price, crr8, e8.price, c8.boundary_S[c8.n_boundary - 1], calls_ok ? "OK" : "*** FAIL ***");

    // knock-outs under flat volatility against Reiner–Rubinstein
    VolSurface kf;
    kf.S = 100.0; kf.r = 0.08; kf.q = 0.04; kf.sigma = 0.25;
    struct Case { OptionType type; bool up; double K; double levels[3]; };
    const Case cases[] = {
        { OptionType::Call, false, 100.0, { 85.0, 92.0, 97.0 } },
        { OptionType::Put,  true,  100.0, { 103.0, 108.0, 115.0 } },
        { OptionType::Call, true,   95.0, { 105.0, 115.0, 130.0 } },
        { OptionType::Put,  false, 105.0, { 80.0, 90.0, 98.0 } },
    };
    double ko_err = 0.0;
    for (const Case& c : cases) {
        for (double H : c.levels) {
            PdeSpec ko;
            ko.kind = PdeKind::KnockOut; ko.type = c.type; ko.K = c.K; ko.T = 0.5; ko.H = H; ko.up = c.up;
            ko_err = std::max(ko_err, std::fabs(pde_price(ko, kf, 801, 800).price -
                                                barrier_prices(c.type, c.up, 100.0, c.K, H, 0.5, 0.25, 0.08, 0.04).out));
        }
    }
    const bool ko_ok = ko_err < 2e-3;
    all_ok = all_ok && ko_ok;
    printf("  knock-outs, 4 types x 3 levels vs Reiner–Rubinstein: worst |diff| %.1e  %s\n", ko_err, ko_ok ? "OK" : "*** FAIL ***");

    // Dupire consistency: under the equity smile with the upward term structure, the local-volatility PDE reprices
    // the surface's vanillas at their implied volatilities
    VolSurface lv;
    lv.S = 756.48; lv.r = 0.045; lv.q = 0.0; lv.sigma = 0.138;
    lv.smile = true; lv.rho = -0.7; lv.eta = 1.0; lv.gamma = 0.45;
    lv.term = TermKind::Curve; lv.ratio = 0.5; lv.half_life = 0.15;
    double lv_err[2] = { 0.0, 0.0 };
    for (double T : { 0.25, 1.0 }) {
        for (double m : { 0.9, 1.0, 1.1 }) {
            for (OptionType type : { OptionType::Call, OptionType::Put }) {
                PdeSpec e;
                e.type = type; e.K = m * lv.S; e.T = T;
                const double bs = bsm_price(type, lv.S, e.K, lv.r, implied_vol(lv, e.K, T), T, lv.q);
                lv_err[0] = std::max(lv_err[0], std::fabs(pde_price(e, lv, 401, 400).price - bs) / bs);
                lv_err[1] = std::max(lv_err[1], std::fabs(pde_price(e, lv, 801, 800).price - bs) / bs);
            }
        }
    }
    const bool dupire_ok = lv_err[1] < 1e-3 && lv_err[1] < lv_err[0];
    all_ok = all_ok && dupire_ok;
    printf("  local vol reprices the surface: 12 vanillas (90/100/110%%, 3m and 1y) worst relative error %.2e (401) → %.2e (801)  %s\n",
           lv_err[0], lv_err[1], dupire_ok ? "OK" : "*** FAIL ***");

    // knock-outs under local volatility: PDE against the Brownian-bridge Monte Carlo (Richardson, 1M paths)
    ExoticSpec b;
    b.kind = ExoticKind::Barrier; b.type = OptionType::Call; b.K = 755.0; b.T = 0.25; b.n_levels = 3;
    b.levels[0] = 680.0; b.levels[1] = 700.0; b.levels[2] = 720.0;
    const ExoticResult mc = mc_exotic_mt(b, lv, 1'000'000, 17, 365.0, true, -1);
    double worst_z = 0.0;
    for (int j = 0; j < 3; ++j) {
        PdeSpec ko;
        ko.kind = PdeKind::KnockOut; ko.type = OptionType::Call; ko.K = 755.0; ko.T = 0.25; ko.H = b.levels[j];
        t0 = clk::now();
        const PdeResult p = pde_price(ko, lv, 801, 800);
        const double ms = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
        const double z = (mc.out[j] - p.price) / mc.out_se[j];
        worst_z = std::max(worst_z, std::fabs(z));
        printf("    down-and-out H=%.0f: PDE %.4f (Δ %.4f, Γ %.6f, %.1f ms) · Monte Carlo %.4f ± %.4f (z %+.2f)\n",
               b.levels[j], p.price, p.delta, p.gamma, ms, mc.out[j], mc.out_se[j], z);
    }
    const bool mc_ok = worst_z < 4.0;
    all_ok = all_ok && mc_ok;
    printf("  local-vol knock-outs, PDE vs Monte Carlo: worst |z| %.2f  %s\n", worst_z, mc_ok ? "OK" : "*** FAIL ***");

    // early exercise under the smile against flat volatility at the option's implied volatility
    PdeSpec lp;
    lp.kind = PdeKind::American; lp.type = OptionType::Put; lp.K = 756.0; lp.T = 1.0;
    PdeSpec le = lp;
    le.kind = PdeKind::European;
    VolSurface iv;
    iv.S = lv.S; iv.r = lv.r; iv.q = lv.q; iv.sigma = implied_vol(lv, 756.0, 1.0);
    const PdeResult la = pde_price(lp, lv, 801, 800), le_ = pde_price(le, lv, 801, 800);
    const PdeResult fa = pde_price(lp, iv, 801, 800), fe = pde_price(le, iv, 801, 800);
    const bool ee_ok = la.price > le_.price && fa.price > fe.price && std::fabs(le_.price - fe.price) < 1e-3 * fe.price;
    all_ok = all_ok && ee_ok;
    printf("  American put 756, 1y: local vol %.4f − European %.4f = %.4f early exercise · flat σ(K) %.2f%%: %.4f − %.4f = %.4f · boundary today %.2f vs %.2f  %s\n",
           la.price, le_.price, la.price - le_.price, iv.sigma * 100, fa.price, fe.price, fa.price - fe.price,
           la.boundary_S[la.n_boundary - 1], fa.boundary_S[fa.n_boundary - 1], ee_ok ? "OK" : "*** FAIL ***");

    // the American put under local volatility, where the exercise region reaches deep into high-volatility wings:
    // grid refinement, no-arbitrage bounds, a boundary at every sample, and a policy iteration that settles quickly
    const PdeResult fine = pde_price(lp, lv, 1601, 3200);
    bool lv_boundary_ok = la.n_boundary == 64;
    for (int j = 0; j < la.n_boundary; ++j) lv_boundary_ok = lv_boundary_ok && std::isfinite(la.boundary_S[j]) && la.boundary_S[j] < 756.0;
    const double refine = std::fabs(la.price - fine.price) / fine.price;
    const bool am_lv_ok = refine < 5e-4 && la.price >= std::max(le_.price, 756.0 - lv.S) && la.price <= 756.0 &&
                          lv_boundary_ok && la.lcp_iterations < 50 && fine.lcp_iterations < 50;
    all_ok = all_ok && am_lv_ok;
    printf("  local-vol American put: 801 × 800 %.5f vs 1601 × 3200 %.5f (relative %.1e) · Δ %.5f Γ %.7f Θ %.3f · boundary %.1f (%.0fd) → %.1f (1y) · policy iterations ≤ %d / %d  %s\n",
           la.price, fine.price, refine, la.delta, la.gamma, la.theta, la.boundary_S[0], la.boundary_tau[0] * 365,
           la.boundary_S[la.n_boundary - 1], la.lcp_iterations, fine.lcp_iterations, am_lv_ok ? "OK" : "*** FAIL ***");

    // invalid input
    PdeSpec bad = lp;
    bad.T = 0.0;
    PdeSpec bad_ko = lp;
    bad_ko.kind = PdeKind::KnockOut; bad_ko.H = 0.0;
    const bool invalid_ok = std::isnan(pde_price(bad, lv, 801, 800).price) && std::isnan(pde_price(lp, lv, 10, 800).price) &&
                            std::isnan(pde_price(bad_ko, lv, 801, 800).price);
    all_ok = all_ok && invalid_ok;
    printf("  T = 0, 10 nodes, barrier 0 → NaN  %s\n", invalid_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "Local-vol PDE:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 9: American Monte Carlo ─────────────────────────────────────────
//
// Longstaff–Schwartz against the finite-difference solver — two methods that share only the diffusion. The valuation
// pass prices fresh paths under a policy fitted on other paths, so it is low biased: it must not exceed the PDE by
// more than Monte Carlo error, and it may fall short of it by the discreteness of the exercise dates and the
// simulation's own bias. Bounds fixed before the first run: within 4 standard errors above, and within 4 standard
// errors plus 1% of the price below (0.5% under flat volatility, where the simulation's variance steps are exact).

static void section_lsm() {
    banner("9. AMERICAN MONTE CARLO  (Longstaff–Schwartz against the local-volatility PDE)");
    bool all_ok = true;
    using clk = std::chrono::steady_clock;

    // flat volatility, Hull's put: the simulation is exact, so only the exercise dates separate the two
    VolSurface hull;
    hull.S = 50.0; hull.r = 0.10; hull.q = 0.0; hull.sigma = 0.40;
    PdeSpec am;
    am.kind = PdeKind::American; am.type = OptionType::Put; am.K = 50.0; am.T = 5.0 / 12.0;
    const double pde_flat = pde_price(am, hull, 801, 800).price;
    auto t0 = clk::now();
    // policy paths × dates stay under kLsmMaxCells, so the finer date grid uses fewer policy paths
    const LsmResult coarse = lsm_american(OptionType::Put, 50.0, 5.0 / 12.0, hull, 100'000, 400'000, 11, 22, 365.0);
    const double ms_flat = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
    const LsmResult fine = lsm_american(OptionType::Put, 50.0, 5.0 / 12.0, hull, 80'000, 400'000, 11, 88, 365.0);
    const bool flat_ok = coarse.price <= pde_flat + 4 * coarse.std_error && fine.price <= pde_flat + 4 * fine.std_error &&
                         fine.price >= pde_flat - (4 * fine.std_error + 0.005 * pde_flat) && fine.price >= coarse.price - 4 * fine.std_error;
    all_ok = all_ok && flat_ok;
    printf("  Hull American put, flat σ: PDE %.4f · LSM %d dates %.4f ± %.4f · %d dates %.4f ± %.4f (policy %.4f, %d dates with a rule, %.0f ms)  %s\n",
           pde_flat, coarse.dates, coarse.price, coarse.std_error, fine.dates, fine.price, fine.std_error, fine.policy_price,
           fine.exercise_dates, ms_flat, flat_ok ? "OK" : "*** FAIL ***");

    // the same put by European Monte Carlo on the valuation paths, against the PDE's European value
    PdeSpec eu = am;
    eu.kind = PdeKind::European;
    const double pde_eu = pde_price(eu, hull, 801, 800).price;
    const double z_eu = std::fabs(fine.european - pde_eu) / fine.european_se;
    const bool eu_ok = z_eu < 4.0;
    all_ok = all_ok && eu_ok;
    printf("  the same paths held to expiry: %.4f ± %.4f vs PDE European %.4f (|z| %.2f) · early exercise %.4f vs PDE %.4f  %s\n",
           fine.european, fine.european_se, pde_eu, z_eu, fine.price - fine.european, pde_flat - pde_eu,
           eu_ok ? "OK" : "*** FAIL ***");

    // local volatility: the surface where Brennan–Schwartz went wrong, at two exercise-date counts and two step sizes
    VolSurface lv;
    lv.S = 756.48; lv.r = 0.045; lv.q = 0.0; lv.sigma = 0.138;
    lv.smile = true; lv.rho = -0.7; lv.eta = 1.0; lv.gamma = 0.45;
    lv.term = TermKind::Curve; lv.ratio = 0.5; lv.half_life = 0.15;
    PdeSpec lp;
    lp.kind = PdeKind::American; lp.type = OptionType::Put; lp.K = 756.0; lp.T = 1.0;
    const PdeResult pde_lv = pde_price(lp, lv, 801, 800);
    struct Run { int dates; double spy; const char* label; };
    const Run runs[] = { { 26, 365.0, "26 dates, 365 steps/yr" }, { 52, 365.0, "52 dates, 365 steps/yr" },
                         { 52, 730.0, "52 dates, 730 steps/yr" } };
    LsmResult finest{};
    bool lv_ok = true;
    for (const Run& run : runs) {
        t0 = clk::now();
        const LsmResult r = lsm_american(OptionType::Put, 756.0, 1.0, lv, 100'000, 200'000, 17, run.dates, run.spy);
        const double ms = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
        lv_ok = lv_ok && r.price <= pde_lv.price + 4 * r.std_error;
        finest = r;
        printf("    %s: %.4f ± %.4f (policy %.4f, European %.4f ± %.4f, %lld steps, %.0f ms)\n",
               run.label, r.price, r.std_error, r.policy_price, r.european, r.european_se, r.steps, ms);
    }
    lv_ok = lv_ok && finest.price >= pde_lv.price - (4 * finest.std_error + 0.01 * pde_lv.price);
    all_ok = all_ok && lv_ok;
    printf("  local-vol American put 756, 1y: PDE %.4f · LSM %.4f ± %.4f (%+.2f%%, low biased by discrete dates)  %s\n",
           pde_lv.price, finest.price, finest.std_error, (finest.price / pde_lv.price - 1.0) * 100,
           lv_ok ? "OK" : "*** FAIL ***");

    // a call without dividends is never exercised early: the policy must find no rule worth using
    const LsmResult c = lsm_american(OptionType::Call, 756.0, 1.0, lv, 50'000, 100'000, 5, 26, 365.0);
    const double z_call = std::fabs(c.price - c.european) / c.european_se;
    const bool call_ok = z_call < 4.0 && c.price <= c.european + 4 * c.std_error;
    all_ok = all_ok && call_ok;
    printf("  American call, no dividend: %.4f ± %.4f vs the same paths held to expiry %.4f ± %.4f (|z| %.2f)  %s\n",
           c.price, c.std_error, c.european, c.european_se, z_call, call_ok ? "OK" : "*** FAIL ***");

    // invalid input
    const bool invalid_ok = std::isnan(lsm_american(OptionType::Put, 0.0, 1.0, lv, 1000, 1000, 1, 10, 365.0).price) &&
                            std::isnan(lsm_american(OptionType::Put, 756.0, 1.0, lv, 10, 1000, 1, 10, 365.0).price) &&
                            std::isnan(lsm_american(OptionType::Put, 756.0, 1.0, lv, 1'000'000, 1000, 1, 512, 365.0).price);
    all_ok = all_ok && invalid_ok;
    printf("  K = 0, too few paths, more cells than the cap → NaN  %s\n", invalid_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "American Monte Carlo:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 10: American upper bound ────────────────────────────────────────
//
// Section 9's Longstaff–Schwartz price is low biased: a suboptimal policy is still a policy, so it bounds the value
// from below only. The Andersen–Broadie dual turns that same fitted policy into a martingale and prices the option
// from above, so the two together bracket the value instead of bounding one side of it.
//
// What they bracket is the Bermudan the policy exercises — `dates` equally spaced dates — which is worth less than the
// continuously exercisable American a PDE returns. The reference here is therefore a CRR lattice restricted to those
// same dates, exact under flat volatility; checking the bracket against the PDE would be checking it against the wrong
// number, and the lattice's distance below the PDE is reported so that discount stays visible.
//
// Bounds fixed before the first run, as requirements on the estimator rather than fits to it: the bracket must contain
// the lattice value (the lower bound below it and the upper bound above it, each within 4 standard errors), it must be
// non-empty, at the refined inner count it must be tight enough to be useful (no wider than 2% of the price), and
// refining the inner simulations must shrink it, since what remains of the gap is inner-sample noise.

// CRR lattice with exercise permitted only every `per` steps, so only on the policy's own `dates` exercise dates.
static double crr_bermudan(OptionType type, double S, double K, double T, double sigma, double r, double q, int dates,
                           int per) {
    const int    n = dates * per;
    const double dt = T / n, lnu = sigma * std::sqrt(dt), u = std::exp(lnu), d = 1.0 / u;
    const double p = (std::exp((r - q) * dt) - d) / (u - d), disc = std::exp(-r * dt);
    const double pu = disc * p, pd = disc * (1.0 - p);
    auto exercise = [type, K](double spot) { return type == OptionType::Call ? std::max(spot - K, 0.0) : std::max(K - spot, 0.0); };
    std::vector<double> level(2 * static_cast<std::size_t>(n) + 1), v(static_cast<std::size_t>(n) + 1);
    for (int k = -n; k <= n; ++k) level[static_cast<std::size_t>(k + n)] = S * std::exp(k * lnu);
    for (int i = 0; i <= n; ++i) v[static_cast<std::size_t>(i)] = exercise(level[static_cast<std::size_t>(2 * n - 2 * i)]);
    for (int step = n - 1; step >= 0; --step) {
        const bool date = step > 0 && step % per == 0;      // the option is alive between exercise dates
        for (int i = 0; i <= step; ++i) {
            const double cont = pu * v[static_cast<std::size_t>(i)] + pd * v[static_cast<std::size_t>(i + 1)];
            v[static_cast<std::size_t>(i)] =
                date ? std::max(cont, exercise(level[static_cast<std::size_t>(step - 2 * i + n)])) : cont;
        }
    }
    return v[0];
}

static void section_dual() {
    banner("10. AMERICAN UPPER BOUND  (Andersen-Broadie dual against a Bermudan lattice)");
    bool all_ok = true;
    using clk = std::chrono::steady_clock;

    VolSurface hull;
    hull.S = 50.0; hull.r = 0.10; hull.q = 0.0; hull.sigma = 0.40;
    const double K = 50.0, T = 5.0 / 12.0;
    PdeSpec am;
    am.kind = PdeKind::American; am.type = OptionType::Put; am.K = K; am.T = T;
    const double pde = pde_price(am, hull, 801, 800).price;   // continuous exercise: above every Bermudan below

    for (int dates : { 11, 22 }) {
        // two refinements of the reference: agreement shows the lattice itself has converged
        const double coarse = crr_bermudan(OptionType::Put, 50.0, K, T, 0.40, 0.10, 0.0, dates, 240);
        const double berm   = crr_bermudan(OptionType::Put, 50.0, K, T, 0.40, 0.10, 0.0, dates, 480);
        const bool   ref_ok = std::fabs(berm - coarse) < 1e-3 && berm < pde;
        all_ok = all_ok && ref_ok;

        LsmPolicy       policy;
        const LsmResult lo = lsm_american_policy(OptionType::Put, K, T, hull, 40'000, 200'000, 11, dates, 365.0, &policy);
        const bool      lo_ok = lo.price <= berm + 4 * lo.std_error;
        all_ok = all_ok && lo_ok;
        printf("  %d exercise dates: lattice %.4f (%.4f under continuous %.4f) · LSM lower %.4f ± %.4f  %s\n",
               dates, berm, pde - berm, pde, lo.price, lo.std_error, (ref_ok && lo_ok) ? "OK" : "*** FAIL ***");

        double widest = 0.0;
        for (long long inner : { 200LL, 800LL }) {
            const auto          t0 = clk::now();
            const LsmDualResult up = lsm_dual_bound(policy, hull, 300, inner, 77, 365.0);
            const double        ms = std::chrono::duration<double, std::milli>(clk::now() - t0).count();
            const double        gap = up.upper - lo.price;
            bool                ok = up.upper >= berm - 4 * up.std_error && up.upper >= lo.price;
            if (inner == 800) ok = ok && gap <= 0.02 * berm && gap < widest;
            widest = gap;
            all_ok = all_ok && ok;
            printf("    inner %3lld: upper %.4f ± %.4f (%+.4f over the lattice) · bracket [%.4f, %.4f] wide %.4f = %.2f%% · %lld sims, %.0f ms  %s\n",
                   inner, up.upper, up.std_error, up.upper - berm, lo.price, up.upper, gap, 100 * gap / berm,
                   up.inner_sims, ms, ok ? "OK" : "*** FAIL ***");
        }
    }

    // invalid input: a policy that was never fitted, too few outer paths, too few inner paths
    LsmPolicy unfitted, good;
    lsm_american_policy(OptionType::Put, K, T, hull, 20'000, 20'000, 11, 11, 365.0, &good);
    const bool invalid_ok = std::isnan(lsm_dual_bound(unfitted, hull, 300, 200, 7, 365.0).upper) &&
                            std::isnan(lsm_dual_bound(good, hull, 50, 200, 7, 365.0).upper) &&
                            std::isnan(lsm_dual_bound(good, hull, 300, 5, 7, 365.0).upper);
    all_ok = all_ok && invalid_ok;
    printf("  an unfitted policy, 50 outer paths, 5 inner paths → NaN  %s\n", invalid_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "American upper bound:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 11: discretely monitored barriers ───────────────────────────────
//
// Real barrier contracts are checked at daily or weekly closes, not continuously, and a barrier tested on only m
// dates is harder to breach — so a discretely monitored knock-out is worth strictly more than the continuous one.
// Two independent methods: the simulation tests the barrier on those same m dates (they are grid anchors, so every
// path lands on them exactly), and the Broadie–Glasserman–Kou correction prices it in closed form by moving the
// barrier away from the spot to H·exp(±β σ √(T/m)).
//
// Bounds fixed before the first run, as requirements on the correction rather than fits to it: it must sit within 4
// standard errors of the simulation at every monitoring frequency; it must be strictly closer to the simulation than
// the uncorrected continuous formula; the discrete value must exceed the continuous one and fall toward it as m
// grows; in + out must equal the vanilla on the same paths; and the grid must land on every monitoring date.

static void section_discrete_barrier() {
    banner("11. DISCRETELY MONITORED BARRIERS  (Broadie-Glasserman-Kou against the same-dates simulation)");
    bool all_ok = true;

    VolSurface flat;
    flat.S = 100.0; flat.r = 0.08; flat.q = 0.04; flat.sigma = 0.25;
    const double K = 100.0, T = 0.5;
    struct Case { OptionType type; bool up; double H; const char* name; };
    const Case cases[] = { { OptionType::Call, false, 92.0,  "down-and-out call  H=92 " },
                           { OptionType::Put,  true,  108.0, "up-and-out   put   H=108" } };

    for (const Case& c : cases) {
        ExoticSpec e;
        e.kind = ExoticKind::Barrier; e.type = c.type; e.K = K; e.T = T; e.up = c.up;
        e.n_levels = 1; e.levels[0] = c.H;
        const ExoticResult  rc = mc_exotic_mt(e, flat, 1'000'000, 11, 365.0, true, -1);
        const BarrierPrices cf = barrier_prices(c.type, c.up, flat.S, K, c.H, T, flat.sigma, flat.r, flat.q);
        const double z_cont = zscore(rc.out[0], cf.out, rc.out_se[0]);
        const bool   cont_ok = z_cont < 4.0 && rc.n_monitors == 0;
        all_ok = all_ok && cont_ok;
        printf("  %s: continuous MC %.4f ± %.4f vs closed form %.4f (|z| %.2f)  %s\n",
               c.name, rc.out[0], rc.out_se[0], cf.out, z_cont, cont_ok ? "OK" : "*** FAIL ***");

        double prev = INFINITY;   // each finer monitoring grid must price closer to continuous monitoring
        for (int m : { 12, 52, 252 }) {
            ExoticSpec d = e;
            d.n_monitors = m;
            const ExoticResult  rd = mc_exotic_mt(d, flat, 1'000'000, 11, 365.0, true, -1);
            const BarrierPrices bgk =
                barrier_prices_discrete(c.type, c.up, flat.S, K, c.H, T, flat.sigma, flat.r, flat.q, m);
            const double z_bgk = zscore(bgk.out, rd.out[0], rd.out_se[0]);
            const double z_unc = zscore(cf.out, rd.out[0], rd.out_se[0]);
            const double parity = std::fabs(rd.out[0] + rd.in[0] - rd.vanilla);
            const bool   ok = z_bgk < 4.0 && z_bgk < z_unc && rd.out[0] > rc.out[0] && rd.out[0] < prev &&
                              parity < 1e-10 && rd.n_monitors == m && rd.steps >= m;
            all_ok = all_ok && ok;
            prev = rd.out[0];
            printf("    %3d dates: MC %.4f ± %.4f (%+.4f over continuous) · corrected %.4f (|z| %.2f) · uncorrected %.4f (|z| %5.1f) · %lld steps, parity %.0e  %s\n",
                   m, rd.out[0], rd.out_se[0], rd.out[0] - rc.out[0], bgk.out, z_bgk, cf.out, z_unc, rd.steps, parity,
                   ok ? "OK" : "*** FAIL ***");
        }
    }

    // more monitoring dates than the cap is rejected; no monitoring dates is continuous monitoring, unchanged
    ExoticSpec bad;
    bad.kind = ExoticKind::Barrier; bad.type = OptionType::Call; bad.K = K; bad.T = T; bad.n_levels = 1;
    bad.levels[0] = 92.0; bad.n_monitors = static_cast<int>(kMaxBarrierMonitors) + 1;
    const BarrierPrices zero_m = barrier_prices_discrete(OptionType::Call, false, 100.0, K, 92.0, T, 0.25, 0.08, 0.04, 0);
    const BarrierPrices cont0 = barrier_prices(OptionType::Call, false, 100.0, K, 92.0, T, 0.25, 0.08, 0.04);
    const bool invalid_ok = std::isnan(mc_exotic(bad, flat, 100, 1, 365.0, true).vanilla) && zero_m.out == cont0.out;
    all_ok = all_ok && invalid_ok;
    printf("  more monitoring dates than the cap → NaN · no monitoring dates prices continuous monitoring  %s\n",
           invalid_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "Discrete barriers:", all_ok ? "ALL PASS" : "FAIL");
}

// ── Section 12: barrier rebates ─────────────────────────────────────────────
//
// A knock-out that pays a rebate on being extinguished, and a knock-in that pays one at expiry if the barrier is never
// touched (Reiner & Rubinstein's E and F terms). Three methods that share no algebra: the closed form, the
// finite-difference solver carrying the rebate as the barrier's Dirichlet value, and the simulation, which earns the
// rebate as it loses survival — it holds a probability, not a hit time, so a rebate paid at the hit is placed at the
// step's end and converges as the grid refines, while one paid at expiry needs only the final survival.
//
// Bounds fixed before the first run, as requirements: the closed form matches the PDE to 1e-4 for every barrier type
// and both payment times; a rebate of 0 leaves every price exactly as it was; a rebate paid at the hit is worth more
// than the same rebate paid at expiry; one time step leaves only one possible hit time, so the two must then agree
// exactly; the simulation sits within 4 standard errors of the closed form; and out + in − vanilla is the rebate
// discounted from expiry — exactly, since that holds path by path under any monitoring scheme.

static void section_rebate() {
    banner("12. BARRIER REBATES  (closed form, finite differences and simulation)");
    bool all_ok = true;

    VolSurface flat;
    flat.S = 100.0; flat.r = 0.08; flat.q = 0.04; flat.sigma = 0.25;
    const double T = 0.5, R = 3.0;
    const double reb_expiry = R * std::exp(-flat.r * T);

    struct Case { OptionType type; bool up; double K, H; };
    const Case cases[] = { { OptionType::Call, false, 100.0, 92.0 }, { OptionType::Put, true, 100.0, 108.0 },
                           { OptionType::Put, false, 105.0, 85.0 }, { OptionType::Call, true, 95.0, 120.0 } };
    double worst_pde = 0.0;
    bool   shape_ok = true;
    for (const Case& c : cases) {
        const BarrierPrices none = barrier_prices(c.type, c.up, flat.S, c.K, c.H, T, flat.sigma, flat.r, flat.q);
        const BarrierPrices zero =
            barrier_prices_rebate(c.type, c.up, flat.S, c.K, c.H, T, flat.sigma, flat.r, flat.q, 0.0, true);
        shape_ok = shape_ok && zero.out == none.out && zero.in == none.in;
        double at[2] = {};
        for (int k = 0; k < 2; ++k) {
            const bool at_hit = k == 0;
            const BarrierPrices cf =
                barrier_prices_rebate(c.type, c.up, flat.S, c.K, c.H, T, flat.sigma, flat.r, flat.q, R, at_hit);
            PdeSpec sp;
            sp.kind = PdeKind::KnockOut; sp.type = c.type; sp.K = c.K; sp.T = T; sp.H = c.H; sp.up = c.up;
            sp.rebate = R; sp.rebate_at_hit = at_hit;
            worst_pde = std::max(worst_pde, std::fabs(cf.out - pde_price(sp, flat, 1601, 2000).price));
            at[k] = cf.out;
            if (!at_hit) shape_ok = shape_ok && std::fabs(cf.out + cf.in - cf.vanilla - reb_expiry) < 1e-10;
        }
        shape_ok = shape_ok && at[0] > at[1];   // paid at the hit the money arrives earlier, so it is worth more
    }
    const bool cf_ok = worst_pde < 1e-4 && shape_ok;
    all_ok = all_ok && cf_ok;
    printf("  4 barrier types × 2 payment times: worst |closed form − PDE| %.1e · rebate 0 unchanged, at the hit > at expiry, in + out − vanilla = R·e^−rT  %s\n",
           worst_pde, cf_ok ? "OK" : "*** FAIL ***");

    // the simulation on the first case, at both payment times
    ExoticSpec e;
    e.kind = ExoticKind::Barrier; e.type = cases[0].type; e.K = cases[0].K; e.T = T; e.up = cases[0].up;
    e.n_levels = 1; e.levels[0] = cases[0].H;
    for (int k = 0; k < 2; ++k) {
        const bool at_hit = k == 0;
        ExoticSpec spec = e;
        spec.rebate = R; spec.rebate_at_hit = at_hit;
        const BarrierPrices cf = barrier_prices_rebate(cases[0].type, cases[0].up, flat.S, cases[0].K, cases[0].H, T,
                                                       flat.sigma, flat.r, flat.q, R, at_hit);
        const ExoticResult r = mc_exotic_mt(spec, flat, 400'000, 11, 365.0, true, -1);
        const double z = zscore(r.out[0], cf.out, r.out_se[0]);
        const bool   ok = z < 4.0;
        all_ok = all_ok && ok;
        printf("    down-and-out call H=92, rebate paid %-11s: %.4f ± %.4f vs closed form %.4f (|z| %.2f, %lld steps)  %s\n",
               at_hit ? "at the hit" : "at expiry", r.out[0], r.out_se[0], cf.out, z, r.steps, ok ? "OK" : "*** FAIL ***");
    }

    // one step: the only hit time is the expiry, so the two payment times must price identically
    ExoticSpec one_hit = e, one_exp = e;
    one_hit.rebate = one_exp.rebate = R;
    one_hit.rebate_at_hit = true; one_exp.rebate_at_hit = false;
    const ExoticResult rh = mc_exotic(one_hit, flat, 50'000, 7, 2.0, true);
    const ExoticResult re = mc_exotic(one_exp, flat, 50'000, 7, 2.0, true);
    // discrete monitoring has no closed form here, but the identity is exact under any monitoring
    ExoticSpec dm = e;
    dm.n_monitors = 26; dm.rebate = R; dm.rebate_at_hit = false;
    const ExoticResult rd = mc_exotic_mt(dm, flat, 400'000, 11, 365.0, true, -1);
    const double identity = std::fabs(rd.out[0] + rd.in[0] - rd.vanilla - reb_expiry);
    const bool   exact_ok = rh.steps == 1 && rh.out[0] == re.out[0] && identity < 1e-9;
    all_ok = all_ok && exact_ok;
    printf("    one step: at the hit %.6f = at expiry %.6f · 26 monitoring dates: |out + in − vanilla − R·e^−rT| %.1e  %s\n",
           rh.out[0], re.out[0], identity, exact_ok ? "OK" : "*** FAIL ***");

    ExoticSpec bad = e;
    bad.rebate = -1.0;
    const bool invalid_ok = std::isnan(mc_exotic(bad, flat, 100, 1, 365.0, true).vanilla);
    all_ok = all_ok && invalid_ok;
    printf("  a negative rebate → NaN  %s\n", invalid_ok ? "OK" : "*** FAIL ***");

    printf("\n  %-22s  %s\n", "Barrier rebates:", all_ok ? "ALL PASS" : "FAIL");
}

// ── main ─────────────────────────────────────────────────────────────────────

int main() {
    printf("QuantCore Phase 1 — Acceptance Gate\n");
    printf("NDF method: std::erfc  →  N(x) = 0.5 · erfc(−x/√2)\n");
    printf("RNG method: std::mt19937_64, seeded deterministically\n");

    section_bs_prices();
    section_greeks();
    section_mc_convergence();
    section_dividend_yield();
    section_portfolio_mc();
    section_local_vol();
    section_exotics();
    section_pde();
    section_lsm();
    section_dual();
    section_discrete_barrier();
    section_rebate();

    banner("End of Phase 1 report");
    return 0;
}
