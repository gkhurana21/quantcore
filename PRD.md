# QuantCore — Product Requirements Document

**From portfolio demo to real product.**

| | |
|---|---|
| Status | Draft v1.0 |
| Owner | Gaurang Khurana |
| Date | August 2, 2026 |
| Live demo (today) | [quantcore-gk.netlify.app](https://quantcore-gk.netlify.app) |

---

## 1. Summary

QuantCore today is a portfolio piece: a static Netlify export of a Next.js dashboard where all pricing (Black-Scholes, binomial, Monte Carlo) runs in-browser JavaScript against **hardcoded price snapshots** for five tickers. The C++17/Metal engine only activates on localhost. There are no accounts, no persistence, no analytics, no sharing, and no live market data.

This PRD defines the path to a real product: a **free, student-first options strategy sandbox** — build a strategy, see not just the payoff diagram but the *risk* (Greeks, VaR, Monte Carlo behavior), explained interactively. Ship live data, shareable strategy URLs, a learn mode, and analytics in ~4 weeks; layer accounts, portfolio import, and SEO pages after.

**Positioning in one line:** *See the risk, not just the payoff.*

---

## 2. Problem

People learning options today choose between two bad options:

1. **Calculators** (OptionStrat, Options Profit Calculator): payoff-diagram-focused, ad-heavy, assume you already understand Greeks, and teach nothing. Risk beyond the hockey-stick chart is invisible.
2. **Textbooks / courses** (Hull, YouTube, university lectures): explain the theory but offer no interactivity — you can't drag vol up 10 points and *watch* an iron condor breathe.

Nobody serves the person in the middle: the student or new trader who wants to build intuition by playing with a live, honest model. QuantCore already has the hard part built — a validated pricing core, Greeks, VaR, Monte Carlo, and an interactive dashboard with scenario sliders. What's missing is live data, distribution, and a learning layer.

**The C++/GPU engine is credibility, not the product.** It stays in the README and the Show HN post; the product is the browser experience.

---

## 3. Users and personas

In priority order:

### P0 — The student ("Maya")
Finance or CS student, taking a derivatives course or self-teaching for a trading club / internship interview. Knows what a call option is; does not yet have intuition for theta decay or why vol crush hurts. Needs:
- Guided exploration ("build a straddle, now spike vol, watch what happens")
- Plain-language explanations of Greeks attached to live numbers
- Free, no signup wall, works on a laptop in a lecture hall

**User stories:**
- As a student, I can follow a guided lesson that builds a strategy for me and prompts me to move sliders, so I develop intuition instead of memorizing formulas.
- As a student, I can hover any Greek and get a one-paragraph plain-language explanation tied to my current strategy.
- As a student, I can pick *any* ticker my professor mentions, not just 5 presets.

### P1 — The retail trader ("Dev")
Active on r/options or r/thetagang. Trades weeklies and spreads. Wants a fast sanity check on a trade idea and a way to show his analysis to others. Needs:
- Live quotes and option chains for real strikes/expiries
- A shareable link that reproduces his exact strategy and view
- 1-day VaR and vol-shock surface on his actual position

**User stories:**
- As a trader, I can load the real option chain for a ticker and build a strategy from actual strikes and expiries with market IVs.
- As a trader, I can copy a URL that reproduces my exact strategy so I can paste it into a Reddit comment.
- As a trader, I can import my Questrade positions read-only and see portfolio Greeks and VaR (Phase 2).

### P2 — The quant dev ("Priya") — deferred
Wants the fast pricing core as a library (`pip install quantcore`). Out of scope for the next two phases; noted here so the door stays open. The MIT-licensed repo and benchmark story already serve this audience passively.

---

## 4. Goals and success metrics

### North star
**Weekly Active Strategy Builders (WASB):** unique users who built or modified at least one strategy that week. This measures the core loop, not vanity traffic.

### Metric definitions
| Metric | Definition | Instrumented via |
|---|---|---|
| WASB (north star) | Unique users with ≥1 `strategy_built` or `strategy_modified` event in a 7-day window | PostHog |
| Activation rate | % of new visitors who fire `strategy_built` in their first session | PostHog funnel |
| Share rate | `share_link_copied` events per week; downstream, sessions arriving with a strategy payload in the URL | PostHog + URL param tracking |
| Lesson completion | % of users starting a Learn-mode lesson who finish it | PostHog funnel per lesson |
| Retention (W1) | % of week-N activated users who return in week N+1 | PostHog cohorts |

### Targets (3 months post-MVP launch)
- **500 MAU, 100 WAU** total; **50+ WASB**
- Activation ≥ **30%** of new visitors
- ≥ **20 shared strategy links** clicked per week
- W1 retention ≥ **15%** (education tools are inherently bursty; sharing is the compounding loop)

Instrument first, observe two weeks of baseline, then hold ourselves to targets. No metric theater before there's data.

---

## 5. Current state (audit, Aug 2026)

Grounding for everything below — what exists and what doesn't:

| Area | Today |
|---|---|
| Deployment | Static export (`output: 'export'`) via `netlify.toml`; no backend of any kind deployed |
| Pricing | In-browser JS: Black-Scholes + Greeks, binomial CRR, seeded Monte Carlo — all in `dashboard/components/Dashboard.tsx` |
| Native engine | C++17 core + Metal GPU MC, exposed via FastAPI WebSocket (`server/ws_server.py`) — **localhost only**, and authoritative only for the canonical SPY single-leg |
| Market data | **Hardcoded snapshots** (e.g. SPY 756.48) for SPY/AAPL/NVDA/TSLA/QQQ; labeled "indicative" |
| Strategies | Presets (straddle, strangle, bull spread, iron condor), up to 8 legs, client-side CSV/Excel upload |
| Risk views | P&L chart, per-Greek curves, 1-day 95% parametric VaR tile, spot×vol P&L surface |
| Accounts / DB / analytics | None |
| Sharing | None — state lives only in component memory |
| Questrade | Personal read-only integration (`questrade/`, `analysis/`), single `.env` refresh token, CLI reports — not multi-user, not in the web app |

Implication: the fastest path to users is **backend-light**. The browser already prices everything; we need data in, links out, lessons on top, and measurement underneath.

---

## 6. Scope

### 6.1 MVP — Phase 1 (~4 weeks)

#### F1. Live market data (any ticker)
Replace hardcoded snapshots with real quotes and option chains behind a **small Go proxy service** (deployed free on Fly.io or Cloud Run), sourced from the **Alpaca free Basic plan** (decided — see §11: paper-only account, global email signup that works from Canada, IEX stock quotes + options indicative feed with Greeks/IV, 200 req/min). The dashboard stays a static Netlify deploy and talks to the proxy over HTTPS.

**Requirements:**
- Ticker search: any US-listed equity/ETF, not just the 5 presets (presets remain as quick starts)
- Quote: last/spot, and current IV where the API provides it; indicative/IEX-only data is acceptable and labeled as such
- Option chain: real expiries and strikes selectable in the strategy builder; leg IV defaults from the chain when available, editable via slider as today
- Go proxy caches responses in memory (chains: 15 min TTL, quotes: 1 min TTL) to stay well inside Alpaca's 200 req/min free limit; client never holds the API keys
- Graceful degradation: if the data API is down or rate-limited, fall back to the current snapshot behavior with a visible "indicative data" banner — the app never breaks

**Acceptance criteria:**
- User types "AMD", gets a live-ish spot price, opens the chain, builds a call spread from two real strikes, and all pricing tiles update.
- API key is not present in any client bundle.
- With the proxy unreachable, the app still loads and prices with snapshot data.

#### F2. Shareable strategy URLs
Encode full strategy state (ticker, legs, spot/vol/rate overrides, active view) into the URL — compressed JSON in a query param or hash. Zero backend, instant virality primitive.

**Requirements:**
- "Share" button copies a URL that reproduces the exact strategy and scenario slider state
- Opening a shared URL hydrates the dashboard to that state before first paint (no flash of default state)
- URL length kept sane via compression (e.g. `lz-string`); 8 legs must fit comfortably
- Shared sessions are tagged in analytics (arrived-via-share)

**Acceptance criteria:**
- Build an iron condor on NVDA with vol bumped +5 pts, copy link, open in incognito: identical strategy, identical numbers.
- Link pasted into Discord/Reddit unfurls with meaningful OG title/description (see F5).

#### F3. Learn mode
The student wedge. 5–7 guided, interactive lessons layered onto the existing dashboard — the lesson drives the strategy builder and sliders, then prompts the user to act.

**Lesson list (v1):**
1. What an option price is made of (intrinsic vs time value)
2. Delta: your directional exposure, live
3. Theta: watch a straddle bleed day by day
4. Vega and vol crush: why being right isn't enough
5. How an iron condor breathes (spot range × vol)
6. Reading the P&L surface (spot × vol shocks)
7. What 1-day VaR actually tells you

**Requirements:**
- Lessons are a step-sequence overlay: each step sets up dashboard state, highlights the relevant control/tile, shows 2–4 sentences, and (where applicable) asks the user to do something ("drag vol to 35 — what happened to the call price?")
- Each Greek tile gets a persistent "explain" affordance (hover/tap) with plain-language copy tied to the current strategy, independent of lessons
- Lessons are linkable (`/learn/theta-decay`) — these are the SEO surface
- Progress stored in `localStorage` (no accounts in MVP)

**Acceptance criteria:**
- A user with zero options knowledge can complete lesson 1–3 in under 15 minutes and ends with a strategy on screen they manipulated themselves.
- Each lesson fires start/step/complete analytics events.

#### F4. Analytics
PostHog (free tier), client-side, with a minimal consented setup.

**Requirements:**
- Events: `page_view`, `strategy_built`, `strategy_modified`, `leg_added`, `csv_uploaded`, `share_link_copied`, `arrived_via_share`, `lesson_started`, `lesson_step_completed`, `lesson_completed`, `ticker_searched`, `chain_loaded`
- Funnels: visitor → strategy_built (activation); lesson start → complete
- No PII collected; anonymous IDs; simple privacy note in the footer

**Acceptance criteria:** every metric in §4 is computable from live events before launch day.

#### F5. Domain, landing, and link polish
- Real domain (e.g. `quantcore.app` or subdomain of gaurangkhurana.ca) replacing `*.netlify.app`
- Meta/OG tags: shared strategy links unfurl with the ticker + strategy name; lesson pages unfurl with the lesson title
- Landing above-the-fold rewrite: lead with "learn options by breaking them" for students, not the benchmark table (benchmarks move down the page — they're credibility, not the pitch)
- Lightweight favicon/social card

### 6.2 Phase 2 (weeks 5–10)

1. **Accounts + saved strategies** — Supabase (free tier): email/OAuth login, save/rename/delete strategies, "my strategies" list. Sharing stays URL-based (accounts are for persistence, not gating).
2. **Questrade read-only portfolio import** — productize the existing `questrade/` work as multi-user OAuth ("Connect Questrade, read-only"), mapping positions into the dashboard for portfolio Greeks + live VaR (reusing the logic in `analysis/pricer.py` / `analysis/var_live.py`, ported or proxied). Read-only scope only; token storage server-side in Supabase with encryption. This is the differentiator vs OptionStrat for Canadian retail.
3. **SEO strategy pages** — statically generated `/strategies/iron-condor`, `/strategies/straddle`, etc. from the existing presets: explanation, when-to-use, embedded live builder pre-loaded with the strategy, link into the relevant lesson.

### 6.3 Phase 3 (directional, not committed)
- **SwiftUI native Mac app** — the natural home for the Apple Silicon-only C++/Metal engine: heavy Monte Carlo path counts, live portfolio Greeks in the menu bar, Questrade positions. A companion power tool, never a replacement for the web app (the web app is the acquisition surface — links, SEO, cross-platform)
- `pip install quantcore` — package the pybind11 core for the P2 quant-dev audience
- Hosted native engine for heavy Monte Carlo ("run 10M paths" button) if usage justifies a server
- Paid tier consideration **only after >1,000 MAU** (candidate: real-time data, portfolio alerts)

---

## 7. Non-goals

- **No trade execution, ever in current scope.** Read-only brokerage access only. Executing trades triggers regulatory, liability, and security burdens a solo maintainer should not carry.
- **No paid tier before 1,000 MAU.** Monetizing before product-market fit kills education products.
- **No server-side C++/GPU engine in MVP.** In-browser Black-Scholes is accurate enough for education and strategy analysis; the native engine remains a localhost power feature and a marketing story.
- **No mobile app.** Responsive web only.
- **No real-time streaming quotes in MVP.** Delayed data, honestly labeled, is fine for the target users.

---

## 8. Go-to-market (student-first)

| Channel | Play | Cadence |
|---|---|---|
| University clubs | Live workshop: "build and break an iron condor in 20 minutes" for finance/quant/CS clubs (start with own network). The demo *is* the pitch; end with the Learn-mode link. | 1–2/month starting week 5 |
| Reddit (r/options, r/thetagang) | Answer real strategy questions with substance + a share-link reproducing the analysis. Never bare self-promo — the link is the receipt for the answer. | Ongoing, 2–3 quality answers/week |
| Show HN / r/algotrading | One well-crafted launch post angled at the engineering story (C++17 core, Metal Philox MC, 69x vs NumPy) with the product as the payoff. Do this **after** live data ships — HN traffic against a hardcoded-snapshot demo is wasted. | Once, ~week 5 |
| SEO | Learn-mode lessons + Phase 2 strategy pages target "theta decay explained", "iron condor calculator", "options greeks explained" query classes. Slow burn, compounds. | Continuous after MVP |
| Webring / personal site | cs.wtf webring (PR #164) + portfolio traffic. A trickle; costs nothing. | Passive |
| Course/TA channels | Where legitimate, offer the tool to derivatives-course TAs as a free lecture aid (lessons map to standard syllabi). | Opportunistic |

Launch sequencing: **ship MVP quietly → 1–2 club workshops + Reddit answering to validate activation → Show HN once the funnel holds.**

---

## 9. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Free data API rate limits / ToS issues | High | Proxy-side caching (chains 15 min, quotes 1 min); indicative data clearly labeled; snapshot fallback keeps app alive; provider is swappable behind the proxy's normalized API (proven: Tradier swapped to Alpaca in under a day) |
| "OptionStrat clone" perception | Medium | Differentiate relentlessly on education + risk (Learn mode, VaR, MC, vol surface) — never compete on payoff diagrams alone |
| Solo-maintainer scope creep | High | MVP is deliberately backend-light (one small Go proxy + URL sharing only); accounts and Questrade explicitly deferred to Phase 2; this PRD is the scope contract |
| Nobody shares links | Medium | Share is the core loop bet — instrument `arrived_via_share` from day one; if share rate is dead by week 8, pivot GTM weight to SEO/lessons |
| Questrade OAuth (Phase 2) security burden | Medium | Read-only scopes only, tokens encrypted server-side, or defer entirely if Phase 1 metrics don't justify it |
| Data accuracy complaints (indicative quotes vs broker) | Low | "Indicative — for education and analysis, not execution" labeling everywhere data appears |

---

## 10. Milestones

| Week | Deliverable | Exit criteria |
|---|---|---|
| 0–1 (parallel) | **Validation sprint** — competitor teardown (OptionStrat, OPC, optionsprofitcalculator), 10 conversations with students/club members/r-options regulars, keyword volume check for the 7 lesson topics | Written 1-pager: confirmed top-3 user pains, lesson topics re-ranked by search volume, one differentiator sharpened or cut |
| 1 | Go proxy for Alpaca data (deployed on Fly.io/Cloud Run) + PostHog wired | Live quote + chain for any ticker via proxy in a branch; baseline events flowing |
| 2 | F1 integrated into dashboard (ticker search, chain-driven legs, fallback) | F1 acceptance criteria pass |
| 3 | F2 share URLs + F5 domain/OG polish | F2 acceptance criteria pass; links unfurl |
| 4 | F3 Learn mode (lessons 1–5 minimum) | Lessons 1–3 completable by a naive user; all events firing; **MVP launch** |
| 5–6 | Quiet launch: 1–2 club workshops, Reddit answering begins; Show HN post | ≥50 activated users; funnel data reviewed |
| 7–10 | Phase 2: Supabase accounts + saved strategies; SEO strategy pages; Questrade import (go/no-go based on week-6 metrics) | Accounts live; ≥3 strategy pages indexed |
| 12 | Metrics review against §4 targets | Decide Phase 3 direction with data |

---

## 11. Decisions (locked)

Final calls, chosen for safety and highest odds of success. One-line rationale each.

1. **Data provider: Alpaca free Basic plan (paper-only account).** Paper accounts are a global email signup — works from Canada, no brokerage application — and the free tier includes IEX stock quotes plus an options indicative feed *with Greeks/IV* at 200 req/min; Tradier now requires a US-only brokerage account, Polygon free (5 req/min) cannot serve chains, yfinance is unofficial and gap-prone. Caveat, honestly labeled in-product: the indicative options feed approximates real OPRA quotes — right for education/analysis, never for execution.
2. **Backend: a single small Go proxy service (Fly.io/Cloud Run free tier); dashboard stays static on Netlify.** The proxy is the entire backend for MVP — Go is a perfect fit for a caching HTTP proxy, deploys free, and leaves room to grow past serverless if the product takes off.
2a. **SwiftUI: Phase 3 native Mac companion app only, never the main product.** The Metal engine is Apple Silicon-only anyway, so a Mac app is its natural home — but the web app stays the acquisition surface because share links, SEO, and Windows-laptop students all die behind an App Store download.
3. **Domain: buy a new product domain (`quantcore.app`-class).** Product identity separate from the personal site, needed for OG/SEO credibility; ~$15/yr and fully reversible.
4. **Sharing: compressed state in the URL (lz-string), no database.** Links work forever, cost nothing, and can't break — persistence via DB is deferred until accounts exist.
5. **Analytics: PostHog Cloud free tier, anonymous events only.** Measurable from day one with no PII and no consent-banner burden.
6. **Learn mode: ship 5 lessons minimum at launch (intrinsic/time value, delta, theta, vega, iron condor), each on a linkable route.** Five is enough to prove the wedge and seed SEO; more lessons follow demand, not precede it.
7. **Native C++/GPU engine stays localhost-only.** In-browser Black-Scholes is accurate for education; hosting the engine adds cost and ops for zero user-visible gain at this stage.
8. **Launch order: quiet MVP, then club workshops + Reddit answering, then Show HN at ~week 5.** Never spend the one HN shot on a demo still running snapshot data.
9. **Accounts: Supabase in Phase 2, not MVP.** A signup wall before product-market fit kills activation; add persistence only once share/activation data justifies it.
10. **Questrade multi-user import: conditional go at week 6.** Proceed only if Phase 1 metrics hold *and* Questrade's app terms permit a hosted multi-user read-only app — otherwise it stays a personal power feature.
11. **Monetization: none before 1,000 MAU.** Free-and-honest is the moat against ad-heavy incumbents; charging early would strangle the student wedge.
12. **All market data labeled "indicative — for education and analysis, not execution."** Pre-empts accuracy complaints and keeps liability posture clean.
13. **Research: a 1-week validation sprint in parallel with the build — never a months-long research phase.** With zero users, desk research produces guesses while a shipped, instrumented MVP produces facts; the sprint (competitor teardown, 10 user conversations, keyword check) captures 80% of the value at 2% of the time cost.
14. **Passive investing: parked, not built.** It's a different product for a different user in a saturated free market (Portfolio Visualizer, robo-advisors), and it would blur the one sharp wedge — options risk; revisit only if Phase 2 Questrade imports show accounts dominated by ETFs, in which case a "whole portfolio risk" view earns its way in through data (see §12).

Remaining human task (not a blocker): get one derivatives TA/professor or experienced trader to sanity-check Learn-mode copy before launch.

---

## 12. Parking lot (ideas explicitly not scheduled)

Kept here so they stop competing for attention. Nothing in this list gets built without metric evidence.

- **Passive investing / portfolio allocation tools** — only path in: Phase 2 Questrade data shows most connected accounts are ETF-heavy, in which case ship a read-only "whole portfolio risk" (VaR, drawdown) view — analysis, not advice; never robo-advisor territory.
- **Hosted GPU engine** ("run 10M paths" button) — needs demonstrated demand for precision beyond in-browser BS.
- **Real-time (non-delayed) data** — first candidate for a paid tier, after 1,000 MAU.
- **Mobile app** — responsive web covers it until data says otherwise.
