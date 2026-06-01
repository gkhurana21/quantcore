#!/usr/bin/env python3
"""
QuantCore Phase 4 — WebSocket streaming server
================================================
FastAPI + uvicorn.  Dispatches pricing/Greeks/P&L recalculation to the
C++ engine through the existing pybind11 bindings.

GIL note
--------
py::gil_scoped_release wraps the C++ compute inside bs_full and mc_price
(see bindings/quantcore_py.cpp).  That means any thread calling into the
C++ pricing core releases Python's GIL for the duration of the computation,
allowing other handlers to run concurrently without serialising.  For the
asyncio event loop (single-threaded) this matters when the compute is
offloaded to a thread pool via run_in_executor; for inline async calls it
allows any other thread (e.g. uvicorn worker) to proceed unblocked.

Wire protocol
-------------
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
"""

import sys, os, json, time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

# Locate quantcore .so (built into python/ by CMake)
_PYTHON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'python')
sys.path.insert(0, os.path.normpath(_PYTHON_DIR))
import quantcore

app = FastAPI()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    option_spec = None
    entry_price = None
    position    = 1

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
                    t_int, opt["S"], opt["K"], opt["r"], opt["sigma"], opt["T"])
                entry_price = res["price"]

                await ws.send_text(json.dumps({
                    "type":        "subscribed",
                    "entry_price": entry_price,
                    "price":       res["price"],
                    "delta":       res["delta"],
                    "gamma":       res["gamma"],
                    "theta":       res["theta"],
                    "vega":        res["vega"],
                }))

            # ── update ─────────────────────────────────────────────────────
            elif msg["type"] == "update" and option_spec is not None:
                t_ns  = msg.get("t_ns", 0)
                S     = float(msg.get("S",     option_spec["S"]))
                sigma = float(msg.get("sigma", option_spec["sigma"]))
                r     = float(msg.get("r",     option_spec["r"]))
                t_int = 0 if option_spec.get("call", True) else 1

                t0    = time.perf_counter()
                # GIL released inside bs_full for the C++ computation
                res   = quantcore.bs_full(
                    t_int, S, option_spec["K"], r, sigma, option_spec["T"])
                calc_us = (time.perf_counter() - t0) * 1e6

                pnl = (res["price"] - entry_price) * position * 100

                await ws.send_text(json.dumps({
                    "type":    "result",
                    "price":   res["price"],
                    "delta":   res["delta"],
                    "gamma":   res["gamma"],
                    "theta":   res["theta"],
                    "vega":    res["vega"],
                    "pnl":     pnl,
                    "t_ns":    t_ns,
                    "calc_us": calc_us,
                }))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        # Surface errors during development; suppress in prod
        try:
            await ws.send_text(json.dumps({"type": "error", "msg": str(exc)}))
        except Exception:
            pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
