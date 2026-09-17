#!/usr/bin/env python3
"""
QuantCore WebSocket engine server
=================================
FastAPI + uvicorn.  Dispatches pricing, Greeks, P&L and Monte Carlo to the
C++ engine through the pybind11 bindings (bindings/quantcore_py.cpp).

GIL note
--------
py::gil_scoped_release wraps the C++ compute inside bs_full, mc_price,
mc_price_gpu and the batch functions.  Any thread calling into the C++
pricing core releases Python's GIL for the duration of the computation, so
other handlers keep running.  Monte Carlo requests are additionally moved off
the event loop with asyncio.to_thread, so pings and streaming updates on the
same connection are answered while a simulation runs (the CPU fallback
mc_price_mt does not release the GIL, so it is the slower path).

Wire protocol
-------------
v1 — streaming contract for one subscribed option (unchanged; used by the
dashboard's canonical position and server/latency_harness.py):

Client → Server  subscribe:
    {"type":"subscribe",
     "option":{"S":756.48,"K":755,"r":0.045,"sigma":0.138,"T":0.129,
               "call":true,"position":10}}

Client → Server  update (spot / vol / rate change):
    {"type":"update","S":757.0,"sigma":0.14,"t_ns":1748700000123456789}

Server → Client  subscribed:
    {"type":"subscribed","entry_price":18.01,"price":...,
     "delta":...,"gamma":...,"theta":...,"vega":...}

Server → Client  result:
    {"type":"result","price":...,"delta":...,"gamma":...,"theta":...,
     "vega":...,"pnl":...,"t_ns":<echo>,"calc_us":...}

v9 — mc_exotic gains spec.rebate (≥ 0) and spec.rebate_at_hit: the knock-out pays the rebate when the barrier is
hit, or at expiry when rebate_at_hit is false, and the knock-in pays it at expiry when the barrier is never touched.
A rebate breaks in-out parity — paid at expiry, out + in exceeds the vanilla by exactly rebate·e^(−rT). Absent or 0
pays no rebate and the exchange is exactly the v8 one.

v8 — mc_exotic gains spec.monitors (1…2000): the barrier is tested only on that many equally spaced dates k·T/m
instead of continuously, and mc_exotic_result carries "monitors" (0 when monitored continuously). A barrier checked
on only m dates is harder to breach, so a discretely monitored knock-out is worth more than the continuous one.
Absent, the barrier is monitored continuously and the exchange is exactly the v7 one.

v7 — mc_exotic {id, market, spec:{kind: "barrier"|"asian", call, K, T, up?, levels?: [...≤ 16], fixings?},
paths ≤ 10M, seed, steps_per_year?, extrapolate?} → mc_exotic_result {id, paths, steps, vanilla, vanilla_se,
vanilla_fine_bias, out[], out_se[], out_fine_bias[], in[], in_se[], arith, arith_se, arith_fine_bias, geo, geo_se,
arith_geo_cov, ms, backend, device}: a continuously monitored barrier (several levels on the same paths) or an
Asian option under the market's local volatility, values per unit of underlying; info reports "exotics": true.

v6 — mc_local_vol {id, market:{S, sigma, r, q?, smile?, smileSpot?, term?}, legs:[{call, K, T, weight}],
paths ≤ 10M, seed, steps_per_year?, extrapolate?} → mc_local_vol_result {id, price, std_error, paths,
steps, fine_bias, ms, backend, device}: the portfolio under the Dupire local volatility of the market's
SSVI surface (the dashboard's Market JSON), log-Euler with optional coupled Richardson extrapolation,
multithreaded on the CPU; info reports "local_vol": true.

v5 — mc_portfolio {id, S, r, q?, legs:[{call, K, T, sigma, weight}], paths ≤ 10M, seed,
antithetic?} → mc_portfolio_result {id, price, std_error, paths, ms, backend, device}: the
whole portfolio on one Brownian path per draw, each leg at its own volatility (weight = signed
quantity × multiplier), multithreaded on the CPU; info reports "portfolio_mc": true.

v4 — each portfolio leg accepts an optional "sigma", so a volatility smile prices
every strike at its own volatility (legs without one use the message's sigma);
info reports "leg_sigma": true.

v3 — every pricing message (subscribe option, update, portfolio, mc) accepts
an optional continuous dividend yield "q" (default 0, so v1/v2 clients are
unaffected); info reports "dividends": true.

v2 — request/response messages, any number per connection, matched by "id":

  ping       {"type":"ping","t_ns":...}
          →  {"type":"pong","t_ns":<echo>}

  info       {"type":"info"}
          →  {"type":"info","protocol":3,"metal":bool,"device":"Apple M3",
              "cpu_threads":8,"dividends":true,"leg_sigma":true,"portfolio_mc":true}

  portfolio  {"type":"portfolio","id":7,"S":...,"sigma":...,"r":...,
              "legs":[{"call":true,"K":755,"T":0.129}, ...]}        (≤ 64 legs)
          →  {"type":"portfolio_result","id":7,
              "legs":[{"price":...,"delta":...,"gamma":...,"theta":...,
                       "vega":...}, ...],
              "calc_us":...}
             Per-share values in request order; the client applies quantities.
             Calls and puts are priced with one batch_bs_full call each.
             Legs with T <= 0 are valued at intrinsic.

  mc         {"type":"mc","id":8,"call":true,"S":...,"K":...,"r":...,
              "sigma":...,"T":...,"paths":1000000,"seed":42}      (≤ 10M paths)
          →  {"type":"mc_result","id":8,"price":...,"std_error":...,
              "paths":...,"ms":...,"backend":"metal"|"cpu-mt","device":"..."}
             Apple Metal GPU (mc_price_gpu) when available, otherwise the
             multithreaded CPU kernel (mc_price_mt).  "ms" is the full
             round-trip of the C++ call, including GPU transfer.

  Errors on v2 messages → {"type":"error","id":<echo>,"msg":"..."}; the
  connection stays open.
"""

import asyncio, json, math, os, sys, time
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

# Locate quantcore .so (built into python/ by CMake)
_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'python')
sys.path.insert(0, os.path.normpath(_PYTHON_DIR))
import quantcore

app = FastAPI()

PROTOCOL_VERSION = 9
MAX_LEGS         = 64
MAX_PATHS        = 10_000_000
MAX_LV_WORK      = 4_000_000_000    # paths × coarse steps for one local-vol run
HAS_METAL        = hasattr(quantcore, "mc_price_gpu")
CPU_THREADS      = os.cpu_count() or 1
# Browser origins allowed to open a socket. Unset (the default, and how it runs locally) accepts
# any origin; a hosted engine sets it so only the deployed terminal can spend its CPU.
ALLOWED_ORIGINS  = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]


def origin_allowed(origin: Optional[str]) -> bool:
    """Browsers always send Origin; other clients (tests, scripts) send none and are allowed."""
    return not ALLOWED_ORIGINS or origin is None or origin in ALLOWED_ORIGINS


@app.get("/healthz")
async def healthz() -> dict:
    """Plain HTTP liveness for container platforms; the pricing itself is the WebSocket at /ws."""
    return {"status": "ok", "protocol": PROTOCOL_VERSION, "metal": HAS_METAL,
            "device": gpu_device(), "cpu_threads": CPU_THREADS}

_gpu_device = None


def gpu_device() -> str:
    global _gpu_device
    if _gpu_device is None:
        try:
            _gpu_device = quantcore.mc_gpu_device_name() if HAS_METAL else ""
        except Exception:
            _gpu_device = ""
    return _gpu_device


# ── v2 helpers ────────────────────────────────────────────────────────────────

def _number(obj: dict, key: str, lo: float = None, hi: float = None,
            lo_open: bool = False) -> float:
    v = obj.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise ValueError(f"{key} must be a number")
    v = float(v)
    if not math.isfinite(v):
        raise ValueError(f"{key} must be finite")
    if lo is not None and (v <= lo if lo_open else v < lo):
        raise ValueError(f"{key} must be {'>' if lo_open else '>='} {lo:g}")
    if hi is not None and v > hi:
        raise ValueError(f"{key} must be <= {hi:g}")
    return v


def _finite(d: dict) -> dict:
    for k, v in d.items():
        if isinstance(v, float) and not math.isfinite(v):
            raise ValueError(f"engine returned a non-finite {k}")
    return d


def price_portfolio(S: float, sigma: float, r: float, q: float, legs: list) -> tuple:
    """Per-share price and Greeks for every leg; returns (results, calc_us)."""
    out = [None] * len(legs)
    t0 = time.perf_counter()
    for is_call in (True, False):
        idx = [i for i, l in enumerate(legs) if l["call"] == is_call and l["T"] > 0]
        if not idx:
            continue
        n = len(idx)
        res = quantcore.batch_bs_full(
            is_call,
            np.full(n, S), np.array([legs[i]["K"] for i in idx], dtype=np.float64),
            np.full(n, r), np.array([legs[i].get("sigma", sigma) for i in idx], dtype=np.float64),
            np.array([legs[i]["T"] for i in idx], dtype=np.float64),
            q=q)
        for j, i in enumerate(idx):
            p, d, g, t, v = (float(x) for x in res[j])
            out[i] = {"price": p, "delta": d, "gamma": g, "theta": t, "vega": v}
    calc_us = (time.perf_counter() - t0) * 1e6
    for i, l in enumerate(legs):
        if out[i] is None:                      # expired leg: intrinsic value
            itm = S > l["K"] if l["call"] else l["K"] > S
            out[i] = {"price": max(S - l["K"], 0.0) if l["call"] else max(l["K"] - S, 0.0),
                      "delta": (1.0 if l["call"] else -1.0) if itm else 0.0,
                      "gamma": 0.0, "theta": 0.0, "vega": 0.0}
        _finite(out[i])
    return out, calc_us


def run_mc(call: bool, S: float, K: float, r: float, sigma: float, T: float,
           paths: int, seed: int, q: float = 0.0) -> dict:
    t_int = 0 if call else 1
    if HAS_METAL:
        try:
            t0 = time.perf_counter()
            res = quantcore.mc_price_gpu(t_int, S, K, r, sigma, T, paths, seed, q)
            ms = (time.perf_counter() - t0) * 1e3
            return {**res, "ms": ms, "backend": "metal", "device": gpu_device()}
        except Exception:
            pass                                # fall through to the CPU kernel
    t0 = time.perf_counter()
    res = quantcore.mc_price_mt(t_int, S, K, r, sigma, T, paths, seed, -1, q)
    ms = (time.perf_counter() - t0) * 1e3
    return {**res, "ms": ms, "backend": "cpu-mt", "device": f"CPU · {CPU_THREADS} threads"}


def run_mc_portfolio(legs: list, S: float, r: float, q: float, paths: int, seed: int,
                     antithetic: bool) -> dict:
    col = lambda key: np.array([float(l[key]) for l in legs], dtype=np.float64)
    is_call = np.array([1.0 if l["call"] else 0.0 for l in legs], dtype=np.float64)
    t0 = time.perf_counter()
    res = quantcore.mc_portfolio_mt(is_call, col("K"), col("T"), col("sigma"), col("weight"),
                                    S, r, q, paths, seed, antithetic, -1)
    ms = (time.perf_counter() - t0) * 1e3
    return {**res, "ms": ms, "backend": "cpu-mt", "device": f"CPU · {CPU_THREADS} threads"}


def _market(raw) -> dict:
    """The dashboard's Market JSON, validated; the bindings build the C++ surface from it."""
    if not isinstance(raw, dict):
        raise ValueError("market must be an object")
    m = {"S": _number(raw, "S", 0, lo_open=True), "sigma": _number(raw, "sigma", 0, 5, lo_open=True),
         "r": _number(raw, "r", -1, 1), "q": _number(raw, "q", -1, 1) if "q" in raw else 0.0}
    smile = raw.get("smile")
    if smile is not None:
        if not isinstance(smile, dict):
            raise ValueError("smile must be an object")
        m["smile"] = {"rho": _number(smile, "rho", -1, 1), "eta": _number(smile, "eta", 0, 10, lo_open=True),
                      "gamma": _number(smile, "gamma", 0, 0.5, lo_open=True)}
    if raw.get("smileSpot") is not None:
        m["smileSpot"] = _number(raw, "smileSpot", 0, lo_open=True)
    term = raw.get("term")
    if term is not None:
        if not isinstance(term, dict) or term.get("kind") not in ("curve", "fitted"):
            raise ValueError("term must be a curve or fitted term structure")
        if term["kind"] == "curve":
            m["term"] = {"kind": "curve", "ratio": _number(term, "ratio", 0, 100, lo_open=True),
                         "halfLife": _number(term, "halfLife", 0, 100, lo_open=True)}
        else:
            T, w = term.get("T"), term.get("w")
            if not isinstance(T, list) or not isinstance(w, list) or not 1 <= len(T) <= 32 or len(T) != len(w):
                raise ValueError("a fitted term structure needs 1 to 32 pillars")
            m["term"] = {"kind": "fitted", "T": [_number({"v": v}, "v", 0, 30, lo_open=True) for v in T],
                         "w": [_number({"v": v}, "v", 0, 100, lo_open=True) for v in w]}
    return m


def run_mc_local_vol(legs: list, market: dict, paths: int, seed: int, steps_per_year: float,
                     extrapolate: bool) -> dict:
    col = lambda key: np.array([float(l[key]) for l in legs], dtype=np.float64)
    is_call = np.array([1.0 if l["call"] else 0.0 for l in legs], dtype=np.float64)
    t0 = time.perf_counter()
    res = quantcore.mc_local_vol(is_call, col("K"), col("T"), col("weight"), market,
                                 paths, seed, steps_per_year, extrapolate, -1)
    ms = (time.perf_counter() - t0) * 1e3
    if not math.isfinite(res["price"]):
        raise ValueError("local-vol inputs are outside the engine's domain (surface, grid or legs)")
    return {**res, "ms": ms, "backend": "cpu-mt", "device": f"CPU · {CPU_THREADS} threads"}


def _exotic(raw) -> dict:
    """An exotic option specification, validated."""
    if not isinstance(raw, dict) or raw.get("kind") not in ("barrier", "asian"):
        raise ValueError("spec.kind must be 'barrier' or 'asian'")
    spec = {"kind": raw["kind"], "call": bool(raw.get("call", True)),
            "K": _number(raw, "K", 0, lo_open=True), "T": _number(raw, "T", 0, 30, lo_open=True)}
    if raw["kind"] == "barrier":
        levels = raw.get("levels")
        if not isinstance(levels, list) or not 1 <= len(levels) <= 16:
            raise ValueError("spec.levels must list 1 to 16 barrier levels")
        spec["up"] = bool(raw.get("up", False))
        spec["levels"] = [_number({"v": v}, "v", 0, lo_open=True) for v in levels]
        # absent monitors the barrier continuously, which is what every client before protocol 8 asked for
        if raw.get("monitors") is not None:
            spec["monitors"] = int(_number(raw, "monitors", 1, 2000))
        # absent or 0 pays no rebate, as every client before protocol 9 expected
        if raw.get("rebate") is not None:
            spec["rebate"] = _number(raw, "rebate", 0, 1e9)
            spec["rebate_at_hit"] = bool(raw.get("rebate_at_hit", True))
    else:
        spec["fixings"] = int(_number(raw, "fixings", 1, 2000))
    return spec


def run_mc_exotic(spec: dict, market: dict, paths: int, seed: int, steps_per_year: float, extrapolate: bool) -> dict:
    t0 = time.perf_counter()
    res = quantcore.mc_exotic(spec, market, paths, seed, steps_per_year, extrapolate, -1)
    ms = (time.perf_counter() - t0) * 1e3
    if res["vanilla"] is None:
        raise ValueError("exotic inputs are outside the engine's domain (surface, grid or specification)")
    return {**res, "ms": ms, "backend": "cpu-mt", "device": f"CPU · {CPU_THREADS} threads"}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    # A hosted engine only serves its own terminal; locally ALLOWED_ORIGINS is unset and this passes.
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=1008)   # policy violation — the handshake never completes
        return
    await ws.accept()
    option_spec = None
    entry_price = None
    position    = 1
    send_lock   = asyncio.Lock()
    tasks       = set()

    async def send(obj: dict):
        async with send_lock:
            await ws.send_text(json.dumps(obj))

    async def handle_mc(msg: dict):
        req_id = msg.get("id")
        try:
            call  = bool(msg.get("call", True))
            S     = _number(msg, "S", 0, lo_open=True)
            K     = _number(msg, "K", 0, lo_open=True)
            r     = _number(msg, "r", -1, 1)
            sigma = _number(msg, "sigma", 0, 5, lo_open=True)
            T     = _number(msg, "T", 0, 30, lo_open=True)
            paths = int(_number(msg, "paths", 1, MAX_PATHS))
            seed  = int(_number(msg, "seed", 0, 2**63 - 1))
            q     = _number(msg, "q", -1, 1) if "q" in msg else 0.0
            res   = _finite(await asyncio.to_thread(run_mc, call, S, K, r, sigma, T, paths, seed, q))
            await send({"type": "mc_result", "id": req_id,
                        "price": float(res["price"]), "std_error": float(res["std_error"]),
                        "paths": int(res["paths"]), "ms": res["ms"],
                        "backend": res["backend"], "device": res["device"]})
        except Exception as exc:
            try:
                await send({"type": "error", "id": req_id, "msg": str(exc)})
            except Exception:
                pass

    async def handle_mc_exotic(msg: dict):
        req_id = msg.get("id")
        try:
            market = _market(msg.get("market"))
            spec = _exotic(msg.get("spec"))
            paths = int(_number(msg, "paths", 2, MAX_PATHS))
            seed  = int(_number(msg, "seed", 0, 2**63 - 1))
            steps_per_year = _number(msg, "steps_per_year", 1, 100_000) if "steps_per_year" in msg else 365.0
            extrapolate = bool(msg.get("extrapolate", True))
            steps = spec["T"] * steps_per_year + spec.get("fixings", 1)
            levels = len(spec.get("levels", []))
            evals = paths * steps * (3 if extrapolate and "smile" in market else 1) * (1 + levels / 4)
            if evals > MAX_LV_WORK:
                raise ValueError("paths × time steps exceed the engine's limit for one exotic run")
            res = await asyncio.to_thread(run_mc_exotic, spec, market, paths, seed, steps_per_year, extrapolate)
            await send({"type": "mc_exotic_result", "id": req_id, **res})
        except Exception as exc:
            try:
                await send({"type": "error", "id": req_id, "msg": str(exc)})
            except Exception:
                pass

    async def handle_mc_local_vol(msg: dict):
        req_id = msg.get("id")
        try:
            market = _market(msg.get("market"))
            paths = int(_number(msg, "paths", 2, MAX_PATHS))
            seed  = int(_number(msg, "seed", 0, 2**63 - 1))
            steps_per_year = _number(msg, "steps_per_year", 1, 100_000) if "steps_per_year" in msg else 365.0
            extrapolate = bool(msg.get("extrapolate", True))
            raw_legs = msg.get("legs")
            if not isinstance(raw_legs, list) or not raw_legs:
                raise ValueError("legs must be a non-empty list")
            if len(raw_legs) > MAX_LEGS:
                raise ValueError(f"at most {MAX_LEGS} legs")
            legs = [{"call": bool(l.get("call", True)),
                     "K": _number(l, "K", 0, lo_open=True),
                     "T": _number(l, "T", None, 30),
                     "weight": _number(l, "weight", -1e9, 1e9)} for l in raw_legs]
            steps = max(0.0, max(l["T"] for l in legs)) * steps_per_year + len(legs)
            evals = paths * steps * (3 if extrapolate and "smile" in market else 1)
            if evals > MAX_LV_WORK:
                raise ValueError("paths × time steps exceed the engine's limit for one local-vol run")
            res = _finite(await asyncio.to_thread(run_mc_local_vol, legs, market, paths, seed, steps_per_year, extrapolate))
            fine_bias = res.get("fine_bias")
            await send({"type": "mc_local_vol_result", "id": req_id,
                        "price": float(res["price"]), "std_error": float(res["std_error"]),
                        "paths": int(res["paths"]), "steps": int(res["steps"]),
                        "fine_bias": None if fine_bias is None else float(fine_bias),
                        "ms": res["ms"], "backend": res["backend"], "device": res["device"]})
        except Exception as exc:
            try:
                await send({"type": "error", "id": req_id, "msg": str(exc)})
            except Exception:
                pass

    async def handle_mc_portfolio(msg: dict):
        req_id = msg.get("id")
        try:
            S     = _number(msg, "S", 0, lo_open=True)
            r     = _number(msg, "r", -1, 1)
            q     = _number(msg, "q", -1, 1) if "q" in msg else 0.0
            paths = int(_number(msg, "paths", 2, MAX_PATHS))
            seed  = int(_number(msg, "seed", 0, 2**63 - 1))
            antithetic = bool(msg.get("antithetic", False))
            raw_legs = msg.get("legs")
            if not isinstance(raw_legs, list) or not raw_legs:
                raise ValueError("legs must be a non-empty list")
            if len(raw_legs) > MAX_LEGS:
                raise ValueError(f"at most {MAX_LEGS} legs")
            legs = [{"call": bool(l.get("call", True)),
                     "K": _number(l, "K", 0, lo_open=True),
                     "T": _number(l, "T", None, 30),
                     "sigma": _number(l, "sigma", 0, 5, lo_open=True),
                     "weight": _number(l, "weight", -1e9, 1e9)} for l in raw_legs]
            res = _finite(await asyncio.to_thread(run_mc_portfolio, legs, S, r, q, paths, seed, antithetic))
            await send({"type": "mc_portfolio_result", "id": req_id,
                        "price": float(res["price"]), "std_error": float(res["std_error"]),
                        "paths": int(res["paths"]), "ms": res["ms"],
                        "backend": res["backend"], "device": res["device"]})
        except Exception as exc:
            try:
                await send({"type": "error", "id": req_id, "msg": str(exc)})
            except Exception:
                pass

    try:
        async for raw in ws.iter_text():
            msg = json.loads(raw)

            # ── subscribe ──────────────────────────────────────────────────
            if msg["type"] == "subscribe":
                opt         = msg["option"]
                option_spec = opt
                position    = int(opt.get("position", 1))
                t_int       = 0 if opt.get("call", True) else 1

                res         = quantcore.bs_full(
                    t_int, opt["S"], opt["K"], opt["r"], opt["sigma"], opt["T"],
                    float(opt.get("q", 0.0)))
                entry_price = res["price"]

                await send({
                    "type":        "subscribed",
                    "entry_price": entry_price,
                    "price":       res["price"],
                    "delta":       res["delta"],
                    "gamma":       res["gamma"],
                    "theta":       res["theta"],
                    "vega":        res["vega"],
                })

            # ── update ─────────────────────────────────────────────────────
            elif msg["type"] == "update" and option_spec is not None:
                t_ns  = msg.get("t_ns", 0)
                S     = float(msg.get("S",     option_spec["S"]))
                sigma = float(msg.get("sigma", option_spec["sigma"]))
                r     = float(msg.get("r",     option_spec["r"]))
                q     = float(msg.get("q",     option_spec.get("q", 0.0)))
                t_int = 0 if option_spec.get("call", True) else 1

                t0    = time.perf_counter()
                # GIL released inside bs_full for the C++ computation
                res   = quantcore.bs_full(
                    t_int, S, option_spec["K"], r, sigma, option_spec["T"], q)
                calc_us = (time.perf_counter() - t0) * 1e6

                pnl = (res["price"] - entry_price) * position * 100

                await send({
                    "type":    "result",
                    "price":   res["price"],
                    "delta":   res["delta"],
                    "gamma":   res["gamma"],
                    "theta":   res["theta"],
                    "vega":    res["vega"],
                    "pnl":     pnl,
                    "t_ns":    t_ns,
                    "calc_us": calc_us,
                })

            # ── v2: ping ───────────────────────────────────────────────────
            elif msg["type"] == "ping":
                await send({"type": "pong", "t_ns": msg.get("t_ns", 0)})

            # ── v2: info ───────────────────────────────────────────────────
            elif msg["type"] == "info":
                await send({"type": "info", "protocol": PROTOCOL_VERSION,
                            "metal": HAS_METAL, "device": gpu_device(),
                            "cpu_threads": CPU_THREADS, "dividends": True, "leg_sigma": True,
                            "portfolio_mc": True, "local_vol": True, "exotics": True})

            # ── v2: portfolio ──────────────────────────────────────────────
            elif msg["type"] == "portfolio":
                req_id = msg.get("id")
                try:
                    S     = _number(msg, "S", 0, lo_open=True)
                    sigma = _number(msg, "sigma", 0, 5, lo_open=True)
                    r     = _number(msg, "r", -1, 1)
                    q     = _number(msg, "q", -1, 1) if "q" in msg else 0.0
                    raw_legs = msg.get("legs")
                    if not isinstance(raw_legs, list) or not raw_legs:
                        raise ValueError("legs must be a non-empty list")
                    if len(raw_legs) > MAX_LEGS:
                        raise ValueError(f"at most {MAX_LEGS} legs")
                    # v4: an optional per-leg "sigma" (a volatility smile) overrides the portfolio sigma
                    legs = [{"call": bool(l.get("call", True)),
                             "K": _number(l, "K", 0, lo_open=True),
                             "T": _number(l, "T", None, 30),
                             **({"sigma": _number(l, "sigma", 0, 5, lo_open=True)} if "sigma" in l else {})}
                            for l in raw_legs]
                    results, calc_us = price_portfolio(S, sigma, r, q, legs)
                    await send({"type": "portfolio_result", "id": req_id,
                                "legs": results, "calc_us": calc_us})
                except Exception as exc:
                    await send({"type": "error", "id": req_id, "msg": str(exc)})

            # ── v2: Monte Carlo (off the event loop) ───────────────────────
            elif msg["type"] == "mc":
                task = asyncio.create_task(handle_mc(msg))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

            # ── v5: portfolio Monte Carlo (off the event loop) ─────────────
            elif msg["type"] == "mc_portfolio":
                task = asyncio.create_task(handle_mc_portfolio(msg))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

            # ── v6: local-volatility Monte Carlo (off the event loop) ───────
            elif msg["type"] == "mc_local_vol":
                task = asyncio.create_task(handle_mc_local_vol(msg))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

            # ── v7: exotics under local volatility (off the event loop) ─────
            elif msg["type"] == "mc_exotic":
                task = asyncio.create_task(handle_mc_exotic(msg))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        # Surface errors during development; suppress in prod
        try:
            await send({"type": "error", "msg": str(exc)})
        except Exception:
            pass


if __name__ == "__main__":
    # Locally: `python3 server/ws_server.py [port]` on loopback. In a container the platform supplies
    # PORT and HOST=0.0.0.0 binds every interface (deploy/engine.Dockerfile).
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8765))
    host = os.environ.get("HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port, log_level="warning")
