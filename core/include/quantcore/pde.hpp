#pragma once
#include <cstddef>
#include "quantcore/black_scholes.hpp"
#include "quantcore/local_vol.hpp"

namespace quantcore {

/*
 * Finite-difference solver of the local-volatility pricing PDE in log spot x = ln S and time to expiry τ:
 *
 *   V_τ = ½σ²(x, t)·V_xx + (r − q − ½σ²(x, t))·V_x − r·V,   t = T − τ,
 *
 * with σ² the surface's Dupire local variance (local_variance_row — the Monte Carlo kernel's own evaluation). Space:
 * a uniform log-spot grid with ln S₀ on a node and the payoff averaged over each cell; central differences, upwind
 * where the drift dominates the diffusion. Time: calendar time graded towards today (t = T·u², u uniform), because
 * SSVI's power-law smile makes local variance singular as t → 0 — on uniform steps the Greeks converged at roughly
 * order 0.55 (Γ of a 1y put still moving 10% between 800 and 3,200 steps); on the graded grid they settle by 800.
 * The first two steps are two implicit Euler half steps each (smoothing the payoff's kink), then variable-step BDF2,
 * which is L-stable: Crank–Nicolson left the stiff high-volatility wings oscillating.
 *
 *   European   Dirichlet boundaries W = max(6 sd, |ln K/S| + 3 sd) either side of ln S₀ (sd at the ATM implied
 *              volatility), holding the discounted intrinsic value
 *   American   the same, with V ≥ intrinsic as a linear complementarity problem solved exactly at every step by policy
 *              iteration. Brennan–Schwartz, which assumes the exercise region is one interval from the grid's edge,
 *              gave a 1y local-vol put whose price moved with the grid's width (53.28 → 51.06); policy iteration
 *              agrees to 1e-5 at every width. The early-exercise boundary is recorded.
 *   KnockOut   continuously monitored: the barrier is an end node placed exactly at ln H, holding V = 0 without a
 *              rebate, the rebate itself when one is paid at the hit, or R·e^{−rτ} when it is paid at expiry with τ
 *              still to run; the far boundary as
 *              European
 *
 * Greeks at S₀ from the grid: Δ = V_x/S, Γ = (V_xx − V_x)/S², Θ = ∂V/∂t per year from the PDE itself
 * (r·V − (r − q − ½σ²)·V_x − ½σ²·V_xx at t = 0; zero where an American option is exercised).
 *
 * Vega is not a grid derivative: it is ∂V/∂σ by a central bump of the surface's ATM level, re-solved. The smile and
 * term structure are expressed relative to that level, so they ride along and the number is the value's sensitivity
 * to the whole surface shifting — a model vega, not a Black-Scholes one, though under flat volatility the two
 * coincide and the solver reproduces S·e^{−qT}·φ(d₁)·√T to within 5e-5 relative at the default grid — 4e-7 at the
 * money, the wings worst. The bump is chosen where the difference's own O(h²) bias and the price error amplified by
 * 1/2h meet: at half a vol point the wings carry 1.6e-4, at two tenths of a point 4.5e-5. Refining the grid
 * four-fold then improves it only about twice, so what is left is part bump and part grid. It costs two extra
 * solves, so it is asked for explicitly rather than always computed. A knock-out's vega can be negative: close to
 * the barrier (spot 756, barrier 752) it is −7.68, more volatility making the breach likelier by more than the
 * extra optionality is worth.
 */

enum class PdeKind : int { European = 0, American = 1, KnockOut = 2 };

struct PdeSpec {
    PdeKind    kind = PdeKind::European;
    OptionType type = OptionType::Call;
    double     K = 0.0;
    double     T = 0.0;
    double     H = 0.0;        // knock-out barrier
    bool       up = false;     // knock-out: the barrier is above spot
    double     rebate = 0.0;        // knock-out: paid on hitting the barrier, or at expiry
    bool       rebate_at_hit = true;
    int        n_monitors = 0;      // knock-out: the barrier is tested on m dates k·T/m; 0 monitors continuously
};

/** Monitoring dates one discretely monitored knock-out may use (daily over eight years). */
inline constexpr int kMaxPdeMonitors = 2000;
inline constexpr int kMinPdeNodes = 21;
inline constexpr int kMaxPdeNodes = 4001;
inline constexpr int kMaxPdeSteps = 20000;
inline constexpr std::size_t kPdeBoundaryPoints = 64;

struct PdeResult {
    double price = 0.0, delta = 0.0, gamma = 0.0, theta = 0.0;   // per unit of underlying; theta = ∂V/∂t per year
    double vega = 0.0;                                           // ∂V/∂σ per 1.00 of volatility; 0 unless asked for
    int    nodes = 0, steps = 0;                                 // grid actually used
    int    lcp_iterations = 0;                                   // American: most policy iterations in one step
    int    n_boundary = 0;                                       // American: early-exercise boundary samples
    double boundary_tau[kPdeBoundaryPoints] = {};                // time to expiry, ascending (the first step past each T·k/64)
    double boundary_S[kPdeBoundaryPoints] = {};                  // exercised at or below (put) / above (call); NaN: none
};

/**
 * The option on the surface's local volatility; `nodes` log-spot nodes (21–4001) and `steps` time steps (4–20000).
 * NaN values on invalid input. A knock-out whose barrier spot has already crossed is worth 0.
 */
PdeResult pde_price(const PdeSpec& spec, const VolSurface& s, int nodes, int steps, bool want_vega = false);

} // namespace quantcore
