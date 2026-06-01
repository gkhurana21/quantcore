"""
Pure-Python reference implementation of the same pricing math as the C++ core.

BS pricing:   NumPy-vectorized.  Accepts scalars or arrays via broadcasting.
              NDF: scipy.special.erfc (same mathematical function as C++ std::erfc).

MC pricing:   NumPy-vectorized paths.  All N paths generated at once with
              np.random.default_rng; payoff computed with np.maximum; no Python
              for-loop over paths.  This is the natural way a competent Python/
              NumPy developer would write it.

Scalar BS:    Pure-Python, math module, explicit for-loop at the call site — the
              *unfair* baseline provided only so the report can show both numbers.
"""

import math
import numpy as np
from scipy.special import erfc as scipy_erfc


# ── helpers ───────────────────────────────────────────────────────────────────

def _ncdf_np(x):
    """N(x) = 0.5 * erfc(-x/√2) — identical formula to C++ norm_cdf."""
    return 0.5 * scipy_erfc(-x / math.sqrt(2.0))


def _ncdf_scalar(x):
    """Scalar version using math.erfc."""
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


# ── NumPy-vectorized BS (fair baseline) ──────────────────────────────────────

def bs_price_numpy(S, K, r, sigma, T, call=True):
    """Black-Scholes price, vectorized over all inputs (numpy broadcasting).

    This is what a competent Python quant would write — no Python loops,
    all operations are NumPy ufuncs or scipy erfc.
    """
    sqrtT = np.sqrt(T)
    d1 = (np.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    disc = np.exp(-r * T)
    if call:
        return S * _ncdf_np(d1) - K * disc * _ncdf_np(d2)
    else:
        return K * disc * _ncdf_np(-d2) - S * _ncdf_np(-d1)


def bs_full_numpy(S, K, r, sigma, T, call=True):
    """BS price + Greeks, all vectorized."""
    sqrtT = np.sqrt(T)
    d1 = (np.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2 = d1 - sigma * sqrtT
    disc = np.exp(-r * T)
    inv_sqrt2pi = 0.3989422804014326779
    phid1 = inv_sqrt2pi * np.exp(-0.5 * d1 * d1)

    if call:
        price = S * _ncdf_np(d1) - K * disc * _ncdf_np(d2)
        delta = _ncdf_np(d1)
        theta = -(S * phid1 * sigma) / (2.0 * sqrtT) - r * K * disc * _ncdf_np(d2)
    else:
        price = K * disc * _ncdf_np(-d2) - S * _ncdf_np(-d1)
        delta = _ncdf_np(d1) - 1.0
        theta = -(S * phid1 * sigma) / (2.0 * sqrtT) + r * K * disc * _ncdf_np(-d2)

    gamma = phid1 / (S * sigma * sqrtT)
    vega  = S * phid1 * sqrtT
    return price, delta, gamma, theta, vega


# ── NumPy-vectorized MC (fair baseline) ──────────────────────────────────────

def mc_price_numpy(S, K, r, sigma, T, paths, seed=42, call=True):
    """GBM Monte Carlo, all paths generated at once with NumPy.

    np.random.default_rng uses PCG64 (not MT19937) — different RNG than the
    C++ mt19937_64, so prices will differ by sampling noise, but the
    distribution is the same and convergence behaviour is comparable.
    """
    rng = np.random.default_rng(seed)
    Z   = rng.standard_normal(paths)
    ST  = S * np.exp((r - 0.5 * sigma * sigma) * T + sigma * math.sqrt(T) * Z)
    payoff = np.maximum(ST - K, 0.0) if call else np.maximum(K - ST, 0.0)
    return float(np.exp(-r * T) * np.mean(payoff))


# ── Scalar Python BS (unfair baseline, call-site loops) ──────────────────────

def bs_price_scalar(S, K, r, sigma, T, call=True):
    """Single-option, pure-Python BS.  Caller loops over options."""
    sqrtT = math.sqrt(T)
    d1    = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
    d2    = d1 - sigma * sqrtT
    disc  = math.exp(-r * T)
    if call:
        return S * _ncdf_scalar(d1) - K * disc * _ncdf_scalar(d2)
    else:
        return K * disc * _ncdf_scalar(-d2) - S * _ncdf_scalar(-d1)
