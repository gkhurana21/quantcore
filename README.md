# QuantCore

### ▶ [**Live Demo**](https://quantcore-gk.netlify.app) &nbsp;·&nbsp; [Portfolio](https://gaurangkhurana.ca)

Real-time options pricing and risk engine: a C++17 Black-Scholes / Monte Carlo core with analytic Greeks, exposed to Python via pybind11, GPU-accelerated on Apple Metal, and streamed over WebSocket to a live Next.js dashboard.

> **[▶ Try the live demo](https://quantcore-gk.netlify.app)** — pick an underlying (SPY/AAPL/NVDA/TSLA/QQQ), build multi-leg strategies (straddles, spreads, iron condors) or upload a CSV portfolio, and watch the P&L diagram, Greeks, and risk surface re-price live. Black-Scholes runs in-browser; the native GPU/Monte-Carlo engine runs locally.

## Architecture

```
                    ┌──────────────────────────────┐
                    │   Next.js dashboard           │
                    │   (live prices, Greeks, P&L)  │
                    └───────────────┬──────────────┘
                                    │ WebSocket (p99 < 5 ms, localhost)
                    ┌───────────────┴──────────────┐
                    │   FastAPI + uvicorn server    │
                    │   (server/ws_server.py)       │
                    └───────────────┬──────────────┘
                                    │ pybind11 (GIL released around C++ calls)
        ┌───────────────────────────┴───────────────────────────┐
        │                 C++17 pricing core (core/)             │
        │   Black-Scholes · analytic Greeks · Monte Carlo (GBM)  │
        ├────────────────────────────┬───────────────────────────┤
        │  CPU: SIMD (Accelerate     │  GPU: Apple Metal          │
        │  vForce) + 8-thread MC     │  Philox 4x32-10 PRNG,      │
        │  3.8–4.1x vs NumPy         │  up to 69x vs NumPy        │
        └────────────────────────────┴───────────────────────────┘
```

The Python layer (`python/`) holds the benchmark harnesses, market-data validation, and the VaR backtest.

## Benchmarks

All numbers measured on an Apple M3 MacBook Air. The baseline is **vectorized NumPy** (PCG64 generator, fully vectorized batch pricing) — not a Python for-loop, so the speedups are against a competent baseline. GPU timings include the full round trip: host parameter write, Metal command encoding, GPU dispatch, and host readback/reduction — transfer overhead is not excluded.

| Workload | Paths | Speedup vs vectorized NumPy |
|---|---:|---:|
| Monte Carlo, Apple Metal GPU | 10,000,000 | 69x |
| Monte Carlo, Apple Metal GPU | 1,000,000 | 23.5x |
| Monte Carlo, CPU (8 threads + SIMD) | — | 4.1x |
| Black-Scholes batch, CPU (Accelerate vForce SIMD) | — | 3.8x |

The GPU advantage grows with path count; at small workloads (100k paths) fixed dispatch cost dominates and the CPU path is the right choice. The GPU kernel uses the Philox 4x32-10 counter-based PRNG so that every GPU thread gets a statistically independent stream — a guarantee sequential PRNGs like `mt19937` do not provide when split across threads. The kernel computes in float32; the host reduces partial sums in float64 to avoid accumulation error.

**Streaming latency:** p99 under 5 ms (measured 4.4 ms) end-to-end through the FastAPI WebSocket layer — localhost loopback, 5 concurrent clients, measured by `server/latency_harness.py`.

**VaR backtest:** historical 95% VaR backtested on 851 trading days of real multi-asset market data. Observed breach rate: **4.5%** against the 5% expected for a correctly calibrated 95% VaR. A breach rate near — not far below — the nominal 5% is the goal: materially higher would mean the model understates risk, materially lower would mean it overstates risk and ties up capital. 4.5% over 851 days is within sampling error of the target.

Reproduce:

```bash
python python/benchmark_v2.py     # CPU SIMD + multithreaded MC vs NumPy
python python/phase6_gate.py      # GPU MC at 100k / 1M / 10M paths
python python/phase3_gate.py      # VaR backtest + market-data validation
python server/latency_harness.py  # WebSocket p50/p95/p99 latency
```

## Quickstart

Requirements: Apple Silicon Mac (Accelerate/NEON for SIMD, Metal for GPU), CMake >= 3.21, a C++17 compiler, Python 3.9+, Node.js >= 18.17.

```bash
# 1. Build the C++ core, tests, and Python bindings
pip install pybind11 numpy scipy yfinance fastapi uvicorn websockets
cmake -B build -DCMAKE_BUILD_TYPE=Release \
      -DPython3_EXECUTABLE=$(which python3)
cmake --build build --parallel

# 2. Run the C++ acceptance gate (BS prices vs Hull, Greeks analytic-vs-FD,
#    MC convergence)
./build/tests/phase1_validation

# 3. Start the WebSocket server
python server/ws_server.py

# 4. Start the dashboard
cd dashboard && npm install && npm run dev

# 5. End-to-end tests (Playwright starts the server + dashboard itself)
cd dashboard && npx playwright test
```

## Project layout

```
core/          C++17 pricing library — Black-Scholes, Monte Carlo, Greeks;
               Metal GPU kernel in core/src/monte_carlo_gpu.mm
bindings/      pybind11 bindings (GIL released around C++ compute)
python/        Benchmarks, market-data validation, VaR backtest
server/        FastAPI + uvicorn WebSocket server, latency harness
dashboard/     Next.js dashboard + Playwright end-to-end tests
tests/         C++ acceptance gate (BS prices, Greeks, MC convergence)
```

## License

MIT — see [LICENSE](LICENSE).
