# QuantCore

### ▶ [**Live terminal**](https://quantcore-gk.netlify.app) &nbsp;·&nbsp; [Portfolio](https://gaurangkhurana.ca)

An options pricing and risk research terminal on top of a C++17 pricing engine. Build a strategy, price it three
ways, simulate it, stress it and measure its risk — in the browser, or against the native C++ / Apple Metal engine
over WebSocket when it runs locally.

**Build → Price → Simulate → Stress → Risk**

| | What it does |
|---|---|
| **Strategy Builder** | SPY, QQQ, AAPL, NVDA, TSLA. Spot, volatility, rate and dividend-yield inputs. Nine presets (long/short call and put, straddle, strangle, bull call spread, bear put spread, iron condor) or up to eight custom legs with call/put, buy/sell, strike, quantity, expiry and entry premium. |
| **Greeks & payoff** | Price, Δ, Γ, Θ, ν and P&L tiles; exact max profit / max loss and break-evens; an interactive payoff chart with P&L · Δ · Γ · Vega · Θ modes (hover or keyboard crosshair); a full-revaluation spot × vol P&L surface. |
| **Pricing Models Lab** | The same portfolio priced with Black-Scholes-Merton, a 512-step Cox-Ross-Rubinstein lattice and seeded Monte Carlo at 10k / 50k / 200k paths — difference vs Black-Scholes, standard error, 95% interval, \|z\| and timing, with a convergence chart, the lattice's odd/even error curve and a per-leg breakdown. |
| **Monte Carlo** | Animated risk-neutral GBM paths with spot, strike, expiry and in-the-money markers; a 50,000-sample terminal distribution against its analytic lognormal density; simulated P(ITM) vs N(d₂). |
| **Stress Lab** | 2008-style credit crisis, COVID-style crash, volatility spike, rate shock, melt-up / vol crush, or a custom shock. Shows Spot → Vol → Greeks → P&L → VaR, P&L by leg, a P&L-vs-spot ladder and all scenarios side by side; apply a shock to the whole terminal and reset. |
| **Risk / VaR** | 1-day 95% parametric VaR, plus delta-normal, delta-gamma and Monte Carlo full-revaluation VaR with expected shortfall at 90 / 95 / 99% over 1 / 5 / 10 days, exposures and stated assumptions. |
| **Portfolio Upload** | CSV, XLSX or XLS, parsed entirely in the browser. Tolerant column names (`option_type`, `cp`, `action`, `strike_price`, `dte`, `expiration`, `contracts`, `fill_price`, …), ISO / US / Excel dates, accounting negatives, a row-by-row preview with errors and warnings, and downloadable samples. |
| **C++ Engine** | Live engine status, which engine produced each number and why, measured round-trip latency, engine-vs-browser agreement, and 100k–10M-path Monte Carlo on the native kernel. |

**How the hosted demo computes.** The public site has no server. Every figure there comes from TypeScript
implementations of the same models (heavy simulations run in a Web Worker), and the engine badge reads *Offline*.
Run the engine locally and the badge turns *Connected*: the Greeks tiles are then priced by the C++ core — the
default SPY contract as a stream, any other portfolio as one batch call — and the C++ Engine tab can run the native
Monte Carlo kernel. Snapshot prices are indicative, not live quotes.

## Architecture

```
┌───────────────────────── Browser (Next.js 14, static export) ─────────────────────────┐
│  Terminal UI ── lib/quant  BSM · CRR · Monte Carlo       lib/risk  VaR · stress · surface │
│             ── lib/strategy presets · payoff analytics  lib/io    CSV / XLSX import     │
│             ── workers/compute.worker.ts (lab, MC paths, MC VaR — off the main thread)  │
└──────────────────────────────────────────┬─────────────────────────────────────────────┘
                                           │ WebSocket JSON (localhost only)
                        ┌──────────────────┴──────────────────┐
                        │  FastAPI + uvicorn  server/ws_server │
                        └──────────────────┬──────────────────┘
                                           │ pybind11 (GIL released around C++ compute)
        ┌──────────────────────────────────┴───────────────────────────────────┐
        │                     C++17 pricing core (core/)                        │
        │   Black-Scholes · analytic Greeks · batch pricing · Monte Carlo (GBM) │
        ├───────────────────────────────────┬───────────────────────────────────┤
        │  CPU: Accelerate vForce SIMD      │  GPU: Apple Metal, Philox 4x32-10 │
        │  + multithreaded Monte Carlo      │  counter-based PRNG                │
        └───────────────────────────────────┴───────────────────────────────────┘
```

The Python layer (`python/`) holds the benchmark harnesses, market-data validation and the VaR backtest. An optional
Go proxy (`proxy/`, Alpaca) supplies live quotes and option chains when configured.

## Models

- **Black-Scholes-Merton** with continuous dividend yield *q*; analytic Greeks (Θ per year, ν per 1.00 of σ).
  With *q* = 0 these are the formulas in `core/src/black_scholes.cpp`, and the unit tests check the TypeScript
  implementation against the C++ bindings.
- **Cox-Ross-Rubinstein** lattice: u = e^(σ√Δt), p = (e^((r−q)Δt) − d)/(u − d), backward induction.
- **Monte Carlo**: seeded mulberry32 + Box-Muller; one Brownian path observed at every distinct leg expiry so
  mixed maturities stay correlated; standard error from the per-path portfolio value; optional antithetic variates.
- **Payoff analytics**: exact piecewise-linear max P/L and break-evens for single-expiry portfolios; a numerical scan
  of first-expiry P&L (later legs at model value) for mixed expiries.
- **VaR**: delta-normal z·|Δ·S|·σ√(h/252); delta-gamma at dS = ±z·S·σ√h; Monte Carlo full revaluation with the
  horizon's time decay; expected shortfall.
- **Stress**: instantaneous spot, volatility (points or multiplier), rate (floored at 0) and time shocks, every leg
  fully repriced.

## WebSocket protocol

`server/ws_server.py`. Version 1 messages are unchanged; version 2 adds request/response messages matched by `id`.

| Client → server | Server → client | Notes |
|---|---|---|
| `subscribe {option}` | `subscribed {entry_price, price, delta, gamma, theta, vega}` | v1 streaming contract |
| `update {S, sigma, r, t_ns}` | `result {…, pnl, t_ns, calc_us}` | v1 — `t_ns` echoed for latency |
| `ping {t_ns}` | `pong {t_ns}` | v2 |
| `info` | `info {protocol, metal, device, cpu_threads}` | v2 |
| `portfolio {id, S, sigma, r, legs[{call, K, T}]}` | `portfolio_result {id, legs[…], calc_us}` | v2 — calls and puts priced with one `batch_bs_full` each |
| `mc {id, call, S, K, r, sigma, T, paths ≤ 10M, seed}` | `mc_result {id, price, std_error, paths, ms, backend, device}` | v2 — Metal GPU, falling back to multithreaded CPU; runs off the event loop |

Errors on v2 messages return `error {id, msg}` and keep the connection open.

## Benchmarks

All numbers measured on an Apple M3 MacBook Air. The baseline is **vectorized NumPy** (PCG64 generator, fully vectorized batch pricing) — not a Python for-loop, so the speedups are against a competent baseline. GPU timings include the full round trip: host parameter write, Metal command encoding, GPU dispatch, and host readback/reduction — transfer overhead is not excluded.

| Workload | Paths | Speedup vs vectorized NumPy |
|---|---:|---:|
| Monte Carlo, Apple Metal GPU | 10,000,000 | 69x |
| Monte Carlo, Apple Metal GPU | 1,000,000 | 23.5x |
| Monte Carlo, CPU (8 threads + SIMD) | — | 4.1x |
| Black-Scholes batch, CPU (Accelerate vForce SIMD) | — | 3.8x |

The GPU advantage grows with path count; at small workloads (100k paths) fixed dispatch cost dominates and the CPU path is the right choice. The GPU kernel uses the Philox 4x32-10 counter-based PRNG so that every GPU thread gets a statistically independent stream — a guarantee sequential PRNGs like `mt19937` do not provide when split across threads. The kernel computes in float32; the host reduces partial sums in float64 to avoid accumulation error.

**Streaming latency:** p99 under 5 ms end-to-end through the FastAPI WebSocket layer — 4.6 ms with 5 concurrent clients and 3.1 ms with one (localhost loopback, 100 updates/s per client), re-measured with the v2 server by `server/latency_harness.py`; the original v1 measurement was 4.4 ms.

**VaR backtest:** historical 95% VaR backtested on 851 trading days of real multi-asset market data. Observed breach rate: **4.5%** against the 5% expected for a correctly calibrated 95% VaR. A breach rate near — not far below — the nominal 5% is the goal: materially higher would mean the model understates risk, materially lower would mean it overstates risk and ties up capital. 4.5% over 851 days is within sampling error of the target. (This validates the historical-simulation backtest; the terminal's parametric VaR is a separate, single-underlying model.)

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

# 2. Run the C++ acceptance gate (BS prices vs Hull, Greeks analytic-vs-FD, MC convergence)
./build/tests/phase1_validation

# 3. Start the WebSocket engine
python server/ws_server.py 8765

# 4. Start the terminal (http://localhost:3000 — the engine badge turns "Connected")
cd dashboard && npm install && npm run dev
```

The terminal also runs without the engine: everything is then computed in the browser and the badge reads *Offline*.

## Testing

```bash
cd dashboard
npm run lint && npm run typecheck      # ESLint (next/core-web-vitals) + tsc --noEmit
npm run test:unit                      # pricing, risk, payoff and import libraries (no browser)
npx playwright test                    # everything: unit + terminal flows + C++ engine integration
python3 ../server/protocol_check.py    # every WebSocket message type against the bindings
```

- `tests/quant.spec.ts` — Hull reference prices, put-call parity with dividends, Greeks vs finite differences, the
  TypeScript Greeks vs the C++ `bs_full`, CRR convergence, Monte Carlo within 3 SE and seed determinism, antithetic
  variance reduction, VaR scaling, payoff analytics for spreads/condors/unbounded legs, and CSV/XLSX/XLS parsing.
- `tests/terminal.spec.ts` — preset, instrument switch, Pricing Lab, Monte Carlo view, chart modes, CSV upload,
  XLSX and XLS upload, Stress Lab, Risk / VaR.
- `tests/engine.spec.ts` and `tests/dashboard.spec.ts` — the live C++ path: streamed prices matching the bindings,
  source switching (stream → batch → browser when q ≠ 0), engine/browser agreement and native Monte Carlo convergence.

Playwright starts the engine and the dev server itself.

## Build & deploy

```bash
cd dashboard && npm run build          # static export → dashboard/out
```

`netlify.toml` builds `dashboard/` and publishes `out/` for Git-connected Netlify deploys; `dashboard/out` can also
be uploaded directly (Netlify CLI `deploy --dir dashboard/out`, or Netlify Drop). Set `NEXT_PUBLIC_PROXY_URL` at build
time to enable live quotes through a deployed proxy; without it the hosted build makes no market-data requests.

## Project layout

```
core/          C++17 pricing library — Black-Scholes, Monte Carlo, Greeks;
               Metal GPU kernel in core/src/monte_carlo_gpu.mm
bindings/      pybind11 bindings (GIL released around C++ compute)
python/        Benchmarks, market-data validation, VaR backtest
server/        FastAPI WebSocket engine, latency harness, protocol check
proxy/         Optional Go market-data proxy (Alpaca)
dashboard/
  app/           Next.js app shell and design tokens
  components/    Terminal views: builder, analytics, lab, stress, risk, io, engine, layout, ui
  lib/quant/     Normal distribution, Black-Scholes-Merton, CRR lattice, RNG, Monte Carlo
  lib/strategy/  Presets, portfolio valuation, payoff analytics
  lib/risk/      VaR, stress scenarios, P&L surface
  lib/io/        CSV / spreadsheet import, samples
  lib/engine/    WebSocket engine client, benchmark figures
  lib/compute/   Web Worker tasks and the worker hook
  workers/       Worker entry point
  tests/         Playwright unit, flow and engine tests
tests/         C++ acceptance gate (BS prices, Greeks, MC convergence)
```

## Limitations

- European exercise and a flat volatility surface — no skew, smile or term structure; American early exercise is not modelled.
- The C++ core has no dividend yield, so the engine is authoritative only when *q* = 0; the native Monte Carlo kernel prices one contract per run.
- The engine is a local service: the hosted terminal always computes in the browser.
- Instrument prices are indicative snapshots unless the optional data proxy is configured.
- Stress scenarios are illustrative instantaneous shocks, not calibrated historical replays.
- VaR is a single-factor research model (spot only; volatility and rates held fixed) — educational, not a regulatory or trading risk measure.

## License

MIT — see [LICENSE](LICENSE).
