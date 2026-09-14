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

    banner("End of Phase 1 report");
    return 0;
}
