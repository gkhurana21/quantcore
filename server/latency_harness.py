#!/usr/bin/env python3
"""
QuantCore Phase 4 — End-to-end latency gate
=============================================
Starts the WebSocket server as a subprocess, drives it with realistic
input-change streams, measures end-to-end latency, then shuts down.

Test conditions (stated explicitly)
------------------------------------
  Network    : localhost (127.0.0.1 loopback) — no network RTT
  Protocol   : WebSocket over TCP
  Workload   : sequential request-response per client (send update,
               await result, repeat) — isolates per-update latency
  Inputs     : spot + vol drawn from a fixed-seed RNG (realistic noise,
               each update forces a genuine C++ recalculation)
  Concurrency: tested at 1 client (baseline) and 5 clients (concurrent)
  Metric     : t_client_recv_ns − t_send_ns  (nanosecond perf_counter)

What "sub-200ms" is claimed against
-------------------------------------
  The claim targets p99.  We report median / p95 / p99 / max.
  If p99 >= 200ms the claim scope is narrowed to whatever percentile holds.
"""

import asyncio, json, os, subprocess, sys, time, statistics

import numpy as np
import websockets

PYTHON   = sys.executable
SERVER   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ws_server.py")
PORT     = 8767          # dedicated harness port; avoids clashes with dev server
URL      = f"ws://127.0.0.1:{PORT}/ws"

OPTION   = {
    "S": 756.48, "K": 755.0, "r": 0.045,
    "sigma": 0.138, "T": 0.129, "call": True, "position": 10,
}

N_UPDATES_SINGLE     = 500    # updates for 1-client baseline
N_UPDATES_CONCURRENT = 300    # updates per client for 5-client test
INTER_UPDATE_S       = 0.010  # 10 ms between updates → 100/sec per client

_RNG = np.random.default_rng(seed=0)

# Pre-generate all inputs so RNG overhead is outside the timed loop
_SPOTS  = OPTION["S"] + _RNG.normal(0, 0.50, 3000)
_SIGMAS = np.clip(OPTION["sigma"] + _RNG.normal(0, 0.003, 3000), 0.05, 1.0)


# ── client ────────────────────────────────────────────────────────────────────

async def run_client(client_id: int, n_updates: int, inter: float) -> list:
    latencies = []
    jitter    = client_id * 0.025          # stagger startup slightly
    await asyncio.sleep(jitter)

    async with websockets.connect(URL, open_timeout=10) as ws:
        # Subscribe
        await ws.send(json.dumps({"type": "subscribe", "option": OPTION}))
        sub = json.loads(await ws.recv())
        assert sub["type"] == "subscribed", f"unexpected: {sub}"

        offset = client_id * n_updates     # index into pre-generated inputs
        for i in range(n_updates):
            idx = (offset + i) % len(_SPOTS)
            payload = json.dumps({
                "type":  "update",
                "S":     round(float(_SPOTS[idx]),  4),
                "sigma": round(float(_SIGMAS[idx]), 6),
                "t_ns":  time.perf_counter_ns(),
            })
            await ws.send(payload)
            raw      = await ws.recv()
            t_recv   = time.perf_counter_ns()
            result   = json.loads(raw)
            lat_ms   = (t_recv - result["t_ns"]) / 1e6
            latencies.append(lat_ms)

            if inter > 0 and i < n_updates - 1:
                await asyncio.sleep(inter)

    return latencies


# ── stats ─────────────────────────────────────────────────────────────────────

def report(latencies: list, label: str):
    s = sorted(latencies)
    n = len(s)
    p = lambda q: s[min(int(q * n), n - 1)]
    print(f"  {label}  ({n} measurements, {INTER_UPDATE_S*1000:.0f} ms between updates)")
    print(f"    mean   : {statistics.mean(s):7.3f} ms")
    print(f"    median : {statistics.median(s):7.3f} ms")
    print(f"    p95    : {p(0.95):7.3f} ms")
    print(f"    p99    : {p(0.99):7.3f} ms")
    print(f"    max    : {s[-1]:7.3f} ms")
    p99 = p(0.99)
    if p99 < 200:
        print(f"    sub-200ms at p99? YES  (margin {200-p99:.1f} ms)")
    else:
        print(f"    sub-200ms at p99? NO   (p99 = {p99:.1f} ms — scope the claim accordingly)")
    print()


# ── main ──────────────────────────────────────────────────────────────────────

async def main():
    # Start server subprocess
    proc = subprocess.Popen(
        [PYTHON, SERVER, str(PORT)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    # Wait for server ready (up to 8 s)
    print("  starting server ...", end=" ", flush=True)
    ready = False
    for _ in range(80):
        await asyncio.sleep(0.1)
        try:
            async with websockets.connect(URL, open_timeout=0.5):
                pass
            ready = True
            break
        except Exception:
            continue
    if not ready:
        proc.kill()
        sys.exit("ERROR: server did not start within 8 s")
    print("ready\n")

    try:
        # ── Test 1: 1 client baseline ─────────────────────────────────────
        print(f"  Test 1 — 1 client, {N_UPDATES_SINGLE} updates, "
              f"{1/INTER_UPDATE_S:.0f} updates/sec")
        lats1 = await asyncio.gather(
            run_client(0, N_UPDATES_SINGLE, INTER_UPDATE_S)
        )
        report(lats1[0], "1 client")

        # ── Test 2: 5 concurrent clients ──────────────────────────────────
        n_cli = 5
        print(f"  Test 2 — {n_cli} concurrent clients, "
              f"{N_UPDATES_CONCURRENT} updates each, "
              f"{1/INTER_UPDATE_S:.0f} updates/sec each "
              f"({n_cli * 1/INTER_UPDATE_S:.0f} total/sec)")
        lats5_list = await asyncio.gather(
            *[run_client(i, N_UPDATES_CONCURRENT, INTER_UPDATE_S)
              for i in range(n_cli)]
        )
        all5 = [l for sub in lats5_list for l in sub]
        for i, sub in enumerate(lats5_list):
            report(sub, f"  client {i}")
        report(all5, f"5 clients combined")

    finally:
        proc.terminate()
        proc.wait()


if __name__ == "__main__":
    print("QuantCore Phase 4 — Latency gate")
    print(f"Server    : FastAPI + uvicorn, localhost:{PORT}")
    print(f"Engine    : C++ bs_full via pybind11 (GIL released during compute)")
    print(f"Condition : sequential request-response, "
          f"real spot+vol noise (seed=0, fixed)\n")
    asyncio.run(main())
