#!/usr/bin/env python3
"""
QuantCore Phase 3 — Per-strike IV round-trip validation
=========================================================
For each liquid option in the cached chains:
  1. Invert BS on the market mid-price to recover the implied vol.
  2. Price the option again with that IV using the QuantCore C++ engine.
  3. Measure (model_price − market_mid) / market_mid.

What this validates
-------------------
This is a NUMERICAL FIDELITY test, not a model prediction test.
It checks that the BS implementation faithfully round-trips:

    market_mid  →  IV inversion  →  sigma  →  BS price  ≈  market_mid

A faithful implementation fed its own option's IV must reproduce that
option's market price to within the inversion tolerance (~1e-7 in price).
Any per-strike deviation > 2% is a real engine bug, not a market model
limitation.

What this does NOT validate
---------------------------
This does NOT show that flat-vol BS predicts market prices.
It shows the engine correctly implements Black-Scholes.
Those are different claims; the round-trip result must never be quoted
as evidence the model prices options well without further vol calibration.

Run from quantcore/python/:  python3 phase3_per_iv.py
"""

import os, sys, math, warnings
import numpy as np
import pandas as pd

warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    import quantcore
except ImportError as e:
    sys.exit(f"ERROR: {e}")

CACHE     = 'cache'
RISK_FREE = 0.045
MON_BINS  = [0.0, 0.90, 0.95, 0.97, 1.03, 1.05, 1.10, 9.0]
MON_LBLS  = ['<0.90','0.90–0.95','0.95–0.97','ATM±3%','1.03–1.05','1.05–1.10','>1.10']


# ── IV inversion ──────────────────────────────────────────────────────────────

def invert_iv(mid, S, K, r, T, call, tol=1e-8, max_iter=200):
    """Newton-Raphson IV from market mid using C++ bs_full.
    Returns (sigma, converged) — converged=False if max_iter hit."""
    if T <= 0 or mid < 1e-5:
        return None, False
    t_int = 0 if call else 1
    denom = S * math.sqrt(max(T / (2 * math.pi), 1e-12))
    sigma = max(0.005, min(mid / denom, 5.0))
    for i in range(max_iter):
        try:
            res = quantcore.bs_full(t_int, float(S), float(K),
                                    float(r), float(sigma), float(T))
        except Exception:
            return None, False
        p, v = res['price'], res['vega']
        if v < 1e-14:
            return None, False
        step  = (p - mid) / v
        sigma -= step
        sigma  = max(0.001, min(sigma, 20.0))
        if abs(p - mid) < tol:
            return sigma, True
    return sigma, False   # max_iter reached — note as not-converged


# ── Load cached chains ────────────────────────────────────────────────────────

def load_all_chains():
    frames = []
    for fname in sorted(os.listdir(CACHE)):
        if not fname.startswith('opts_') or not fname.endswith('.csv'):
            continue
        df = pd.read_csv(f"{CACHE}/{fname}")
        # derive ticker from filename: opts_SPY_20260630.csv → SPY
        parts  = fname.replace('.csv','').split('_')
        ticker = parts[1]
        expiry = f"{parts[2][:4]}-{parts[2][4:6]}-{parts[2][6:]}"
        df['ticker'] = ticker
        df['expiry'] = expiry
        today = pd.Timestamp.now().normalize()
        df['dte'] = (pd.Timestamp(expiry) - today).days
        frames.append(df)
    if not frames:
        sys.exit("ERROR: no cached option files found in cache/")
    return pd.concat(frames, ignore_index=True)


# ── Main validation ───────────────────────────────────────────────────────────

def main():
    print("QuantCore Phase 3 — Per-strike IV round-trip validation")
    print("=" * 66)
    print("""
  Claim tested : numerical fidelity of the BS implementation.
  Method       : invert BS on market mid → get per-strike IV →
                 re-price with that IV → measure residual.
  Expected     : residual ≈ 0 (limited by Newton-Raphson tolerance).
  NOT tested   : whether flat-vol BS predicts market prices.
""")

    chains = load_all_chains()

    # Liquidity filter — same as phase3_gate.py
    df = chains[
        (chains['bid']       >  0.05) &
        (chains['ask']       >  0.05) &
        (chains['mid']       >  0.10) &
        (chains['dte']       >= 5)    &
        (chains['moneyness'] >= 0.80) &
        (chains['moneyness'] <= 1.25)
    ].copy()
    df['T'] = df['dte'] / 365.0

    print(f"  Liquid options to test: {len(df)}  "
          f"({df['ticker'].nunique()} tickers, "
          f"{df['expiry'].nunique()} expiries)\n")

    records   = []
    n_failed  = 0
    n_noconv  = 0

    for _, row in df.iterrows():
        call  = (row['type'] == 'call')
        sigma, converged = invert_iv(
            float(row['mid']), float(row['spot']), float(row['strike']),
            RISK_FREE, float(row['T']), call)

        if sigma is None:
            n_failed += 1
            continue
        if not converged:
            n_noconv += 1

        # Re-price with the recovered IV
        t_int   = 0 if call else 1
        reprice = quantcore.bs_price(
            t_int, float(row['spot']), float(row['strike']),
            RISK_FREE, float(sigma), float(row['T']))

        rel_err = (reprice - row['mid']) / row['mid'] * 100.0

        records.append(dict(
            ticker    = row['ticker'],
            expiry    = row['expiry'],
            type      = row['type'],
            strike    = row['strike'],
            spot      = row['spot'],
            moneyness = row['moneyness'],
            mid       = row['mid'],
            iv        = sigma,
            reprice   = reprice,
            rel_err   = rel_err,
            abs_err   = abs(rel_err),
            converged = converged,
        ))

    res = pd.DataFrame(records)
    res['bucket'] = pd.cut(res['moneyness'], bins=MON_BINS,
                           labels=MON_LBLS, right=True)

    # ── Inversion outcome summary ─────────────────────────────────────────────
    n_total    = len(df)
    n_priced   = len(res)
    n_conv     = res['converged'].sum()

    print(f"  Inversion outcomes:")
    print(f"    Total options       : {n_total}")
    print(f"    IV inversion OK     : {n_priced}  "
          f"({100*n_priced/n_total:.1f}%)")
    print(f"    Fully converged     : {n_conv}  "
          f"({100*n_conv/n_priced:.1f}% of priced)")
    print(f"    Max-iter (not conv) : {n_noconv}")
    print(f"    IV inversion failed : {n_failed}  "
          f"(vega too small, excluded)\n")

    # ── Round-trip deviation by moneyness ─────────────────────────────────────
    print(f"  Round-trip deviation  (model_price − market_mid) / market_mid")
    print(f"  {'Bucket':<12} {'N':>5} {'Mean%':>10} {'Median%':>10} "
          f"{'Max abs%':>9} {'<0.01%':>8} {'<0.1%':>7} {'<2%':>6}")
    print(f"  {'-'*12} {'-'*5} {'-'*10} {'-'*10} "
          f"{'-'*9} {'-'*8} {'-'*7} {'-'*6}")

    any_fail = False
    for lbl in MON_LBLS:
        g = res[res['bucket'] == lbl]
        if len(g) < 3:
            continue
        n     = len(g)
        mn    = g['rel_err'].mean()
        med   = g['rel_err'].median()
        mx    = g['abs_err'].max()
        p001  = (g['abs_err'] < 0.01).mean()  * 100
        p01   = (g['abs_err'] < 0.1 ).mean()  * 100
        p2    = (g['abs_err'] < 2.0 ).mean()  * 100
        flag  = "  *** BUG?" if p2 < 90 else ""
        if p2 < 90:
            any_fail = True
        tag = "  ← ATM" if lbl == 'ATM±3%' else ""
        print(f"  {lbl:<12} {n:>5} {mn:>+10.4f}% {med:>+10.4f}% "
              f"{mx:>9.4f}% {p001:>7.1f}% {p01:>6.1f}% {p2:>5.1f}%{tag}{flag}")

    # ── Overall ───────────────────────────────────────────────────────────────
    print(f"\n  Overall ({n_priced} options):")
    print(f"    Mean error   : {res['rel_err'].mean():+.6f}%")
    print(f"    Median error : {res['rel_err'].median():+.6f}%")
    print(f"    Max abs err  : {res['abs_err'].max():.4f}%")
    print(f"    Within 0.01% : {(res['abs_err']<0.01).mean()*100:.1f}%")
    print(f"    Within 0.1%  : {(res['abs_err']<0.1 ).mean()*100:.1f}%")
    print(f"    Within 2%    : {(res['abs_err']<2.0 ).mean()*100:.1f}%")

    # ── Flag large residuals ──────────────────────────────────────────────────
    large = res[res['abs_err'] >= 2.0].sort_values('abs_err', ascending=False)
    if not large.empty:
        print(f"\n  Options with |error| >= 2%  ({len(large)} cases):")
        print(f"  {'Ticker':<6} {'Expiry':<12} {'Type':<5} {'Strike':>8} "
              f"{'K/S':>6} {'Mid':>8} {'IV':>7} {'Reprice':>9} {'Err%':>8}")
        for _, r in large.head(20).iterrows():
            print(f"  {r['ticker']:<6} {r['expiry']:<12} {r['type']:<5} "
                  f"{r['strike']:>8.0f} {r['moneyness']:>6.3f} "
                  f"{r['mid']:>8.3f} {r['iv']:>7.4f} "
                  f"{r['reprice']:>9.3f} {r['rel_err']:>+8.2f}%")

    # ── Verdict ───────────────────────────────────────────────────────────────
    print(f"""
  ─────────────────────────────────────────────────────────────────
  VERDICT
  ─────────────────────────────────────────────────────────────────
  {"ENGINE BUG DETECTED — see flagged rows above." if any_fail else
   "Engine passes round-trip test."}

  What is validated:
    The QuantCore BS engine reproduces a market option's mid-price
    to within {"<0.01%" if (res['abs_err']<0.01).mean()>0.90 else
               "<0.1%"  if (res['abs_err']<0.1 ).mean()>0.90 else "<2%"}
    when fed that option's own market-implied vol per strike.

  What is NOT validated:
    This does not show BS predicts market prices without per-strike
    vol calibration.  A flat vol applied across strikes will diverge
    from the market wherever the vol surface is not flat — which, for
    equity indices like SPY, is always.  These are separate claims.
  ─────────────────────────────────────────────────────────────────
""")

    return res


if __name__ == '__main__':
    main()
