# QuantCore: walkthrough

How QuantCore works, why it is built the way it is, where the numbers come from, and the questions it tends to
raise. The [README](../README.md) is the short version and the [technical reference](TECHNICAL.md) is the full one;
this is the version to read before talking about the project.

[In 30 seconds](#in-30-seconds) · [In 2 minutes](#in-2-minutes) · [How a number gets to the screen](#how-a-number-gets-to-the-screen) · [Decisions and trade-offs](#decisions-and-trade-offs) · [The numbers and how they were measured](#the-numbers-and-how-they-were-measured) · [Hard problems](#hard-problems-and-what-fixed-them) · [Questions](#questions-it-raises) · [Limits and next steps](#limits-and-what-would-come-next)

## In 30 seconds

QuantCore is an options pricing and risk terminal. You build a position (an iron condor on SPY, say) and it prices
it several independent ways (closed form, a lattice, Monte Carlo, a PDE solver), simulates it, stresses it and
measures its Value at Risk, and shows where the methods disagree. The pricing core is C++17. It runs natively on a
Mac, including a Monte Carlo kernel on the Apple GPU that is 69x faster than vectorized NumPy at 10 million paths,
and the same C++ is compiled to an 88 KB WebAssembly module, so the public site runs it in the browser with no
server.

## In 2 minutes

- **The problem.** Most options tools give one number from one model. A Black-Scholes price says nothing about early
  exercise, a skewed volatility surface, a barrier, or what a crash costs. The interesting information is in where
  models disagree.
- **What it does.** Seven workspaces share one position: Build (legs, volatility surface, Greeks, payoff), Price
  (three models side by side with error bars), Simulate (risk-neutral paths against the analytic density),
  Exotics (barrier and Asian options, each checked by a second method), Stress (scenario shocks), Risk (four VaR
  methods) and Engine (which engine produced each number, and how fast).
- **How it's built.** A C++17 core with three front doors. pybind11 exposes it to a FastAPI WebSocket server, which
  streams prices to the terminal at a p99 of 4.6 ms with five clients. Emscripten compiles it to WebAssembly for the
  hosted site. Apple Metal runs its Monte Carlo on the GPU. The terminal is Next.js, exported as static files.
- **How it's checked.** Every model has a second, independent method that must agree with it: closed forms against
  a PDE solver, the PDE against Monte Carlo, the TypeScript models against the C++ to 1e-12, the WebAssembly build
  against the native build. A C++ acceptance gate, 176 unit tests, 49 browser tests and CI on every push enforce it.

## How a number gets to the screen

Take the Delta tile on the Build workspace.

1. **The position** lives in one reducer (`dashboard/components/terminal/useTerminalState.ts`): legs, the market
   (spot, volatility, rate, dividend yield) and the volatility surface.
2. **Each leg gets its own volatility** from the SSVI surface at its strike and expiry
   (`dashboard/lib/quant/`), so a skewed smile prices a put spread differently from a flat one.
3. **The engine is chosen.** If the native engine answers on `ws://localhost:8765`, the legs go over the WebSocket
   as one `portfolio` message. The server (`server/ws_server.py`) calls the pybind11 module, which releases the
   Python GIL and runs `batch_bs_full` in C++ (Accelerate vForce SIMD on a Mac). Otherwise the browser calls the
   same C++ compiled to WebAssembly, in the page.
4. **The tile says which engine** produced it (*C++ · WebAssembly* or the native engine), and the Engine workspace
   measures their agreement live.

Heavier work (the Pricing Lab's Monte Carlo, the PDE solves, Monte Carlo VaR) runs in a Web Worker
(`dashboard/workers/compute.worker.ts`) so the page never freezes, and the workspace sets `data-ready` once its
results have landed.

## Decisions and trade-offs

| Decision | Why | What it cost |
|---|---|---|
| **C++ for the core** | Control over memory and SIMD, one codebase for native, GPU and WebAssembly, and it's what pricing libraries are written in. | Slower to change than Python; needed bindings (pybind11) and a WebAssembly build. |
| **Compile the core to WebAssembly** | The public demo needs no server, so it is free to host and never sleeps, and the browser runs the *same* code as the native engine rather than a rewrite. | Single-threaded, no GPU. 88 KB to download. A second build to keep in sync, solved by the reproducible manifest below. |
| **TypeScript copies of the models too** | Charts, stress and VaR call the models thousands of times per interaction; staying in JavaScript avoids crossing into WebAssembly each time. | Two implementations of the same math. The unit tests pin them to 1e-12 of the C++ on price and every Greek, so they cannot drift. |
| **WebSocket, not REST** | Streaming: one connection, the server pushes each update, and a ping message measures round-trip latency. | Connection state and reconnects; the terminal falls back to WebAssembly when the engine drops (tested by killing it mid-session). |
| **Release the GIL around C++ compute** | A 10M-path Monte Carlo would otherwise block every other client on the event loop. | The C++ must not touch Python objects while it runs. |
| **Philox 4x32-10 on the GPU** | A counter-based generator: thread *i* draws from counter *i* with no shared state, so streams are independent by construction. Splitting a sequential generator like `mt19937` across thousands of threads gives no such guarantee. | More arithmetic per random number than a simple LCG, which the GPU hides easily. |
| **float32 on the GPU, float64 to reduce** | Apple GPUs are much faster in float32. Summing 10M float32 payoffs in one accumulator loses precision, so each threadgroup sums its own paths and the host adds the group sums in float64. | Per-path values carry float32 error (about 1e-7 relative), far below Monte Carlo's own sampling error. |
| **SSVI for the volatility surface** | A parametric smile with known conditions for no butterfly and no calendar arbitrage (Gatheral & Jacquier), so the surface is arbitrage-free by construction, and it gives Dupire local volatility in closed form. | One shape shared across expiries fits each expiry a little worse (SPY: 1.02 vol points RMSE against 0.67–1.23 per expiry fitted alone). |
| **Static Next.js export** | Any static host serves it, with no server runtime to secure or pay for. | No server-side anything; live market data needs a separate proxy, which is optional. |
| **A reproducible WebAssembly build** | A manifest pins the Emscripten version, flags and the SHA-256 of the module and every source. Tests fail if a source changes without a rebuild, and CI rebuilds it and requires identical bytes. | Builds must be byte-for-byte deterministic, which constrains flags. |

## The numbers and how they were measured

All on an Apple M3 MacBook Air.

- **69x Monte Carlo on Metal** (`python/phase6_gate.py`). 10M paths of a European option, median of repeated runs,
  against `mc_price_numpy`, a fully vectorized NumPy implementation with the PCG64 generator: not a Python loop, so
  the comparison is against a competent baseline. The GPU time includes the full round trip (parameter write,
  encoding, dispatch, readback and reduction). At 1M paths it is 23.5x. At 100k paths the GPU's fixed dispatch
  cost dominates and the CPU path is the better choice, which is why the speedup grows with path count.
- **4.6 ms p99 WebSocket latency** (`server/latency_harness.py`). Five concurrent clients each sending 100 updates a
  second over localhost; 3.1 ms with one client. Localhost only, so it measures the server and the C++ path, not a
  network.
- **4.5% VaR breach rate** (`python/phase3_gate.py`). A historical-simulation 95% VaR on a portfolio of 60% SPY, 30%
  AAPL and 10% TLT, using a rolling 252-day window and walked forward over 851 test days of real prices. A correct
  95% VaR should be breached about 5% of the time. 4.5% is about 38 breaches against 42.5 expected, and a Kupiec
  test of that count gives a likelihood ratio of about 0.5, well under the 3.84 that would reject it at 5%. (The
  Kupiec figure was computed for this walkthrough from the reported rate. The terminal's own VaR is a separate,
  single-underlying model.)
- **88 KB** is the WebAssembly module: Black-Scholes, Monte Carlo, portfolio Monte Carlo, local volatility, exotics,
  the PDE solver and Longstaff–Schwartz, with no imports and no JavaScript glue.
- **1e-12** is the agreement required between the TypeScript models and the C++, and between the WebAssembly and the
  native builds (960 contracts, most bit-identical).

## Hard problems and what fixed them

Each of these was found by a measurement or a test, not by reading the code.

- **The PDE's Greeks wouldn't converge.** On uniform time steps, a one-year put's Gamma under the equity smile was
  still moving 10% between 800 and 3,200 steps, because SSVI's power-law smile makes local variance blow up as time
  goes to zero. Grading the time grid towards today (t = T·u²) settled it by 800 steps.
- **Crank–Nicolson oscillated** in the steep high-volatility wings. BDF2 is L-stable and damps them, so the solver
  starts with two implicit Euler steps and then runs variable-step BDF2.
- **The American put's price depended on the grid's width.** Brennan–Schwartz assumes the exercise region is one
  interval touching the grid's edge, which the smile breaks: 53.28 at the default width, 51.06 at twice it. Solving
  the early-exercise constraint exactly by policy iteration gives 51.06 at every width, in at most three iterations
  a step.
- **A monitored barrier underpriced by 0.02 and lost an order of convergence.** The barrier's own grid cell
  straddles the barrier, and knocking out the whole cell threw away half a cell of live value. Averaging over the
  cell, as the payoff already was at the strike, restored second-order convergence.
- **Local-volatility Monte Carlo was biased** (7.7% of a far out-of-the-money call at weekly steps). Each path also
  runs on a half-step grid with the same Brownian increments, and 2·fine − coarse cancels the first-order error at
  an unchanged standard error (Richardson extrapolation): the condor's mean error went from −$58.6 to −$13.7.
- **The engine wouldn't build on Linux.** CI's first Linux build failed to link: the core is a static library linked
  into the shared pybind11 module, which on Linux requires position-independent code (macOS does it by default).
  One CMake property fixed it, and it would also have broken the Docker image.
- **The live site re-rendered itself on load, and only the live site.** Netlify injects an HTML comment into every
  served page's `<head>`, and React then failed to hydrate the explicit `<head>` the layout declared (error #418)
  and re-rendered the page in the browser. It was reproduced locally by injecting the same comment, and fixed by
  moving the one inline script to the start of `<body>`. Since then every deploy is checked on the live URL with a
  page-error listener.

## Questions it raises

**Finance**

- *What are the Greeks?* Sensitivities of the option's value: delta to spot, gamma to delta's change, theta to time,
  vega to volatility. Here they are analytic for Black-Scholes, checked against finite differences, and from the
  grid for the PDE.
- *Why price the same thing three ways?* Each method fails differently. The closed form assumes flat volatility and
  European exercise; the lattice handles early exercise; Monte Carlo handles any payoff but has sampling error; the
  PDE handles early exercise under a full surface. Where two disagree beyond their error bars, one assumption is
  doing the work.
- *Why does an American put carry an early-exercise premium but a call without dividends doesn't?* Deep in the money,
  exercising a put now earns interest on the strike sooner, which can beat the remaining time value. A call without
  dividends is always worth more alive than exercised. Both are tested.
- *Is Longstaff–Schwartz biased?* Low. Its exercise rule is fitted by regression and then valued on fresh paths, and
  any sub-optimal rule is still a valid strategy, so its value is a lower bound. The Andersen–Broadie dual gives an
  upper bound, and the two bracket the true Bermudan price (0.52% wide with 11 exercise dates).
- *What is local volatility?* The one volatility as a function of spot and time that reproduces every vanilla price
  on the surface (Dupire). It's what the Monte Carlo and the PDE use under a smile.
- *Why do the VaR methods disagree?* Options are non-linear. Delta-normal VaR treats the position as linear in spot
  and misses gamma. Delta-gamma adds curvature. Monte Carlo full revaluation reprices every leg in every scenario.
  On the README's short-gamma SPY iron condor, delta-normal says $382 and full revaluation $624.
- *What does a discretely monitored barrier change?* A barrier checked only at daily or weekly closes is harder to
  breach, so a knock-out is worth more. The Broadie–Glasserman–Kou correction prices it with the continuous formula and
  the barrier moved away from spot by a factor exp(0.5826·σ·√Δt).
- *What makes a volatility surface arbitrage-free?* No butterfly arbitrage (the implied density is non-negative,
  Durrleman's condition) and no calendar arbitrage (total variance never falls with maturity). SSVI's parameter
  bounds guarantee both, and the tests check them numerically.

**Engineering**

- *Why is the GPU slower at small path counts?* Launching a kernel has a fixed cost (encoding, dispatch, readback).
  At 100k paths that dominates; by 10M the parallel work does.
- *How do you know the browser and native numbers match?* The WebAssembly and native builds compile the same
  sources, and a test prices 960 contracts on both and requires 1e-12 agreement. Same-seed Monte Carlo reproduces
  across the two.
- *How is the UI tested?* Unit tests for the math, seeded property-based tests over thousands of random markets,
  random walks through the whole UI on desktop and phone that fail on any console error or NaN on screen, an axe-core
  accessibility audit, and tests that kill the engine mid-session.
- *What runs in CI?* Lint, types, unit tests, the static build and the browser suite; the C++ build on Linux with its
  acceptance gate and the WebSocket protocol check; and a reproducible rebuild of the WebAssembly module that must
  match byte for byte.
- *Why a static site and not a server?* Nothing to secure, scale or pay for, and the WebAssembly core means no
  compute is lost. The native engine stays a local service for the GPU and multithreaded work.

## Limits and what would come next

- Greeks tiles, stress and VaR treat options as European; early exercise is priced in the Pricing Lab only.
- VaR is a single-underlying research model with fixed rates, not a regulatory or trading risk measure.
- Stress scenarios are illustrative shocks, not historical replays.
- The GPU kernel prices one contract per run; portfolios and exotics run on the CPU or in WebAssembly.
- Next steps, if it continued: a multi-asset VaR with a correlation matrix, calibrated historical stress replays,
  stochastic volatility (Heston) as a second surface model to compare against local volatility, and portfolios on the
  GPU.
