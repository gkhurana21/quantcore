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
        check("info (protocol 8, dividends, per-leg sigma, portfolio MC, local vol, exotics)",
              info.get("protocol") == 8 and info.get("dividends") is True and info.get("leg_sigma") is True
              and info.get("portfolio_mc") is True and info.get("local_vol") is True and info.get("exotics") is True,
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

        # v4 per-leg volatility (a smile): legs with "sigma" use it, legs without use the message sigma
        smile_legs = [{"call": False, "K": 700.0, "T": 0.129, "sigma": 0.19},
                      {"call": True, "K": 800.0, "T": 0.129, "sigma": 0.11},
                      {"call": True, "K": 760.0, "T": 0.5}]
        prs = await rpc(ws, {"type": "portfolio", "id": 13, "S": 756.48, "sigma": 0.138, "r": 0.045, "q": 0.01,
                             "legs": smile_legs}, "portfolio_result")
        if prs["type"] == "portfolio_result":
            worst_s = 0.0
            for l, got in zip(smile_legs, prs["legs"]):
                want = quantcore.bs_full(0 if l["call"] else 1, 756.48, l["K"], 0.045, l.get("sigma", 0.138), l["T"], 0.01)
                worst_s = max(worst_s, max(abs(got[k] - want[k]) for k in ("price", "delta", "gamma", "theta", "vega")))
            check("portfolio per-leg sigma == bs_full(leg sigma)", worst_s < 1e-9, f"max |diff| {worst_s:.2e}")
        else:
            check("portfolio per-leg sigma", False, prs.get("msg", ""))
        bad_sigma = await rpc(ws, {"type": "portfolio", "id": 14, "S": 100.0, "sigma": 0.2, "r": 0.01,
                                   "legs": [{"call": True, "K": 100.0, "T": 1.0, "sigma": -0.3}]}, "portfolio_result")
        check("invalid per-leg sigma → error with id", bad_sigma["type"] == "error" and bad_sigma.get("id") == 14,
              bad_sigma.get("msg", ""))

        # v5 portfolio Monte Carlo: every leg on one Brownian path, each at its own volatility
        pf_legs = [{"call": False, "K": 715.0, "T": 0.129, "sigma": 0.181, "weight": 1000.0},
                   {"call": False, "K": 735.0, "T": 0.129, "sigma": 0.162, "weight": -1000.0},
                   {"call": True, "K": 775.0, "T": 0.129, "sigma": 0.125, "weight": -1000.0},
                   {"call": True, "K": 795.0, "T": 0.129, "sigma": 0.109, "weight": 1000.0},
                   {"call": True, "K": 760.0, "T": 0.5, "sigma": 0.14, "weight": 500.0}]
        bs_pf = sum(l["weight"] * quantcore.bs_full(0 if l["call"] else 1, 756.48, l["K"], 0.045, l["sigma"],
                                                    l["T"], 0.01)["price"] for l in pf_legs)
        mcp = await rpc(ws, {"type": "mc_portfolio", "id": 15, "S": 756.48, "r": 0.045, "q": 0.01,
                             "legs": pf_legs, "paths": 2_000_000, "seed": 11}, "mc_portfolio_result")
        if mcp["type"] == "mc_portfolio_result":
            zp = abs(mcp["price"] - bs_pf) / mcp["std_error"]
            check("mc_portfolio within 3 SE of the Black-Scholes sum of legs", zp < 3,
                  f"{mcp['price']:.2f} ± {mcp['std_error']:.2f} vs {bs_pf:.2f}, |z| {zp:.2f}, "
                  f"{mcp['ms']:.0f} ms, {mcp['device']}")
            check("mc_portfolio id echo + paths", mcp.get("id") == 15 and mcp.get("paths") == 2_000_000)
        else:
            check("mc_portfolio", False, mcp.get("msg", ""))
        bad_pf = await rpc(ws, {"type": "mc_portfolio", "id": 16, "S": 100.0, "r": 0.01, "paths": 1000, "seed": 1,
                                "legs": [{"call": True, "K": 100.0, "T": 1.0, "sigma": 0.2}]}, "mc_portfolio_result")
        check("mc_portfolio leg without weight → error with id", bad_pf["type"] == "error" and bad_pf.get("id") == 16,
              bad_pf.get("msg", ""))

        # v6 local volatility: the portfolio under the Dupire local vol of the market's SSVI surface
        lv_market = {"S": 756.48, "sigma": 0.138, "r": 0.045, "q": 0.01,
                     "smile": {"rho": -0.7, "eta": 1.0, "gamma": 0.45},
                     "term": {"kind": "curve", "ratio": 0.5, "halfLife": 0.15}}
        lv_legs = [{"call": False, "K": 715.0, "T": 0.129, "weight": 1000.0},
                   {"call": False, "K": 735.0, "T": 0.129, "weight": -1000.0},
                   {"call": True, "K": 775.0, "T": 0.129, "weight": -1000.0},
                   {"call": True, "K": 795.0, "T": 0.129, "weight": 1000.0},
                   {"call": True, "K": 760.0, "T": 0.5, "weight": 500.0}]
        bs_lv = sum(l["weight"] * quantcore.bs_full(0 if l["call"] else 1, 756.48, l["K"], 0.045,
                                                    quantcore.implied_vol(lv_market, l["K"], l["T"]), l["T"], 0.01)["price"]
                    for l in lv_legs)
        lvr = await rpc(ws, {"type": "mc_local_vol", "id": 17, "market": lv_market, "legs": lv_legs,
                             "paths": 1_000_000, "seed": 5, "steps_per_year": 365, "extrapolate": True},
                        "mc_local_vol_result")
        if lvr["type"] == "mc_local_vol_result":
            zl = abs(lvr["price"] - bs_lv) / lvr["std_error"]
            check("mc_local_vol (Richardson) within 3 SE of the surface's Black-Scholes value", zl < 3,
                  f"{lvr['price']:.2f} ± {lvr['std_error']:.2f} vs {bs_lv:.2f}, |z| {zl:.2f}, {lvr['steps']} steps, "
                  f"fine-grid bias {lvr['fine_bias']:+.2f}, {lvr['ms']:.0f} ms, {lvr['device']}")
            col = lambda k: [float(l[k]) for l in lv_legs]
            direct = quantcore.mc_local_vol([1.0 if l["call"] else 0.0 for l in lv_legs], col("K"), col("T"), col("weight"),
                                            lv_market, 1_000_000, 5, 365.0, True, -1)
            check("mc_local_vol id echo, paths, and the wire result equals the bindings",
                  lvr.get("id") == 17 and lvr.get("paths") == 1_000_000 and lvr["price"] == direct["price"]
                  and lvr["fine_bias"] == direct["fine_bias"])
        else:
            check("mc_local_vol", False, lvr.get("msg", ""))
        bad_lv = await rpc(ws, {"type": "mc_local_vol", "id": 18, "paths": 1000, "seed": 1, "legs": lv_legs,
                                "market": {**lv_market, "smile": {"rho": -0.7, "eta": -1.0, "gamma": 0.45}}},
                           "mc_local_vol_result")
        check("mc_local_vol with an invalid smile → error with id", bad_lv["type"] == "error" and bad_lv.get("id") == 18,
              bad_lv.get("msg", ""))

        # v7 exotics: barrier levels under flat volatility against the closed forms, and the wire result equals the bindings
        flat_m = {"S": 100.0, "sigma": 0.25, "r": 0.08, "q": 0.04}
        spec = {"kind": "barrier", "call": True, "K": 100.0, "T": 0.5, "up": False, "levels": [85.0, 92.0, 97.0]}
        exr = await rpc(ws, {"type": "mc_exotic", "id": 19, "market": flat_m, "spec": spec, "paths": 1_000_000,
                             "seed": 3, "steps_per_year": 2, "extrapolate": True}, "mc_exotic_result")
        if exr["type"] == "mc_exotic_result":
            cf = [quantcore.barrier_prices(True, False, 100.0, 100.0, h, 0.5, 0.25, 0.08, 0.04) for h in spec["levels"]]
            zs = [abs(exr["out"][j] - cf[j]["out"]) / exr["out_se"][j] for j in range(3)] + \
                 [abs(exr["in"][j] - cf[j]["in"]) / exr["in_se"][j] for j in range(3)]
            check("mc_exotic barrier levels within 4 SE of the closed forms (knock-out and knock-in)", max(zs) < 4,
                  f"worst |z| {max(zs):.2f}, out {[round(v, 4) for v in exr['out']]} vs {[round(c['out'], 4) for c in cf]}, "
                  f"{exr['ms']:.0f} ms")
            direct = quantcore.mc_exotic(spec, flat_m, 1_000_000, 3, 2.0, True, -1)
            check("mc_exotic id echo, and the wire result equals the bindings",
                  exr.get("id") == 19 and exr["out"] == direct["out"] and exr["in"] == direct["in"] and exr["paths"] == 1_000_000)
        else:
            check("mc_exotic", False, exr.get("msg", ""))
        asian = {"kind": "asian", "call": True, "K": 756.0, "T": 0.25, "fixings": 13}
        asr = await rpc(ws, {"type": "mc_exotic", "id": 20, "market": lv_market, "spec": asian, "paths": 200_000,
                             "seed": 4, "steps_per_year": 365, "extrapolate": True}, "mc_exotic_result")
        if asr["type"] == "mc_exotic_result":
            van = quantcore.bs_full(0, 756.48, 756.0, 0.045, quantcore.implied_vol(lv_market, 756.0, 0.25), 0.25, 0.01)["price"]
            zv = abs(asr["vanilla"] - van) / asr["vanilla_se"]
            check("mc_exotic Asian under local vol: arithmetic ≥ geometric, vanilla on the same paths within 4 SE",
                  asr["arith"] >= asr["geo"] and zv < 4,
                  f"arith {asr['arith']:.4f} geo {asr['geo']:.4f} vanilla {asr['vanilla']:.4f} vs {van:.4f} (|z| {zv:.2f}), "
                  f"{asr['steps']} steps, {asr['ms']:.0f} ms")
        else:
            check("mc_exotic asian", False, asr.get("msg", ""))
        bad_ex = await rpc(ws, {"type": "mc_exotic", "id": 21, "market": flat_m, "paths": 1000, "seed": 1,
                                "spec": {**spec, "levels": []}}, "mc_exotic_result")
        check("mc_exotic without barrier levels → error with id", bad_ex["type"] == "error" and bad_ex.get("id") == 21,
              bad_ex.get("msg", ""))

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
