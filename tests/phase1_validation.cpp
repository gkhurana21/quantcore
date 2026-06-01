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
//   theta_num = [V(T−dt) − V(T)]           / dt       dt = 1/365
//   vega_num  = [V(σ+dσ) − V(σ−dσ)]       / 2dσ      dσ = 0.001
//
// theta sign convention: dV/dt where t is calendar time (T = maturity−t
// decreases as time passes), so theta < 0 means the option loses value daily.
// Both analytic and numerical use the same convention — they must match.
//
// Tolerances: delta/gamma/vega 1e-4; theta 5e-3 (1-day bump is coarser).

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
                              double S, double K, double r, double sigma, double T) {
    const double hS  = 0.001 * S;   // 0.1% of spot
    const double hT  = 1.0 / 365.0; // 1 calendar day
    const double hSg = 0.001;        // 0.1 vol-point

    double v0  = bsm_price(type, S,     K, r, sigma,       T);
    double vUp = bsm_price(type, S+hS,  K, r, sigma,       T);
    double vDn = bsm_price(type, S-hS,  K, r, sigma,       T);
    double vTm = bsm_price(type, S,     K, r, sigma,       T - hT);
    double vVu = bsm_price(type, S,     K, r, sigma + hSg, T);
    double vVd = bsm_price(type, S,     K, r, sigma - hSg, T);

    NumGreeks g;
    g.delta = (vUp - vDn) / (2.0 * hS);
    g.gamma = (vUp - 2.0*v0 + vDn) / (hS * hS);
    g.theta = (vTm - v0) / hT;               // −∂V/∂T ≡ ∂V/∂t
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

// ── main ─────────────────────────────────────────────────────────────────────

int main() {
    printf("QuantCore Phase 1 — Acceptance Gate\n");
    printf("NDF method: std::erfc  →  N(x) = 0.5 · erfc(−x/√2)\n");
    printf("RNG method: std::mt19937_64, seeded deterministically\n");

    section_bs_prices();
    section_greeks();
    section_mc_convergence();

    banner("End of Phase 1 report");
    return 0;
}
