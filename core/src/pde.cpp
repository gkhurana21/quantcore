#include "quantcore/pde.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <limits>

namespace quantcore {
namespace {

const double kNaN = std::numeric_limits<double>::quiet_NaN();

PdeResult invalid_pde() {
    PdeResult r;
    r.price = r.delta = r.gamma = r.theta = r.vega = kNaN;
    return r;
}

// Mean payoff over the log-spot cell [a, b]. A kink inside a cell is averaged exactly, so the scheme stays second
// order wherever the strike falls relative to the grid.
double cell_payoff(bool call, double a, double b, double K, double lnK) {
    if (call) {
        if (b <= lnK) return 0.0;
        const double lo = std::max(a, lnK);
        return (std::exp(b) - std::exp(lo) - K * (b - lo)) / (b - a);
    }
    if (a >= lnK) return 0.0;
    const double hi = std::min(b, lnK);
    return (K * (hi - a) - (std::exp(hi) - std::exp(a))) / (b - a);
}

// Tridiagonal solve for rows 1..n−1 (the end values already moved into r); c and e are work arrays.
void thomas(int n, const double* l, const double* d, const double* u, const double* r, double* c, double* e, double* V) {
    c[1] = u[1] / d[1];
    e[1] = r[1] / d[1];
    for (int i = 2; i < n; ++i) {
        const double m = 1.0 / (d[i] - l[i] * c[i - 1]);
        c[i] = u[i] * m;
        e[i] = (r[i] - l[i] * e[i - 1]) * m;
    }
    V[n - 1] = e[n - 1];
    for (int i = n - 2; i >= 1; --i) V[i] = e[i] - c[i] * V[i + 1];
}

} // namespace

namespace {

// The whole solve, with the grid's half-width scale supplied from outside. Vega re-solves on a bumped surface, and
// re-deriving that scale from the bumped volatility would put the three solves on slightly different nodes; sharing
// it keeps them on identical ones, so the difference reflects the volatility change alone and a call and a put agree
// on vega to about 1e-6. It is not what sets vega's accuracy, though: refining the grid four-fold barely moves the
// error, because what remains is the central difference's own bias, which the bump size controls instead.
PdeResult pde_solve(const PdeSpec& spec, const VolSurface& s, int nodes, int steps, double sd_in) {
    const bool knock = spec.kind == PdeKind::KnockOut, american = spec.kind == PdeKind::American;
    if (!vol_surface_valid(s) || !(spec.K > 0.0) || !(spec.T > 0.0) || !std::isfinite(spec.K) || !std::isfinite(spec.T) ||
        nodes < kMinPdeNodes || nodes > kMaxPdeNodes || steps < 4 || steps > kMaxPdeSteps ||
        (knock && !(spec.H > 0.0 && std::isfinite(spec.H))) ||
        spec.n_monitors < 0 || spec.n_monitors > kMaxPdeMonitors ||
        spec.rebate < 0.0 || !std::isfinite(spec.rebate)) {
        return invalid_pde();
    }
    // a monitored barrier is tested only on its dates, so between them the option lives on both sides of it
    const bool monitored = knock && spec.n_monitors > 0;
    const bool call = spec.type == OptionType::Call;
    const double S = s.S, K = spec.K, T = spec.T, r = s.r, q = s.q;
    const double x0 = std::log(S), lnK = std::log(K);

    PdeResult res;
    res.steps = steps;
    if (knock && (spec.up ? S >= spec.H : S <= spec.H)) {   // the barrier has already been crossed
        res.nodes = nodes;
        // nothing is left but the rebate: due now if it is paid at the hit, otherwise at expiry
        res.price = spec.rebate > 0.0 ? (spec.rebate_at_hit ? spec.rebate : spec.rebate * std::exp(-s.r * spec.T)) : 0.0;
        return res;
    }

    // uniform log-spot grid with ln S₀ on a node — in the middle for a vanilla, m nodes from ln H for a knock-out
    const double sd = sd_in > 0.0 ? sd_in : std::max(implied_vol(s, S, T), 0.05) * std::sqrt(T);
    const double W = std::max(6.0 * sd, std::fabs(lnK - x0) + 3.0 * sd);
    int n = nodes - 1;                                        // intervals
    double lo = 0.0, dx = 0.0;
    int i0 = 0, mb = 0;                                       // spot node, and intervals from it to the barrier
    if (!knock) {
        n -= n % 2;
        dx = 2.0 * W / n;
        lo = x0 - W;
        i0 = n / 2;
    } else if (monitored) {
        // the barrier is an interior node: the grid runs past it, with both ln S₀ and ln H landing on nodes so the
        // extinguished region is exactly a run of nodes and the jump needs no interpolation
        const double h = std::log(spec.H), gap = std::fabs(x0 - h);
        const double half = std::max(W, gap + 3.0 * sd);       // far enough past the barrier for its own boundary
        mb = std::max(1, static_cast<int>(std::lround((gap * n) / (2.0 * half))));
        dx = gap / mb;
        int side = std::max(mb + 1, static_cast<int>(std::ceil(half / dx)));
        if (2 * side > n) {
            side = n / 2;
            if (side < mb + 1) {                               // too few nodes for both sides: coarsen to the barrier
                mb = std::max(1, side - 1);
                dx = gap / mb;
            }
        }
        n = 2 * side;
        lo = x0 - side * dx;
        i0 = side;
    } else {
        const double h = std::log(spec.H), gap = std::fabs(x0 - h);
        mb = std::min(n - 1, std::max(1, static_cast<int>(std::lround(gap * n / (gap + W)))));
        dx = gap / mb;
        lo = spec.up ? h - n * dx : h;
        i0 = spec.up ? n - mb : mb;
    }
    res.nodes = n + 1;

    const std::size_t N = static_cast<std::size_t>(n) + 1;
    double* block = static_cast<double*>(std::calloc(17 * N, sizeof(double)));
    if (!block) return invalid_pde();
    double* x = block, * sig2 = x + N, * V = sig2 + N, * Vprev = V + N, * base = Vprev + N, * ex = base + N,
          * lower = ex + N, * diag = lower + N, * upper = diag + N, * rhs = upper + N,
          * ml = rhs + N, * md = ml + N, * mu = md + N, * mr = mu + N, * wc = mr + N, * wd = wc + N,
          * exercise = wd + N;                                // 1 where the policy exercises
    for (std::size_t i = 0; i < N; ++i) {
        x[i] = lo + dx * static_cast<double>(i);
        const double spot = std::exp(x[i]);
        ex[i] = american ? (call ? std::max(spot - K, 0.0) : std::max(K - spot, 0.0)) : 0.0;
        V[i] = cell_payoff(call, x[i] - 0.5 * dx, x[i] + 0.5 * dx, K, lnK);
    }
    x[i0] = x0;

    // Dirichlet values at the grid's ends: discounted intrinsic (at least intrinsic when American), 0 at a barrier
    const double S_lo = std::exp(x[0]), S_hi = std::exp(x[n]);
    auto ends = [&](double tau, double& v_lo, double& v_hi) {
        const double dq = std::exp(-q * tau), dr = std::exp(-r * tau);
        const double call_hi = std::max(S_hi * dq - K * dr, 0.0), put_lo = std::max(K * dr - S_lo * dq, 0.0);
        v_lo = call ? 0.0 : (american ? std::max(put_lo, K - S_lo) : put_lo);
        v_hi = call ? (american ? std::max(call_hi, S_hi - K) : call_hi) : 0.0;
        // at the barrier the option is extinguished and worth only its rebate: that amount at the hit, or its
        // discounted value when the rebate is not paid until expiry
        if (knock) {
            (spec.up ? v_hi : v_lo) = spec.rebate > 0.0
                ? (spec.rebate_at_hit ? spec.rebate : spec.rebate * std::exp(-r * tau))
                : 0.0;
        }
    };
    ends(0.0, V[0], V[n]);

    // At a monitoring date every node at or beyond the barrier is extinguished and left holding the rebate — the
    // knock-out as a jump between otherwise plain Black-Scholes steps. The dates are k·T/m for k = 1…m, so the
    // barrier is tested at expiry too, which is why this runs once before the march as well as during it.
    const int ib = spec.up ? i0 + mb : i0 - mb;
    auto knock_out = [&](double tau) {
        const double v = spec.rebate > 0.0 ? (spec.rebate_at_hit ? spec.rebate : spec.rebate * std::exp(-r * tau)) : 0.0;
        if (spec.up) {
            for (int i = ib + 1; i <= n; ++i) V[i] = v;
        } else {
            for (int i = 0; i < ib; ++i) V[i] = v;
        }
        // The barrier sits at the centre of its node's cell, so only half of that cell is extinguished: killing all
        // of it throws away half a cell of live value and costs an order of accuracy, the same reason the payoff is
        // cell-averaged across the strike. Averaging the dead and live halves keeps the scheme second order.
        V[ib] = 0.5 * (v + V[ib]);
    };
    if (monitored) knock_out(0.0);

    const double idx2 = 1.0 / (dx * dx), i2dx = 0.5 / dx, idx = 1.0 / dx;

    // (I − h·L(t)) V = base at τ_new, t = T − τ_new, with V ≥ intrinsic when American. Returns the exercise boundary node.
    auto implicit = [&](double h, double tau_new) -> int {
        local_variance_row(s, std::max(T - tau_new, 0.0), x, N, sig2);
        for (int i = 1; i < n; ++i) {
            const double v = sig2[i];
            const double drift = r - q - 0.5 * v;
            const double d = 0.5 * v * idx2;
            double a, b, c;
            if (v >= std::fabs(drift) * dx) {                 // central differences
                a = d - drift * i2dx; b = -2.0 * d - r; c = d + drift * i2dx;
            } else if (drift > 0.0) {                         // upwind where the drift dominates the diffusion
                a = d; b = -2.0 * d - drift * idx - r; c = d + drift * idx;
            } else {
                a = d - drift * idx; b = -2.0 * d + drift * idx - r; c = d;
            }
            lower[i] = -h * a;
            diag[i] = 1.0 - h * b;
            upper[i] = -h * c;
            rhs[i] = base[i];
        }
        double v_lo, v_hi;
        ends(tau_new, v_lo, v_hi);
        rhs[1] -= lower[1] * v_lo;
        rhs[n - 1] -= upper[n - 1] * v_hi;
        V[0] = v_lo;
        V[n] = v_hi;
        if (!american) {
            thomas(n, lower, diag, upper, rhs, wc, wd, V);
            return -1;
        }
        // Policy iteration (Howard) on min(A·V − b, V − intrinsic) = 0: every row is either the PDE or "exercise",
        // whichever residual is smaller at the current iterate. Exact for this M-matrix whatever the exercise
        // region's shape, and warm-started from the previous step's policy it usually settles in two or three solves.
        int it = 0;
        for (;;) {
            ++it;
            for (int i = 1; i < n; ++i) {
                const bool e = exercise[i] != 0.0;
                ml[i] = e ? 0.0 : lower[i];
                md[i] = e ? 1.0 : diag[i];
                mu[i] = e ? 0.0 : upper[i];
                mr[i] = e ? ex[i] : rhs[i];
            }
            thomas(n, ml, md, mu, mr, wc, wd, V);
            bool changed = false;
            for (int i = 1; i < n; ++i) {
                const double pde = (i > 1 ? lower[i] * V[i - 1] : 0.0) + diag[i] * V[i] + (i < n - 1 ? upper[i] * V[i + 1] : 0.0) - rhs[i];
                const double obstacle = V[i] - ex[i];
                const double tol = 1e-12 * (std::fabs(rhs[i]) + ex[i] + 1.0);
                const bool e = exercise[i] != 0.0;
                const bool next = e ? !(pde < obstacle - tol) : (obstacle < pde - tol);
                if (next != e) {
                    exercise[i] = next ? 1.0 : 0.0;
                    changed = true;
                }
            }
            if (!changed || it >= n) break;
        }
        res.lcp_iterations = std::max(res.lcp_iterations, it);
        int boundary = -1;                                    // a put's highest exercised node, a call's lowest
        for (int i = 1; i < n; ++i) {
            if (exercise[i] != 0.0 && ex[i] > 0.0 && (boundary < 0 || !call)) boundary = i;
        }
        return boundary;
    };

    // Calendar time graded towards today, t = T·u² with u uniform: the steps shrink where SSVI's local variance is
    // singular (t → 0) and are twice the uniform size at expiry. Steps 1–2 are two implicit Euler half steps each,
    // smoothing the payoff's kink; then variable-step BDF2 (L-stable, second order), coefficients at the new level.
    auto tau_at = [T, steps](int j) {
        const double u = 1.0 - static_cast<double>(j) / steps;
        return j == steps ? T : T * (1.0 - u * u);
    };
    // Step boundaries: the graded grid with every monitoring date merged in, so the march lands on each date exactly.
    // Merging keeps the grading rather than re-deriving it, and the BDF2 step already takes a variable size.
    const int n_mon = monitored ? spec.n_monitors : 0;
    const std::size_t cap = static_cast<std::size_t>(steps) + static_cast<std::size_t>(n_mon) + 2;
    double* taus = static_cast<double*>(std::calloc(cap, sizeof(double)));
    unsigned char* is_mon = static_cast<unsigned char*>(std::calloc(cap, sizeof(unsigned char)));
    if (!taus || !is_mon) { std::free(taus); std::free(is_mon); std::free(block); return invalid_pde(); }
    std::size_t n_tau = 0;
    {
        const double far = 2.0 * T + 1.0, eps = 1e-12 * T;
        int j = 1, k = n_mon - 1;                             // graded steps, and monitoring dates in rising τ
        while (j <= steps || k >= 1) {
            const double tg = j <= steps ? tau_at(j) : far;
            const double tm = k >= 1 ? T * (1.0 - static_cast<double>(k) / n_mon) : far;
            double t;
            bool   mon;
            if (tm < tg - eps)      { t = tm; mon = true;  --k; }
            else if (tg < tm - eps) { t = tg; mon = false; ++j; }
            else                    { t = tg; mon = true;  ++j; --k; }
            if (n_tau > 0 && t <= taus[n_tau - 1] + eps) {
                if (mon) is_mon[n_tau - 1] = 1;
                continue;
            }
            taus[n_tau] = t;
            is_mon[n_tau] = mon ? 1 : 0;
            ++n_tau;
        }
    }
    res.steps = static_cast<int>(n_tau);

    std::size_t target = 0, written = 0;                      // boundary samples at τ = T/64, 2T/64, …, T
    double t_now = 0.0, t_back = 0.0;                         // this level's τ and the one before it
    int since_restart = 0;                                    // implicit Euler for two steps, and after every jump
    for (std::size_t idx = 0; idx < n_tau; ++idx) {
        const double ta = t_now, tb = taus[idx], h = tb - ta;
        if (!(h > 0.0)) continue;
        int boundary;
        if (since_restart < 2) {
            std::copy(V, V + N, Vprev);
            const double tm = 0.5 * (ta + tb);
            std::copy(V, V + N, base);
            implicit(0.5 * h, tm);
            std::copy(V, V + N, base);
            boundary = implicit(0.5 * h, tb);
        } else {
            const double w = h / (ta - t_back);
            const double a0 = (1.0 + 2.0 * w) / (1.0 + w), a1 = 1.0 + w, a2 = w * w / (1.0 + w);
            for (std::size_t i = 0; i < N; ++i) base[i] = (a1 * V[i] - a2 * Vprev[i]) / a0;
            std::copy(V, V + N, Vprev);
            boundary = implicit(h / a0, tb);
        }
        t_back = ta;
        t_now = tb;
        ++since_restart;
        // the jump leaves a fresh discontinuity at the barrier, so the next steps restart with implicit Euler
        if (is_mon[idx]) { knock_out(tb); since_restart = 0; }
        if (american && target < kPdeBoundaryPoints && tb >= T * static_cast<double>(target + 1) / kPdeBoundaryPoints * (1.0 - 1e-12)) {
            res.boundary_tau[written] = tb;
            res.boundary_S[written] = boundary >= 0 ? std::exp(x[boundary]) : kNaN;
            ++written;
            while (target < kPdeBoundaryPoints && tb >= T * static_cast<double>(target + 1) / kPdeBoundaryPoints * (1.0 - 1e-12)) ++target;
        }
    }
    std::free(taus);
    std::free(is_mon);
    res.n_boundary = static_cast<int>(written);

    const double Vm = V[i0 - 1], V0 = V[i0], Vp = V[i0 + 1];
    const double Vx = (Vp - Vm) * i2dx, Vxx = (Vp - 2.0 * V0 + Vm) * idx2;
    double v0 = 0.0;
    local_variance_row(s, 0.0, &x0, 1, &v0);
    res.price = V0;
    res.delta = Vx / S;
    res.gamma = (Vxx - Vx) / (S * S);
    const bool at_exercise = american && exercise[i0] != 0.0 && ex[i0] > 0.0;
    res.theta = at_exercise ? 0.0 : r * V0 - (r - q - 0.5 * v0) * Vx - 0.5 * v0 * Vxx;
    std::free(block);
    return res;
}

} // namespace

PdeResult pde_price(const PdeSpec& spec, const VolSurface& s, int nodes, int steps, bool want_vega) {
    // One grid for all three solves: the half-width scale comes from the base surface, so a vega bump moves the
    // volatility without moving the nodes and the difference reflects that change alone.
    const double sd = spec.T > 0.0 ? std::max(implied_vol(s, s.S, spec.T), 0.05) * std::sqrt(spec.T) : 0.0;
    PdeResult res = pde_solve(spec, s, nodes, steps, sd);
    if (!want_vega || std::isnan(res.price)) return res;

    // Vega is not a grid derivative: bump the surface's ATM level either side and re-solve. The smile and term
    // structure are written relative to that level, so they move with it and this is the value's sensitivity to the
    // whole surface shifting. Two extra solves, which is why the caller has to ask.
    // Two tenths of a vol point, and never enough to take sigma to zero. Measured against the closed form: above
    // this the central difference's own O(h²) bias dominates (1.6e-4 relative in the wings at half a point), below it
    // the price's error amplified by 1/2h does. At 0.002 the solver's vega is within 4.5e-5 of the closed form in
    // the wings and 4e-7 at the money.
    const double h = std::min(0.002, 0.5 * s.sigma);
    if (!(h > 0.0)) return res;
    VolSurface up = s, down = s;
    up.sigma = s.sigma + h;
    down.sigma = s.sigma - h;
    const double vu = pde_solve(spec, up, nodes, steps, sd).price;
    const double vd = pde_solve(spec, down, nodes, steps, sd).price;
    res.vega = (vu - vd) / (2.0 * h);
    return res;
}

} // namespace quantcore
