# QuantCore: product requirements

**Status: shipped and finished (November 2026).** This records what QuantCore is required to do and how each
requirement is checked, so a future change can be judged against it. Design reasoning is in the
[walkthrough](WALKTHROUGH.md); models and numbers are in the [technical reference](TECHNICAL.md).

## Problem

Options tools usually show one price from one model. That hides what matters: early exercise, a skewed volatility
surface, path dependence, and how much a crash would cost. Tools that check those things are spreadsheets, or heavy
licensed software that needs a server.

## Users

1. **Recruiters and interviewers** (primary). They open the link, need to understand it in 10 seconds, and judge the
   engineering from the README and the code.
2. **Students and engineers learning options.** They want to see models disagree and why.
3. **The owner**, preparing for interviews from the walkthrough.

Not for: trading, execution, or regulatory risk.

## Goals

- G1. Price one position several independent ways and show where they disagree, with error bars.
- G2. Run with nothing to install: the hosted site computes in the browser with no server.
- G3. A native engine that is measurably fast: GPU Monte Carlo and low-latency streaming.
- G4. Every number trustworthy: each model checked by a second method, and the checks automated.
- G5. Fast to use: everything reachable from the keyboard.

## Requirements

| # | Requirement | Checked by |
|---|---|---|
| R1 | Build a position: 9 presets or up to 8 custom legs; spot, volatility, rate, dividend; an arbitrage-free SSVI surface with skew and term structure. | `tests/terminal.spec.ts`, `tests/volSurface.spec.ts` |
| R2 | Price, Δ, Γ, Θ, ν tiles; exact max profit, max loss and break-evens; payoff chart; spot × vol P&L surface. | `tests/quant.spec.ts`, `tests/properties.spec.ts` |
| R3 | Pricing Lab: Black-Scholes, a CRR lattice and Monte Carlo side by side with standard errors and the American premium; PDE and Longstaff–Schwartz under the surface. | `tests/terminal.spec.ts`, `tests/wasm.spec.ts`, C++ gate |
| R4 | Simulate: risk-neutral paths and the terminal distribution against its analytic density. | `tests/impliedDensity.spec.ts`, `tests/localVol.spec.ts` |
| R5 | Exotics: barrier (continuous or scheduled, with rebates) and Asian options, each checked by a second method. | `tests/exotics.spec.ts`, C++ gate |
| R6 | Stress: named and custom shocks with P&L by leg. Risk: delta-normal, delta-gamma and Monte Carlo VaR with expected shortfall. | `tests/quant.spec.ts`, `tests/properties.spec.ts` |
| R7 | Import a portfolio from CSV, XLSX or XLS in the browser, with a row-by-row preview and clear errors. | `tests/quant.spec.ts`, robustness walks |
| R8 | The hosted site needs no server: the C++ core runs as WebAssembly and agrees with the native build to 1e-12. | `tests/wasm.spec.ts`, `wasm.yml` (byte-identical rebuild) |
| R9 | The native engine streams over a WebSocket at p99 under 5 ms (localhost) and runs Monte Carlo on Apple Metal. | `server/latency_harness.py`, `python/phase6_gate.py`, `server/protocol_check.py` |
| R10 | The terminal keeps working when the engine is missing, slow or crashes mid-session. | `tests/robustness.spec.ts` |
| R11 | Keyboard: 1–7, `[` `]`, ⌘K or `/`, `?`, and single letters for market, surface, import, reset (with undo), new draw, presets and the intro. Never while typing or with a dialog open; a switch turns single keys off. | `tests/shortcuts.spec.ts`, `tests/hotkeys.spec.ts` |
| R12 | First visit: an intro band says what it is and offers four one-click examples; dismissing it sticks. | `tests/hotkeys.spec.ts` |
| R13 | Works on a phone (375 px) with no overlapping text or horizontal scroll; passes an axe-core WCAG 2.1 A/AA audit. | `npm run scan:ui`, `tests/a11y.spec.ts`, robustness walks |
| R14 | Every tile says which engine produced its number. | `tests/engine.spec.ts`, `tests/terminal.spec.ts` |

## Quality bar

- CI (`ci.yml`) on every push and pull request: lint, types, unit tests, the static build, the browser suite, and the
  C++ build on Linux with its acceptance gate and protocol check. `wasm.yml` rebuilds the WebAssembly module and
  requires identical bytes.
- No error in the browser console on the live site (checked after every deploy).
- First Load JS for `/` at or under 210 kB.

## Out of scope

Order placement or any broker write access; hosting the native engine publicly; multi-asset VaR; calibrated
historical stress replays; stochastic-volatility models. The last three are listed as next steps in the walkthrough.

## Release and operations

- Live at <https://quantcore-gk.netlify.app>. The Netlify site is linked to GitHub: every push to `main` builds
  `dashboard/` with the settings in `netlify.toml` and deploys it. The `Production` workflow then records the deployment
  on GitHub, and marks it successful only once the live site's `/version.txt` names the pushed commit.
- The README images and demo regenerate with `npm run screenshots` and `npm run demo`.
