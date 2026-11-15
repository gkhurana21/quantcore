# E2E triage, 2026-11-14

The browser suite (`dashboard/tests`: a11y, dashboard, engine, robustness, smile, terminal) had 42 tests. The UI
was reworked into seven workspaces, a strip and sheets after most of them were written. On a machine with no native
engine, 33 of the 42 failed.

This is each failure, what caused it and what was done. No assertion was loosened to make a test pass. Where a test
was wrong it was moved to where the control now lives; where the app was wrong the app was fixed.

## Where things live now (what the stale tests assumed otherwise)

| Control | Then | Now |
|---|---|---|
| First screen | Price tab | **Build** (`/#lab` or `tab-lab` opens Price) |
| Workspace keys | 1 Build, 2 Price, 3 Simulate, 4 Exotics, 5 Risk, … | 1 Build, 2 Price, 3 Simulate, 4 Exotics, **5 Stress, 6 Risk**, 7 Engine |
| Instrument, ticker box, spot, vol, rate, dividend, Reset | always on screen | **market sheet** (click the strip's ticker, or key `M`); mounted but `hidden` until opened |
| Smile and term-structure controls | always on screen | **Build rail** or the **surface sheet** (key `V`) on other tabs |
| Greeks tiles (`price`, `delta`, …), leg rows, presets, chart modes | on every tab | **Build only** |
| Pricing Lab rows (`lab-row-*`) | on the first screen | **Price** tab only |
| Import (`upload-*`, `sample-load`) | inline panel | **dialog**, opened by `Import file` or key `I` |
| Guided examples (`quick-*`) | button row | **command palette**, group "Try" |

## The 33 failures

Cause codes: **A** a test assumed Build was Price, or the old key numbers. **B** a control moved into a sheet, a dialog
or onto Build and the test still looked for it on the tab it was on. **C** the test needs the native engine, which
this machine does not have. **D** an assertion held for every tab but is only true on Build. **E** the app was wrong.
**F** the test setup was wrong.

| Spec | Test | Cause | Fix |
|---|---|---|---|
| dashboard | 1. loads, WebSocket connects, values sane | C | `needsEngine()`: skips without the engine, and fails in `test:e2e:engine` if it is unreachable |
| dashboard | 2. spot slider updates price and delta | C | same |
| dashboard | 3. vol slider updates price and P&L surface | C | same |
| engine | 10a. calculation source follows the portfolio | C | same |
| engine | 10b. engine portfolio pricing agrees with the browser | C | same |
| engine | 10c. native Monte Carlo converges | C | same |
| smile | native engine prices the smile portfolio (v5) | C, B | engine gate; after switching on the smile the test now goes to Price before reading `lab-row-*` |
| smile | mixed expiries on the ATM term structure | C, B | engine gate; the smile choice is made through the surface sheet on the Engine tab |
| smile | native engine and WebAssembly price every strike (v4) | C | engine gate |
| terminal | 2. Switching to NVDA reprices | B | `inst-NVDA` is in the market sheet: open it, click, close |
| terminal | 3. Pricing Lab compares BS, CRR and Monte Carlo | A | read the Greeks tile on Build, then open Price explicitly |
| terminal | 9. Risk / VaR | A | Risk is key **6** now (5 is Stress) |
| terminal | 10. Any ticker from a manual price | B | ticker box is in the market sheet |
| terminal | 12. Volatility smile | B | the mid-test instrument switch goes through the market sheet |
| terminal | 13. Monte Carlo samples the smile density | B | `smile-Flat` was clicked on Simulate; it uses the surface sheet there |
| terminal | 14. WebAssembly cross-check of the whole portfolio | A, B | open Price before waiting for `lab-row-mc200k`; smile and term changes through the surface sheet |
| terminal | 15. ATM term structure | B | instrument switch through the market sheet |
| terminal | 16. Local volatility | A, B, C | open Price; surface sheet; the Lab's local-vol row now expects `C++ native · 1M` when an engine answers and `C++ WebAssembly · 400k` when not (that is what WebAssembly runs) |
| terminal | 17. Exotics in WebAssembly | B | the smile change on the Exotics tab goes through the surface sheet |
| terminal | 18. Native engine, exotics over protocol v7 | C | engine gate |
| terminal | 19. Finite differences, LSM, barrier PDE | A, B | open Price first; smile through the surface sheet |
| terminal | 20. Vega by strike | A, B | same |
| robustness | desktop walk, seed 101 | B | the walk's first action fills `ticker-input`, which is in the market sheet: market actions now open it |
| robustness | desktop walk, seed 202 | B | same |
| robustness | desktop walk, seed 303 | D | `expectSane` demanded every Greeks tile and 1 to 8 leg rows on every tab; they exist on Build. It checks them on Build and checks the strip's value and P&L everywhere |
| robustness | mobile walk (375 px), seed 404 | C, F | (1) with no engine the browser logs a refused WebSocket as a console error; error watchers ignore exactly that line when no engine is up. (2) Then the walk could not click the first phone tab: the Next dev server's floating "N" badge sits over it. `devIndicators: false` (dev only; not in the export) |
| robustness | eight legs in an extreme market | D, C | same `expectSane`; the engine agreement step runs only when an engine answers |
| robustness | **malformed uploads are reported** | **E** | **App bug, fixed in the app.** The importer is a `<dialog>`. Closing it fires `close` a task later; if the next file arrives in between, the stale event closed the freshly reopened dialog and the preview was never visible. 6 of 6 runs failed on the old code and pass on the fix (`ImportDialog`, `CommandPalette` and the new shortcuts sheet now ignore a `close` event while their dialog is open). A person re-importing right after closing could hit it |
| robustness | stacked stress restores the market | C, D | engine assertions only with an engine (`wasm` otherwise); `leg-0-dte` read on Build |
| robustness | an engine crash falls back to WebAssembly | C | engine gate |
| robustness | an engine that never answers leaves an honest Offline | D | `expectSane`; Reconnect is exercised only when an engine can answer |
| robustness | native engine unreachable, WebAssembly prices the terminal | D | `expectSane` |
| robustness | rapid spot scrubbing on the C++ stream | C | engine gate. In engine mode it then failed on a React **dev-only** warning, see below |

The remaining 9 passed before and still do (a11y, terminal 1, 4, 5, 6, 7 xlsx, 7 xls, 8, 11).

## The scrubbing test in engine mode (understood, not an app bug)

With the engine up, `rapid spot scrubbing` failed with "Maximum update depth exceeded". It happens on `main` too, so
it is not from this work. The message is React's **development-only** counter of back-to-back passive-effect updates;
the test fired 25 `input` events per task and each one triggers the app's timing effects. The exported site (what
users get) does not warn: the test passes against `out/` with the engine, three runs of three. The test now yields
every fourth event; it still sends 400 moves and still requires the exact engine price at the end and no console
errors.

## Added

- `hotkeys.spec.ts` (10 tests): `?` sheet, `]` and `[` stepping with wrap, `/`, `Ctrl+K`, `P`, key hints in the
  palette, `M` `V` `I`, `R` with its undo toast, `N`, `T`, **typing `r` in the strike input does not reset the
  market**, nothing fires while the palette or the sheet is open, and the single-key switch.
- `intro.spec.ts` (7 tests): first visit shows the band, the examples run, dismissal persists across a reload, `T`
  brings it back, no layout shift, blocked `localStorage`, and the phone layout.
- `a11y.spec.ts`: axe over the intro band, the shortcuts sheet and the palette (found a scrollable region with no
  keyboard access in the sheet, fixed).

## Running

```bash
npm run test:e2e           # no engine needed; the 12 engine tests skip and say so
npm run test:e2e:engine    # starts server/ws_server.py (PYTHON=/path/to/python3), and an unreachable engine FAILS the run
QC_STATIC=1 npm run test:e2e   # against out/ (npm run build first), which is what CI does
```

## Open

Nothing unexplained.
