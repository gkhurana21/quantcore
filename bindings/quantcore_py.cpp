#include <pybind11/pybind11.h>
#include <pybind11/numpy.h>
#include <pybind11/stl.h>

#include "quantcore/black_scholes.hpp"
#include "quantcore/monte_carlo.hpp"
#include "quantcore/black_scholes_batch.hpp"
#include "quantcore/monte_carlo_mt.hpp"

namespace py = pybind11;
using namespace pybind11::literals;
using namespace quantcore;

// ── batch helpers ─────────────────────────────────────────────────────────────
//
// The Python→C++ boundary is crossed once per batch, not once per option.
// C++ loops over the arrays; no GIL re-acquisition per element.

static py::array_t<double>
batch_bs_price_impl(bool is_call,
                    py::array_t<double, py::array::c_style | py::array::forcecast> S,
                    py::array_t<double, py::array::c_style | py::array::forcecast> K,
                    py::array_t<double, py::array::c_style | py::array::forcecast> r,
                    py::array_t<double, py::array::c_style | py::array::forcecast> sigma,
                    py::array_t<double, py::array::c_style | py::array::forcecast> T) {
    auto n = S.size();
    auto out = py::array_t<double>(n);
    auto s_ = S.unchecked<1>(), k_ = K.unchecked<1>(),
         r_ = r.unchecked<1>(), sg_ = sigma.unchecked<1>(), t_ = T.unchecked<1>();
    auto o_ = out.mutable_unchecked<1>();
    OptionType type = is_call ? OptionType::Call : OptionType::Put;
    for (py::ssize_t i = 0; i < n; ++i)
        o_(i) = bsm_price(type, s_(i), k_(i), r_(i), sg_(i), t_(i));
    return out;
}

// Returns shape (N, 5): columns = [price, delta, gamma, theta, vega]
static py::array_t<double>
batch_bs_full_impl(bool is_call,
                   py::array_t<double, py::array::c_style | py::array::forcecast> S,
                   py::array_t<double, py::array::c_style | py::array::forcecast> K,
                   py::array_t<double, py::array::c_style | py::array::forcecast> r,
                   py::array_t<double, py::array::c_style | py::array::forcecast> sigma,
                   py::array_t<double, py::array::c_style | py::array::forcecast> T) {
    auto n = S.size();
    auto out = py::array_t<double>({(py::ssize_t)n, (py::ssize_t)5});
    auto s_ = S.unchecked<1>(), k_ = K.unchecked<1>(),
         r_ = r.unchecked<1>(), sg_ = sigma.unchecked<1>(), t_ = T.unchecked<1>();
    auto o_ = out.mutable_unchecked<2>();
    OptionType type = is_call ? OptionType::Call : OptionType::Put;
    for (py::ssize_t i = 0; i < n; ++i) {
        BSMResult res = bsm_full(type, s_(i), k_(i), r_(i), sg_(i), t_(i));
        o_(i, 0) = res.price;
        o_(i, 1) = res.greeks.delta;
        o_(i, 2) = res.greeks.gamma;
        o_(i, 3) = res.greeks.theta;
        o_(i, 4) = res.greeks.vega;
    }
    return out;
}

// ── module definition ─────────────────────────────────────────────────────────

PYBIND11_MODULE(quantcore, m) {
    m.doc() = "QuantCore: C++ options pricing engine (Phase 2 bindings)";

    py::enum_<OptionType>(m, "OptionType")
        .value("Call", OptionType::Call)
        .value("Put",  OptionType::Put)
        .export_values();

    // ── scalar API ────────────────────────────────────────────────────────────
    m.def("bs_price",
          [](int type_int, double S, double K, double r, double sigma, double T) {
              return bsm_price(static_cast<OptionType>(type_int), S, K, r, sigma, T);
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          "Black-Scholes price for a European option.");

    m.def("bs_full",
          [](int type_int, double S, double K, double r, double sigma, double T) {
              // GIL released for the C++ computation; re-acquired before
              // constructing the Python dict.  Allows concurrent WebSocket
              // handlers to overlap their pricing calls without serialising
              // on Python's GIL.
              BSMResult res;
              {
                  py::gil_scoped_release release;
                  res = bsm_full(static_cast<OptionType>(type_int), S, K, r, sigma, T);
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
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          "Black-Scholes price + analytic Greeks. GIL released during C++ compute.");

    m.def("mc_price",
          [](int type_int, double S, double K, double r, double sigma, double T,
             long long paths, uint64_t seed) {
              MCResult res;
              {
                  py::gil_scoped_release release;   // GIL released during MC sim
                  res = mc_price(static_cast<OptionType>(type_int),
                                 S, K, r, sigma, T, paths, seed);
              }
              return py::dict(
                  "price"_a     = res.price,
                  "std_error"_a = res.std_error,
                  "paths"_a     = res.paths
              );
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          py::arg("paths"), py::arg("seed") = 42ULL,
          "GBM Monte Carlo price for a European option. GIL released during sim.");

    // ── batch API (one Python→C++ crossing per batch) ─────────────────────────
    // Batch functions: GIL released for full duration via call_guard — the
    // lambda bodies operate on raw numpy memory and do not touch Python objects.
    m.def("batch_bs_price", &batch_bs_price_impl,
          py::arg("is_call"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          "Batch BS price. Returns 1-D array of length N.",
          py::call_guard<py::gil_scoped_release>());

    m.def("batch_bs_full", &batch_bs_full_impl,
          py::arg("is_call"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          "Batch BS price+Greeks. Returns shape (N,5): [price,delta,gamma,theta,vega].",
          py::call_guard<py::gil_scoped_release>());

    // ── Phase 2b: Accelerate-SIMD batch BS ───────────────────────────────────
    m.def("batch_bs_full_accel",
          [](bool is_call,
             py::array_t<double, py::array::c_style | py::array::forcecast> S,
             py::array_t<double, py::array::c_style | py::array::forcecast> K,
             py::array_t<double, py::array::c_style | py::array::forcecast> r,
             py::array_t<double, py::array::c_style | py::array::forcecast> sigma,
             py::array_t<double, py::array::c_style | py::array::forcecast> T) {
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
             long long paths, uint64_t seed, int n_threads) {
              MCResult res = mc_price_mt(static_cast<OptionType>(type_int),
                                         S, K, r, sigma, T, paths, seed, n_threads);
              return py::dict(
                  "price"_a     = res.price,
                  "std_error"_a = res.std_error,
                  "paths"_a     = res.paths
              );
          },
          py::arg("type"), py::arg("S"), py::arg("K"),
          py::arg("r"), py::arg("sigma"), py::arg("T"),
          py::arg("paths"), py::arg("seed") = 42ULL, py::arg("n_threads") = -1,
          "Multithreaded GBM MC (vvexp SIMD + std::thread). "
          "n_threads=-1 uses hardware_concurrency.");
}
