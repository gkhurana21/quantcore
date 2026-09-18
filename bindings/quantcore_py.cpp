#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>

#include <algorithm>
#include <stdexcept>

#include "quantcore/black_scholes.hpp"
#include "quantcore/monte_carlo.hpp"
#include "quantcore/black_scholes_batch.hpp"
#include "quantcore/monte_carlo_mt.hpp"
#include "quantcore/monte_carlo_portfolio.hpp"
#include "quantcore/local_vol.hpp"
#include "quantcore/exotics.hpp"
#include "quantcore/lsm.hpp"
#include "quantcore/pde.hpp"
#ifdef __APPLE__
#  include "quantcore/monte_carlo_gpu.hpp"
#endif

#include <cmath>
#include <string>
#include <vector>

namespace py = pybind11;
using namespace pybind11::literals;
using namespace quantcore;

// A volatility surface from the dashboard's Market JSON:
//   {"S", "sigma", "r", "q"?, "smile"?: {"rho", "eta", "gamma"}, "smileSpot"?,
//    "term"?: {"kind": "curve", "ratio", "halfLife"} | {"kind": "fitted", "T": [...], "w": [...]}}
static VolSurface surface_from(const py::dict& m) {
    auto has = [&m](const char* key) { return m.contains(key) && !m[key].is_none(); };
    auto num = [&m, &has](const char* key) {
        if (!has(key)) throw std::invalid_argument(std::string("market needs ") + key);
        return m[key].cast<double>();
    };
    VolSurface s;
    s.S = num("S");
    s.sigma = num("sigma");
    s.r = num("r");
    s.q = has("q") ? m["q"].cast<double>() : 0.0;
    if (has("smile")) {
        const py::dict sm = m["smile"].cast<py::dict>();
        s.smile = true;
        s.rho = sm["rho"].cast<double>();
        s.eta = sm["eta"].cast<double>();
        s.gamma = sm["gamma"].cast<double>();
    }
    if (has("smileSpot")) s.smile_spot = m["smileSpot"].cast<double>();
    if (has("term")) {
        const py::dict t = m["term"].cast<py::dict>();
        const std::string kind = t["kind"].cast<std::string>();
        if (kind == "curve") {
            s.term = TermKind::Curve;
            s.ratio = t["ratio"].cast<double>();
            s.half_life = t["halfLife"].cast<double>();
        } else if (kind == "fitted") {
            const std::vector<double> T = t["T"].cast<std::vector<double>>(), w = t["w"].cast<std::vector<double>>();
            if (T.empty() || T.size() != w.size() || T.size() > kMaxTermPillars)
                throw std::invalid_argument("a fitted term structure needs 1 to 32 pillars of T and w");
            s.term = TermKind::Fitted;
            s.n_pillars = static_cast<int>(T.size());
            std::copy(T.begin(), T.end(), s.pillar_T);
            std::copy(w.begin(), w.end(), s.pillar_w);
        } else {
            throw std::invalid_argument("term kind must be 'curve' or 'fitted'");
        }
    }
    return s;
}

// An exotic from {"kind": "barrier"|"asian", "call", "K", "T", "up"?, "levels"?: [...], "fixings"?}
static ExoticSpec exotic_from(const py::dict& d) {
    ExoticSpec e;
    const std::string kind = d["kind"].cast<std::string>();
    e.type = d["call"].cast<bool>() ? OptionType::Call : OptionType::Put;
    e.K = d["K"].cast<double>();
    e.T = d["T"].cast<double>();
    if (kind == "barrier") {
        e.kind = ExoticKind::Barrier;
        e.up = d["up"].cast<bool>();
        const std::vector<double> levels = d["levels"].cast<std::vector<double>>();
        if (levels.empty() || levels.size() > kMaxBarrierLevels) throw std::invalid_argument("a barrier needs 1 to 16 levels");
        e.n_levels = static_cast<int>(levels.size());
        std::copy(levels.begin(), levels.end(), e.levels);
        // absent, none or 0 monitors the barrier continuously
        if (d.contains("monitors") && !d["monitors"].is_none()) e.n_monitors = d["monitors"].cast<int>();
        // absent or 0 pays no rebate; "rebate_at_hit" false pays it at expiry instead
        if (d.contains("rebate") && !d["rebate"].is_none()) e.rebate = d["rebate"].cast<double>();
        if (d.contains("rebate_at_hit") && !d["rebate_at_hit"].is_none()) e.rebate_at_hit = d["rebate_at_hit"].cast<bool>();
    } else if (kind == "asian") {
        e.kind = ExoticKind::Asian;
        e.n_fixings = d["fixings"].cast<int>();
    } else {
        throw std::invalid_argument("kind must be 'barrier' or 'asian'");
    }
    return e;
}

static py::object finite_or_none(double v) { return std::isnan(v) ? py::object(py::none()) : py::object(py::float_(v)); }

static py::dict exotic_dict(const ExoticResult& r) {
    py::list out, out_se, out_fb, in, in_se;
    for (int j = 0; j < r.n_levels; ++j) {
        out.append(r.out[j]); out_se.append(r.out_se[j]); out_fb.append(finite_or_none(r.out_fine_bias[j]));
        in.append(r.in[j]); in_se.append(r.in_se[j]);
    }
    return py::dict("paths"_a = r.paths, "steps"_a = r.steps, "monitors"_a = r.n_monitors,
                    "vanilla"_a = finite_or_none(r.vanilla), "vanilla_se"_a = finite_or_none(r.vanilla_se),
                    "vanilla_fine_bias"_a = finite_or_none(r.vanilla_fine_bias),
                    "out"_a = out, "out_se"_a = out_se, "out_fine_bias"_a = out_fb, "in"_a = in, "in_se"_a = in_se,
                    "arith"_a = finite_or_none(r.arith), "arith_se"_a = finite_or_none(r.arith_se),
                    "arith_fine_bias"_a = finite_or_none(r.arith_fine_bias),
                    "geo"_a = finite_or_none(r.geo), "geo_se"_a = finite_or_none(r.geo_se),
                    "arith_geo_cov"_a = finite_or_none(r.arith_geo_cov));
}

// A finite-difference option from {"kind": "european"|"american"|"knockout", "call", "K", "T", "H"?, "up"?,
// "rebate"?, "rebate_at_hit"?}
static PdeSpec pde_from(const py::dict& d) {
    PdeSpec p;
    const std::string kind = d["kind"].cast<std::string>();
    if (kind == "european") p.kind = PdeKind::European;
    else if (kind == "american") p.kind = PdeKind::American;
    else if (kind == "knockout") p.kind = PdeKind::KnockOut;
    else throw std::invalid_argument("kind must be 'european', 'american' or 'knockout'");
    p.type = d["call"].cast<bool>() ? OptionType::Call : OptionType::Put;
    p.K = d["K"].cast<double>();
    p.T = d["T"].cast<double>();
    if (p.kind == PdeKind::KnockOut) {
        p.H = d["H"].cast<double>();
        p.up = d["up"].cast<bool>();
        // absent or 0 pays no rebate; "rebate_at_hit" false pays it at expiry instead
        if (d.contains("rebate") && !d["rebate"].is_none()) p.rebate = d["rebate"].cast<double>();
        if (d.contains("rebate_at_hit") && !d["rebate_at_hit"].is_none()) p.rebate_at_hit = d["rebate_at_hit"].cast<bool>();
        // absent or 0 monitors the barrier continuously
        if (d.contains("monitors") && !d["monitors"].is_none()) p.n_monitors = d["monitors"].cast<int>();
    }
    return p;
}

static py::dict local_vol_dict(const LocalVolResult& res) {
    return py::dict("price"_a = res.price, "std_error"_a = res.std_error, "paths"_a = res.paths,
                    "steps"_a = res.steps,
                    "fine_bias"_a = std::isnan(res.fine_bias) ? py::object(py::none()) : py::object(py::float_(res.fine_bias)));
}

// ── batch helpers ─────────────────────────────────────────────────────────────
//
// The Python→C++ boundary is crossed once per batch, not once per option.
// C++ loops over the arrays; no GIL re-acquisition per element.

using DoubleArray = py::array_t<double, py::array::c_style | py::array::forcecast>;

// Dividend yields for a batch: None → all zero, a scalar → broadcast to every
// option, or an array with one entry per option.
static DoubleArray dividend_yields(const py::object& q_obj, py::ssize_t n) {
    DoubleArray out(n);
    double* dst = out.mutable_data();
    if (q_obj.is_none()) {
        std::fill(dst, dst + n, 0.0);
        return out;
    }
    DoubleArray q = q_obj.cast<DoubleArray>();
    if (q.size() == 1) {
        std::fill(dst, dst + n, *q.data());
    } else if (q.ndim() == 1 && q.size() == n) {
        std::copy(q.data(), q.data() + n, dst);
    } else {
        throw std::invalid_argument("q must be None, a scalar, or a 1-D array the same length as S");
    }
    return out;
}

// Portfolio legs from parallel arrays (is_call as 0/1), validated for equal length.
static std::vector<PortfolioLeg> portfolio_legs(DoubleArray is_call, DoubleArray K, DoubleArray T,
                                                DoubleArray sigma, DoubleArray weight) {
    const py::ssize_t n = K.size();
    if (is_call.size() != n || T.size() != n || sigma.size() != n || weight.size() != n)
        throw std::invalid_argument("is_call, K, T, sigma and weight must have the same length");
    if (n > static_cast<py::ssize_t>(kPortfolioMaxLegs))
        throw std::invalid_argument("at most 64 legs per portfolio");
    std::vector<PortfolioLeg> legs(static_cast<std::size_t>(n));
    for (py::ssize_t i = 0; i < n; ++i) {
        legs[static_cast<std::size_t>(i)] = PortfolioLeg{
            is_call.data()[i] != 0.0 ? OptionType::Call : OptionType::Put,
            K.data()[i], T.data()[i], sigma.data()[i], weight.data()[i]};
    }
    return legs;
}

static py::array_t<double>
batch_bs_price_impl(bool is_call, DoubleArray S, DoubleArray K, DoubleArray r,
                    DoubleArray sigma, DoubleArray T, const py::object& q_obj) {
    auto n = S.size();
    // Python objects (dividend array, output array) are created with the GIL
    // held; the GIL is released only around the pure C++ loop over raw memory.
    DoubleArray q = dividend_yields(q_obj, n);
    auto out = py::array_t<double>(n);
    auto s_ = S.unchecked<1>(), k_ = K.unchecked<1>(), r_ = r.unchecked<1>(),
         sg_ = sigma.unchecked<1>(), t_ = T.unchecked<1>(), q_ = q.unchecked<1>();
    auto o_ = out.mutable_unchecked<1>();
    OptionType type = is_call ? OptionType::Call : OptionType::Put;
    {
        py::gil_scoped_release release;
        for (py::ssize_t i = 0; i < n; ++i)
            o_(i) = bsm_price(type, s_(i), k_(i), r_(i), sg_(i), t_(i), q_(i));
    }
    return out;
}

// Returns shape (N, 5): columns = [price, delta, gamma, theta, vega]
static py::array_t<double>
batch_bs_full_impl(bool is_call, DoubleArray S, DoubleArray K, DoubleArray r,
                   DoubleArray sigma, DoubleArray T, const py::object& q_obj) {
    auto n = S.size();
    DoubleArray q = dividend_yields(q_obj, n);
    auto out = py::array_t<double>({(py::ssize_t)n, (py::ssize_t)5});
    auto s_ = S.unchecked<1>(), k_ = K.unchecked<1>(), r_ = r.unchecked<1>(),
         sg_ = sigma.unchecked<1>(), t_ = T.unchecked<1>(), q_ = q.unchecked<1>();
    auto o_ = out.mutable_unchecked<2>();
    OptionType type = is_call ? OptionType::Call : OptionType::Put;
    {
        py::gil_scoped_release release;   // see batch_bs_price_impl
        for (py::ssize_t i = 0; i < n; ++i) {
            BSMResult res = bsm_full(type, s_(i), k_(i), r_(i), sg_(i), t_(i), q_(i));
            o_(i, 0) = res.price;
            o_(i, 1) = res.greeks.delta;
            o_(i, 2) = res.greeks.gamma;
            o_(i, 3) = res.greeks.theta;
            o_(i, 4) = res.greeks.vega;
        }
    }
    return out;
}

// ── module definition ─────────────────────────────────────────────────────────

PYBIND11_MODULE(quantcore, m) {
    m.doc() = "QuantCore: C++ options pricing engine (Black-Scholes-Merton, Monte Carlo, Metal GPU)";

    py::enum_<OptionType>(m, "OptionType")
        .value("Call", OptionType::Call)
        .value("Put",  OptionType::Put)
        .export_values();

    // ── scalar API ────────────────────────────────────────────────────────────
    m.def("bs_price",
          [](int type_int, double S, double K, double r, double sigma, double T, double q) {
              return bsm_price(static_cast<OptionType>(type_int), S, K, r, sigma, T, q);
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"), py::arg("q") = 0.0,
          "Black-Scholes-Merton price for a European option (q = continuous dividend yield).");

    m.def("bs_full",
          [](int type_int, double S, double K, double r, double sigma, double T, double q) {
              // GIL released for the C++ computation; re-acquired before
              // constructing the Python dict.  Allows concurrent WebSocket
              // handlers to overlap their pricing calls without serialising
              // on Python's GIL.
              BSMResult res;
              {
                  py::gil_scoped_release release;
                  res = bsm_full(static_cast<OptionType>(type_int), S, K, r, sigma, T, q);
              }
              return py::dict(
                  "price"_a = res.price,
                  "delta"_a = res.greeks.delta,
                  "gamma"_a = res.greeks.gamma,
                  "theta"_a = res.greeks.theta,
                  "vega"_a  = res.greeks.vega
              );
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"), py::arg("q") = 0.0,
          "Black-Scholes-Merton price + analytic Greeks. GIL released during C++ compute.");

    m.def("mc_price",
          [](int type_int, double S, double K, double r, double sigma, double T,
             long long paths, uint64_t seed, double q) {
              MCResult res;
              {
                  py::gil_scoped_release release;   // GIL released during MC sim
                  res = mc_price(static_cast<OptionType>(type_int),
                                 S, K, r, sigma, T, paths, seed, q);
              }
              return py::dict(
                  "price"_a     = res.price,
                  "std_error"_a = res.std_error,
                  "paths"_a     = res.paths
              );
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          py::arg("paths"), py::arg("seed") = 42ULL, py::arg("q") = 0.0,
          "GBM Monte Carlo price for a European option. GIL released during sim.");

    // ── batch API (one Python→C++ crossing per batch) ─────────────────────────
    // The GIL is released inside the impls around the compute loop only. (A
    // call_guard released it for the whole call, including the NumPy output
    // allocation, which segfaulted.)
    m.def("batch_bs_price", &batch_bs_price_impl,
          py::arg("is_call"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"), py::arg("q") = py::none(),
          "Batch BSM price. Returns 1-D array of length N. q: None, scalar or array. "
          "GIL released during compute.");

    m.def("batch_bs_full", &batch_bs_full_impl,
          py::arg("is_call"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"), py::arg("q") = py::none(),
          "Batch BSM price+Greeks. Returns shape (N,5): [price,delta,gamma,theta,vega]. "
          "q: None, scalar or array. GIL released during compute.");

    // ── Phase 2b: Accelerate-SIMD batch BS (benchmark kernel, no dividend yield) ──
    m.def("batch_bs_full_accel",
          [](bool is_call, DoubleArray S, DoubleArray K, DoubleArray r, DoubleArray sigma, DoubleArray T) {
              auto n   = (std::size_t)S.size();
              auto out = py::array_t<double>({(py::ssize_t)n, (py::ssize_t)5});
              batch_bs_full_accel(is_call,
                                   S.data(), K.data(), r.data(),
                                   sigma.data(), T.data(), n,
                                   out.mutable_data());
              return out;
          },
          py::arg("is_call"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          "SIMD batch BS (Apple Accelerate vvexp/vvlog/vvsqrt + NEON polynomial N(x))."
          " Returns shape (N,5).");

    // ── Phase 2b: multithreaded + SIMD MC ────────────────────────────────────
    m.def("mc_price_mt",
          [](int type_int, double S, double K, double r, double sigma, double T,
             long long paths, uint64_t seed, int n_threads, double q) {
              MCResult res = mc_price_mt(static_cast<OptionType>(type_int),
                                         S, K, r, sigma, T, paths, seed, n_threads, q);
              return py::dict(
                  "price"_a     = res.price,
                  "std_error"_a = res.std_error,
                  "paths"_a     = res.paths
              );
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          py::arg("paths"), py::arg("seed") = 42ULL, py::arg("n_threads") = -1,
          py::arg("q") = 0.0,
          "Multithreaded GBM MC (vvexp SIMD + std::thread). "
          "n_threads=-1 uses hardware_concurrency.");

    // ── Portfolio MC: every leg on one Brownian path, each at its own volatility ──
    m.def("mc_portfolio",
          [](DoubleArray is_call, DoubleArray K, DoubleArray T, DoubleArray sigma, DoubleArray weight,
             double S, double r, double q, long long paths, uint64_t seed, bool antithetic) {
              const std::vector<PortfolioLeg> legs = portfolio_legs(is_call, K, T, sigma, weight);
              MCResult res;
              {
                  py::gil_scoped_release release;
                  res = mc_portfolio(legs.data(), legs.size(), S, r, q, paths, seed, antithetic);
              }
              return py::dict("price"_a = res.price, "std_error"_a = res.std_error, "paths"_a = res.paths);
          },
          py::arg("is_call"), py::arg("K"), py::arg("T"), py::arg("sigma"), py::arg("weight"),
          py::arg("S"), py::arg("r"), py::arg("q") = 0.0, py::arg("paths") = 1000000LL,
          py::arg("seed") = 42ULL, py::arg("antithetic") = false,
          "Monte Carlo $ value of a European option portfolio: one Brownian path observed at every leg "
          "expiry, each leg lognormal at its own volatility (weight = signed qty x multiplier).");

    // ── Volatility surface and Dupire local volatility ─────────────────────────
    m.def("implied_vol",
          [](const py::dict& market, double K, double T) { return implied_vol(surface_from(market), K, T); },
          py::arg("market"), py::arg("K"), py::arg("T"),
          "Implied volatility of strike K at expiry T on the market's SSVI smile and ATM term structure.");

    m.def("local_vol",
          [](const py::dict& market, double S, double t) { return local_vol(surface_from(market), S, t); },
          py::arg("market"), py::arg("S"), py::arg("t"),
          "Dupire local volatility at spot S and time t implied by the market's surface.");

    m.def("mc_local_vol",
          [](DoubleArray is_call, DoubleArray K, DoubleArray T, DoubleArray weight, const py::dict& market,
             long long paths, uint64_t seed, double steps_per_year, bool extrapolate, int n_threads) {
              DoubleArray unused(K.size());
              std::fill(unused.mutable_data(), unused.mutable_data() + unused.size(), 0.0);
              const std::vector<PortfolioLeg> legs = portfolio_legs(is_call, K, T, unused, weight);
              const VolSurface s = surface_from(market);
              LocalVolResult res;
              {
                  py::gil_scoped_release release;
                  res = n_threads == 0
                      ? mc_local_vol(legs.data(), legs.size(), s, paths, seed, steps_per_year, extrapolate)
                      : mc_local_vol_mt(legs.data(), legs.size(), s, paths, seed, steps_per_year, extrapolate, n_threads);
              }
              return local_vol_dict(res);
          },
          py::arg("is_call"), py::arg("K"), py::arg("T"), py::arg("weight"), py::arg("market"),
          py::arg("paths") = 1000000LL, py::arg("seed") = 42ULL, py::arg("steps_per_year") = 365.0,
          py::arg("extrapolate") = true, py::arg("n_threads") = 0,
          "Monte Carlo $ value of a European portfolio under the market's Dupire local volatility (log-Euler, "
          "optionally with coupled Richardson extrapolation). n_threads=0 runs the scalar kernel; -1 uses every "
          "core (seed + t x golden ratio per thread; one thread equals the scalar kernel).");

    // ── Exotics: barrier and Asian options ─────────────────────────────────────
    m.def("barrier_prices",
          [](bool call, bool up, double S, double K, double H, double T, double sigma, double r, double q) {
              const BarrierPrices p = barrier_prices(call ? OptionType::Call : OptionType::Put, up, S, K, H, T, sigma, r, q);
              return py::dict("out"_a = p.out, "in"_a = p.in, "vanilla"_a = p.vanilla);
          },
          py::arg("call"), py::arg("up"), py::arg("S"), py::arg("K"), py::arg("H"), py::arg("T"), py::arg("sigma"),
          py::arg("r"), py::arg("q") = 0.0,
          "Continuously monitored barrier option without rebate (Reiner & Rubinstein): knock-out, knock-in, vanilla.");

    m.def("barrier_prices_discrete",
          [](bool call, bool up, double S, double K, double H, double T, double sigma, double r, double q,
             int monitors) {
              const BarrierPrices p = barrier_prices_discrete(call ? OptionType::Call : OptionType::Put, up, S, K, H, T,
                                                              sigma, r, q, monitors);
              return py::dict("out"_a = p.out, "in"_a = p.in, "vanilla"_a = p.vanilla);
          },
          py::arg("call"), py::arg("up"), py::arg("S"), py::arg("K"), py::arg("H"), py::arg("T"), py::arg("sigma"),
          py::arg("r"), py::arg("q") = 0.0, py::arg("monitors") = 0,
          "Barrier option monitored at `monitors` equally spaced dates, by the Broadie-Glasserman-Kou correction: the "
          "continuous formula with the barrier moved away from the spot to H*exp(+/-beta*sigma*sqrt(T/m)), "
          "beta = -zeta(1/2)/sqrt(2*pi). A discretely monitored knock-out is worth more than the continuously "
          "monitored one; monitors < 1 prices continuous monitoring.");

    m.def("barrier_prices_rebate",
          [](bool call, bool up, double S, double K, double H, double T, double sigma, double r, double q,
             double rebate, bool at_hit) {
              const BarrierPrices p = barrier_prices_rebate(call ? OptionType::Call : OptionType::Put, up, S, K, H, T,
                                                            sigma, r, q, rebate, at_hit);
              return py::dict("out"_a = p.out, "in"_a = p.in, "vanilla"_a = p.vanilla);
          },
          py::arg("call"), py::arg("up"), py::arg("S"), py::arg("K"), py::arg("H"), py::arg("T"), py::arg("sigma"),
          py::arg("r"), py::arg("q") = 0.0, py::arg("rebate") = 0.0, py::arg("at_hit") = true,
          "Barrier option paying a rebate (Reiner & Rubinstein's E and F terms): the knock-out pays it on hitting the "
          "barrier when at_hit, otherwise at expiry, and the knock-in pays it at expiry when the barrier is never "
          "touched. A rebate breaks in-out parity - paid at expiry, in + out exceeds the vanilla by exactly "
          "rebate*exp(-r*T). rebate 0 is the plain barrier.");

    m.def("geometric_asian_price",
          [](bool call, double S, double K, double T, int n_fixings, double sigma, double r, double q) {
              return geometric_asian_price(call ? OptionType::Call : OptionType::Put, S, K, T, n_fixings, sigma, r, q);
          },
          py::arg("call"), py::arg("S"), py::arg("K"), py::arg("T"), py::arg("n_fixings"), py::arg("sigma"),
          py::arg("r"), py::arg("q") = 0.0,
          "Geometric-average Asian option on n equally spaced fixings, flat volatility.");

    m.def("mc_exotic",
          [](const py::dict& spec, const py::dict& market, long long paths, uint64_t seed, double steps_per_year,
             bool extrapolate, int n_threads) {
              const ExoticSpec e = exotic_from(spec);
              const VolSurface s = surface_from(market);
              ExoticResult res;
              {
                  py::gil_scoped_release release;
                  res = n_threads == 0 ? mc_exotic(e, s, paths, seed, steps_per_year, extrapolate)
                                       : mc_exotic_mt(e, s, paths, seed, steps_per_year, extrapolate, n_threads);
              }
              return exotic_dict(res);
          },
          py::arg("spec"), py::arg("market"), py::arg("paths") = 400000LL, py::arg("seed") = 42ULL,
          py::arg("steps_per_year") = 365.0, py::arg("extrapolate") = true, py::arg("n_threads") = 0,
          "Barrier (Brownian-bridge monitoring, several levels on the same paths) or Asian option under the market's "
          "local volatility; values per unit of underlying.");

    m.def("pde_price",
          [](const py::dict& spec, const py::dict& market, int nodes, int steps, bool vega) {
              const PdeSpec p = pde_from(spec);
              const VolSurface s = surface_from(market);
              PdeResult r;
              {
                  py::gil_scoped_release release;
                  r = pde_price(p, s, nodes, steps, vega);
              }
              py::list tau, spot;
              for (int j = 0; j < r.n_boundary; ++j) {
                  tau.append(r.boundary_tau[j]);
                  spot.append(finite_or_none(r.boundary_S[j]));
              }
              return py::dict("price"_a = finite_or_none(r.price), "delta"_a = finite_or_none(r.delta),
                              "gamma"_a = finite_or_none(r.gamma), "theta"_a = finite_or_none(r.theta),
                              "vega"_a = finite_or_none(r.vega),
                              "nodes"_a = r.nodes, "steps"_a = r.steps, "lcp_iterations"_a = r.lcp_iterations,
                              "boundary_tau"_a = tau, "boundary_S"_a = spot);
          },
          py::arg("spec"), py::arg("market"), py::arg("nodes") = 801, py::arg("steps") = 800, py::arg("vega") = false,
          "European, American or knock-out option under the market's local volatility by finite differences: price, "
          "grid Greeks and the early-exercise boundary; values per unit of underlying. vega=True also returns dV/dsigma "
          "by a central bump of the surface's ATM level re-solved on the same grid, which costs two extra solves; "
          "without it the returned vega is 0.");

    m.def("lsm_american",
          [](bool call, double K, double T, const py::dict& market, long long policy_paths, long long value_paths,
             uint64_t seed, int dates, double steps_per_year) {
              const VolSurface s = surface_from(market);
              LsmResult r;
              {
                  py::gil_scoped_release release;
                  r = lsm_american(call ? OptionType::Call : OptionType::Put, K, T, s, policy_paths, value_paths,
                                   seed, dates, steps_per_year);
              }
              return py::dict("price"_a = finite_or_none(r.price), "std_error"_a = finite_or_none(r.std_error),
                              "policy_price"_a = finite_or_none(r.policy_price),
                              "european"_a = finite_or_none(r.european), "european_se"_a = finite_or_none(r.european_se),
                              "policy_paths"_a = r.policy_paths, "value_paths"_a = r.value_paths, "dates"_a = r.dates,
                              "steps"_a = r.steps, "exercise_dates"_a = r.exercise_dates);
          },
          py::arg("call"), py::arg("K"), py::arg("T"), py::arg("market"), py::arg("policy_paths") = 100000LL,
          py::arg("value_paths") = 400000LL, py::arg("seed") = 42ULL, py::arg("dates") = 52, py::arg("steps_per_year") = 365.0,
          "American option under the market's local volatility by Longstaff-Schwartz: a regression policy on one set of "
          "paths, valued out of sample on another, so the price is low biased; values per unit of underlying.");

    m.def("lsm_american_bounds",
          [](bool call, double K, double T, const py::dict& market, long long policy_paths, long long value_paths,
             long long outer_paths, long long inner_paths, uint64_t seed, int dates, double steps_per_year) {
              const VolSurface s = surface_from(market);
              LsmResult        lo;
              LsmDualResult    up{};
              up.upper = up.std_error = std::nan("");
              {
                  py::gil_scoped_release release;
                  LsmPolicy              policy;
                  lo = lsm_american_policy(call ? OptionType::Call : OptionType::Put, K, T, s, policy_paths,
                                           value_paths, seed, dates, steps_per_year, &policy);
                  // the policy is left untouched when the lower bound is invalid, so there is nothing to bound
                  if (std::isfinite(lo.price)) {
                      up = lsm_dual_bound(policy, s, outer_paths, inner_paths, seed + 1, steps_per_year);
                  }
              }
              return py::dict("price"_a = finite_or_none(lo.price), "std_error"_a = finite_or_none(lo.std_error),
                              "upper"_a = finite_or_none(up.upper), "upper_std_error"_a = finite_or_none(up.std_error),
                              "gap"_a = finite_or_none(up.upper - lo.price),
                              "policy_price"_a = finite_or_none(lo.policy_price),
                              "european"_a = finite_or_none(lo.european), "european_se"_a = finite_or_none(lo.european_se),
                              "policy_paths"_a = lo.policy_paths, "value_paths"_a = lo.value_paths,
                              "outer_paths"_a = up.outer_paths, "inner_paths"_a = up.inner_paths,
                              "inner_sims"_a = up.inner_sims, "dates"_a = lo.dates, "steps"_a = lo.steps,
                              "exercise_dates"_a = lo.exercise_dates);
          },
          py::arg("call"), py::arg("K"), py::arg("T"), py::arg("market"), py::arg("policy_paths") = 40000LL,
          py::arg("value_paths") = 200000LL, py::arg("outer_paths") = 500LL, py::arg("inner_paths") = 400LL,
          py::arg("seed") = 42ULL, py::arg("dates") = 22, py::arg("steps_per_year") = 365.0,
          "Longstaff-Schwartz price and the Andersen-Broadie dual upper bound for that same fitted policy, so the "
          "value is bracketed rather than bounded on one side. Both price the Bermudan with `dates` equally spaced "
          "exercise dates, worth less than the continuously exercisable American pde_price returns. The upper bound "
          "is high biased by its inner simulations and that bias falls as 1/sqrt(inner_paths); cost is about "
          "outer_paths x dates x inner_paths, so it is far heavier than the lower bound.");

    m.def("mc_portfolio_mt",
          [](DoubleArray is_call, DoubleArray K, DoubleArray T, DoubleArray sigma, DoubleArray weight,
             double S, double r, double q, long long paths, uint64_t seed, bool antithetic, int n_threads) {
              const std::vector<PortfolioLeg> legs = portfolio_legs(is_call, K, T, sigma, weight);
              MCResult res;
              {
                  py::gil_scoped_release release;
                  res = mc_portfolio_mt(legs.data(), legs.size(), S, r, q, paths, seed, antithetic, n_threads);
              }
              return py::dict("price"_a = res.price, "std_error"_a = res.std_error, "paths"_a = res.paths);
          },
          py::arg("is_call"), py::arg("K"), py::arg("T"), py::arg("sigma"), py::arg("weight"),
          py::arg("S"), py::arg("r"), py::arg("q") = 0.0, py::arg("paths") = 1000000LL,
          py::arg("seed") = 42ULL, py::arg("antithetic") = false, py::arg("n_threads") = -1,
          "mc_portfolio split across std::threads (seed + t x golden ratio per thread); "
          "equals mc_portfolio exactly with n_threads=1.");

#ifdef __APPLE__
    // ── Phase 6: Apple Metal GPU MC ──────────────────────────────────────────
    m.def("mc_price_gpu",
          [](int type_int, double S, double K, double r, double sigma, double T,
             long long paths, uint64_t seed, double q) {
              MCResult res;
              {
                  py::gil_scoped_release release;  // GIL released: Metal waits internally
                  res = mc_price_gpu(static_cast<OptionType>(type_int),
                                     S, K, r, sigma, T, paths, seed, q);
              }
              return py::dict(
                  "price"_a     = res.price,
                  "std_error"_a = res.std_error,
                  "paths"_a     = res.paths
              );
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          py::arg("paths"), py::arg("seed") = 42ULL, py::arg("q") = 0.0,
          "Apple Metal GPU GBM MC. "
          "RNG: Philox 4x32-10 (counter-based, one independent stream per path). "
          "Reduction: GPU threadgroup + host double-precision. "
          "Timing: full round-trip (param upload + dispatch + readback).");

    m.def("mc_gpu_device_name",
          []() { return mc_gpu_device_name(); },
          "Returns the MTLDevice name, e.g. 'Apple M4 Pro'.");
#endif
}
