# QuantCore

A real-time options pricing engine built in five phases. Every number in the
resume bullets is backed by a gate run documented in
[`~/Notes/QuantCore.md`](../Notes/QuantCore.md).

## Architecture

```
core/          C++17 pricing library — Black-Scholes, Monte Carlo, Greeks
bindings/      pybind11 Python bindings (GIL released around C++ calls)
python/        Benchmarks, market-data validation, VaR backtest
server/        FastAPI + uvicorn WebSocket server
dashboard/     Next.js 14 live dashboard + Playwright tests
tests/         Phase 1 C++ acceptance gate (BS prices, Greeks, MC convergence)
```

## Phase summary

| Phase | What it built | Gate |
|---|---|---|
| 1 | C++ BS + MC + analytic Greeks | BS prices vs Hull 9e; Greeks analytic-vs-FD; MC convergence |
| 2 | pybind11 bindings | Round-trip correctness; benchmark vs NumPy |
| 2b | SIMD (Apple Accelerate vForce) + 8-thread MC | 3.8× BS, 4.1× MC vs vectorised NumPy |
| 3 | VaR + stress; market data validation | Per-strike IV round-trip <0.01%; VaR breach rate 4.5% vs 5% nominal |
| 4 | WebSocket streaming layer | p99 latency 4.4 ms (localhost, 5 concurrent clients) |
| 5 | Next.js dashboard + Playwright | 3/3 end-to-end tests; displayed prices match engine to $0.01 |

## Build

```bash
# C++ core + Python bindings
cmake -B build -DCMAKE_BUILD_TYPE=Release \
      -DPython3_EXECUTABLE=$(which python3)
cmake --build build --parallel

# Phase 1 acceptance gate
./build/tests/phase1_validation

# Dashboard
cd dashboard && npm install && npm run dev

# Playwright tests (starts WS server + Next.js automatically)
cd dashboard && npx playwright test
```

## Requirements

- Apple Silicon Mac (ARM NEON / Accelerate used for SIMD)
- CMake ≥ 3.21, AppleClang / Clang with C++17
- Python 3.9+ with `pip install pybind11 numpy scipy yfinance fastapi uvicorn websockets`
- Node.js ≥ 18.17 (for Next.js 14)
