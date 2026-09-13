#!/usr/bin/env python3
"""
Protocol check for server/ws_server.py
======================================
Starts the server on a scratch port and exercises every message type:
v1 subscribe/update (unchanged contract) and v2 ping, info, portfolio, mc,
plus error handling. Engine results are compared with direct calls into the
quantcore bindings, so this verifies the wire layer, not the maths twice.

    python3 server/protocol_check.py
"""

import asyncio, json, math, os, subprocess, sys, time

import websockets

HERE   = os.path.dirname(os.path.abspath(__file__))
PORT   = 8771
URL    = f"ws://127.0.0.1:{PORT}/ws"
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "python")))
import quantcore

FAILS = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")
    if not ok:
        FAILS.append(name)


async def rpc(ws, msg, want):
    await ws.send(json.dumps(msg))
    while True:
        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
        if reply["type"] in (want, "error"):
            return reply


async def main():
    async with websockets.connect(URL, open_timeout=10) as ws:
        # v1
        opt = {"S": 756.48, "K": 755.0, "r": 0.045, "sigma": 0.138, "T": 0.129, "call": True, "position": 10}
        sub = await rpc(ws, {"type": "subscribe", "option": opt}, "subscribed")
        ref = quantcore.bs_full(0, 756.48, 755.0, 0.045, 0.138, 0.129)
        check("v1 subscribe price", sub["price"] == ref["price"], f"{sub['price']:.6f}")
        res = await rpc(ws, {"type": "update", "S": 771.0, "sigma": 0.138, "t_ns": 123}, "result")
        ref2 = quantcore.bs_full(0, 771.0, 755.0, 0.045, 0.138, 0.129)
        check("v1 update price + t_ns echo", res["price"] == ref2["price"] and res["t_ns"] == 123,
              f"{res['price']:.4f}, calc_us={res['calc_us']:.1f}")
        check("v1 update pnl", abs(res["pnl"] - (ref2["price"] - ref["price"]) * 1000) < 1e-9)

        # v2 ping / info
        pong = await rpc(ws, {"type": "ping", "t_ns": 987654321}, "pong")
        check("ping → pong echo", pong.get("t_ns") == 987654321)
        info = await rpc(ws, {"type": "info"}, "info")
        check("info (protocol 3, dividends)", info.get("protocol") == 3 and info.get("dividends") is True,
              json.dumps(info))

        # v2 portfolio (mixed calls/puts, one expired leg)
        legs = [{"call": False, "K": 715, "T": 0.129}, {"call": False, "K": 735, "T": 0.129},
                {"call": True, "K": 775, "T": 0.129}, {"call": True, "K": 795, "T": 0.25},
                {"call": True, "K": 700, "T": 0}]
        pr = await rpc(ws, {"type": "portfolio", "id": 7, "S": 760.0, "sigma": 0.2, "r": 0.04, "legs": legs},
                       "portfolio_result")
        check("portfolio id echo + leg count", pr.get("id") == 7 and len(pr.get("legs", [])) == len(legs))
        worst = 0.0
        for l, got in zip(legs[:4], pr["legs"][:4]):
            want = quantcore.bs_full(0 if l["call"] else 1, 760.0, l["K"], 0.04, 0.2, l["T"])
            worst = max(worst, *(abs(got[k] - want[k]) for k in ("price", "delta", "gamma", "theta", "vega")))
        check("portfolio batch_bs_full == bs_full (all Greeks)", worst < 1e-9, f"max |diff| {worst:.2e}")
        check("portfolio expired leg = intrinsic", pr["legs"][4]["price"] == 60.0 and pr["legs"][4]["delta"] == 1.0)

        # v2 mc, with a ping answered while it runs
        await ws.send(json.dumps({"type": "mc", "id": 8, "call": True, "S": 756.48, "K": 755, "r": 0.045,
                                  "sigma": 0.138, "T": 0.129, "paths": 1_000_000, "seed": 42}))
        await ws.send(json.dumps({"type": "ping", "t_ns": 1}))
        got_mc = None
        order = []
        while got_mc is None:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
            order.append(m["type"])
            if m["type"] in ("mc_result", "error"):
                got_mc = m
        if got_mc["type"] == "error":
            check("mc result", False, got_mc["msg"])
        else:
            z = abs(got_mc["price"] - ref["price"]) / got_mc["std_error"]
            check("mc within 3 SE of Black-Scholes", z < 3,
                  f"price {got_mc['price']:.4f} ± {got_mc['std_error']:.4f}, |z| {z:.2f}, "
                  f"{got_mc['ms']:.1f} ms, {got_mc['backend']} ({got_mc['device']})")
            check("mc id echo + paths", got_mc["id"] == 8 and got_mc["paths"] == 1_000_000)
        check("ping answered while mc runs", "pong" in order, f"order {order}")

        # v3 dividend yield: stream update, portfolio and Monte Carlo
        upd_q = await rpc(ws, {"type": "update", "S": 771.0, "sigma": 0.138, "q": 0.02, "t_ns": 456}, "result")
        ref_q = quantcore.bs_full(0, 771.0, 755.0, 0.045, 0.138, 0.129, 0.02)
        check("update with q == bs_full(q)", upd_q["price"] == ref_q["price"], f"{upd_q['price']:.4f}")
        hull = [{"call": True, "K": 900, "T": 2 / 12}, {"call": False, "K": 900, "T": 2 / 12}]
        prq = await rpc(ws, {"type": "portfolio", "id": 11, "S": 930.0, "sigma": 0.2, "r": 0.08, "q": 0.03,
                             "legs": hull}, "portfolio_result")
        want_c = quantcore.bs_full(0, 930.0, 900.0, 0.08, 0.2, 2 / 12, 0.03)
        got_c = prq["legs"][0]["price"] if prq["type"] == "portfolio_result" else float("nan")
        check("portfolio with q: Hull index call 51.83, == bs_full(q)",
              abs(got_c - want_c["price"]) < 1e-12 and abs(got_c - 51.83) < 0.01, f"{got_c:.4f}")
        mcq = await rpc(ws, {"type": "mc", "id": 12, "call": True, "S": 930.0, "K": 900.0, "r": 0.08, "q": 0.03,
                             "sigma": 0.2, "T": 2 / 12, "paths": 1_000_000, "seed": 7}, "mc_result")
        if mcq["type"] == "mc_result":
            zq = abs(mcq["price"] - want_c["price"]) / mcq["std_error"]
            check("mc with q within 3 SE of bs_full(q)", zq < 3,
                  f"{mcq['price']:.4f} ± {mcq['std_error']:.4f}, |z| {zq:.2f}, {mcq['backend']}")
        else:
            check("mc with q", False, mcq.get("msg", ""))

        # errors keep the connection open
        err = await rpc(ws, {"type": "portfolio", "id": 9, "S": -1, "sigma": 0.2, "r": 0.04, "legs": legs}, "portfolio_result")
        check("invalid portfolio → error with id", err["type"] == "error" and err.get("id") == 9, err.get("msg", ""))
        err2 = await rpc(ws, {"type": "mc", "id": 10, "call": True, "S": 100, "K": 100, "r": 0.01,
                              "sigma": 0.2, "T": 1, "paths": 50_000_000, "seed": 1}, "mc_result")
        check("mc path cap → error", err2["type"] == "error" and err2.get("id") == 10, err2.get("msg", ""))
        pong2 = await rpc(ws, {"type": "ping", "t_ns": 5}, "pong")
        check("connection still usable after errors", pong2.get("t_ns") == 5)


if __name__ == "__main__":
    proc = subprocess.Popen([sys.executable, os.path.join(HERE, "ws_server.py"), str(PORT)])
    try:
        for _ in range(100):
            try:
                import socket
                with socket.create_connection(("127.0.0.1", PORT), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        asyncio.run(main())
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    print(f"\n{'ALL PASS' if not FAILS else 'FAILURES: ' + ', '.join(FAILS)}")
    sys.exit(1 if FAILS else 0)
