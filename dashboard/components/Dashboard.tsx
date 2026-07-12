'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── constants ──────────────────────────────────────────────────────────────

const WS_URL   = 'ws://localhost:8765/ws';
const BASE_OPT = { S: 756.48, K: 755.0, r: 0.045, sigma: 0.138, T: 0.129,
                   call: true, position: 10 };

const SPOT_SHOCKS = [-0.10, -0.05, 0, +0.05, +0.10];
const VOL_SHOCKS  = [-0.50, -0.25, 0, +0.25, +0.50];

// Verified benchmarks (see README) — the real engineering story behind the demo.
const BENCH = [
  { k: 'GPU Monte Carlo', v: '69×',    s: 'vs vectorized NumPy · 10M paths' },
  { k: 'Stream latency',  v: '4.4 ms', s: 'p99 end-to-end · WebSocket' },
  { k: 'VaR calibration', v: '4.5%',   s: 'breach rate vs 5% · 851 days' },
  { k: 'Pricing error',   v: '<0.01%', s: 'vs live market mid' },
];

// One-click scenarios: [spot, vol, rate]
const PRESETS: { name: string; S: number; sigma: number; r: number }[] = [
  { name: 'Reset',     S: 756.48, sigma: 0.138, r: 0.045 },
  { name: 'Rally',     S: 800.0,  sigma: 0.110, r: 0.045 },
  { name: 'Sell-off',  S: 710.0,  sigma: 0.270, r: 0.045 },
  { name: 'Vol spike', S: 756.48, sigma: 0.360, r: 0.045 },
];

const CLAMP = {
  S:     [680, 830]   as const,
  sigma: [0.05, 0.50] as const,
  r:     [0.00, 0.10] as const,
};

// ── types ──────────────────────────────────────────────────────────────────

interface Snapshot {
  price: number; delta: number; gamma: number;
  theta: number; vega: number;  pnl:   number;
  calcUs: number;
}

// ── Black-Scholes (in-browser; mirrors the C++ engine's math) ────────────────
// Drives the hosted demo and the payoff chart when the native backend isn't up.

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-x * x / 2);
}
function bsPrice(S: number, sigma: number, r: number): number {
  const { K, T, call } = BASE_OPT;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  return call ? S * normCdf(d1) - K * disc * normCdf(d2)
              : K * disc * normCdf(-d2) - S * normCdf(-d1);
}
function priceGreeks(S: number, sigma: number, r: number): Omit<Snapshot, 'pnl'> {
  const t0 = performance.now();
  const { K, T, call } = BASE_OPT;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2), pdf = normPdf(d1);
  const price = call ? S * Nd1 - K * disc * Nd2
                     : K * disc * normCdf(-d2) - S * normCdf(-d1);
  const delta = call ? Nd1 : Nd1 - 1;
  const gamma = pdf / (S * sigma * sqrtT);
  const theta = -(S * pdf * sigma) / (2 * sqrtT)
                - (call ? r * K * disc * Nd2 : -r * K * disc * normCdf(-d2));
  const vega  = S * pdf * sqrtT;
  const calcUs = (performance.now() - t0) * 1000;
  return { price, delta, gamma, theta, vega, calcUs };
}

// ── payoff / value chart ─────────────────────────────────────────────────────

function PayoffChart({ spot, sigma, rate }: { spot: number; sigma: number; rate: number }) {
  const { K } = BASE_OPT;
  const W = 680, H = 320, padL = 42, padR = 16, padT = 18, padB = 28;
  const xMin = 660, xMax = 860, N = 90;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverS, setHoverS] = useState<number | null>(null);

  let yMax = 1;
  const value: [number, number][] = [];
  const payoff: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const S = xMin + (xMax - xMin) * (i / N);
    const v = bsPrice(S, sigma, rate);
    const intr = Math.max(S - K, 0);
    value.push([S, v]); payoff.push([S, intr]);
    yMax = Math.max(yMax, v, intr);
  }
  // nice rounded y-axis top
  const rawStep = (yMax * 1.08) / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const nn = rawStep / pow;
  const niceStep = (nn < 1.5 ? 1 : nn < 3 ? 2 : nn < 7 ? 5 : 10) * pow;
  const yTop = Math.ceil((yMax * 1.08) / niceStep) * niceStep;

  const x = (S: number) => padL + ((S - xMin) / (xMax - xMin)) * (W - padL - padR);
  const y = (v: number) => H - padB - (v / yTop) * (H - padT - padB);
  const toPath = (pts: [number, number][]) =>
    pts.map(([S, v], i) => `${i ? 'L' : 'M'}${x(S).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  const valuePath  = toPath(value);
  const payoffPath = toPath(payoff);
  const fillPath   = `${valuePath} L${x(xMax).toFixed(1)},${y(0).toFixed(1)} L${x(xMin).toFixed(1)},${y(0).toFixed(1)} Z`;

  const spotC = Math.max(xMin, Math.min(xMax, spot));
  const spotVal = bsPrice(spotC, sigma, rate);
  const cx = x(spotC), cy = y(spotVal);

  const be = K + spotVal;                    // long-call breakeven at expiry
  const beIn = be >= xMin && be <= xMax;

  const yTicks: number[] = [];
  for (let t = 0; t <= yTop + 1e-9; t += niceStep) yTicks.push(t);
  const xticks = [680, 720, 760, 800, 840];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    let S = xMin + ((vbX - padL) / (W - padL - padR)) * (xMax - xMin);
    S = Math.max(xMin, Math.min(xMax, S));
    setHoverS(S);
  };
  const hv = hoverS != null ? bsPrice(hoverS, sigma, rate) : null;
  const hx = hoverS != null ? x(hoverS) : 0;
  const hy = hv != null ? y(hv) : 0;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
         preserveAspectRatio="xMidYMid meet"
         onPointerMove={onMove} onPointerLeave={() => setHoverS(null)}
         aria-label={`Option value curve. Spot ${spot.toFixed(0)}, option worth ${spotVal.toFixed(2)} dollars per share. Strike ${K}. Breakeven at expiry ${be.toFixed(0)}.`}
         style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}>
      <defs>
        <linearGradient id="valFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"  stopColor="rgba(201,168,106,0.28)" />
          <stop offset="100%" stopColor="rgba(201,168,106,0)" />
        </linearGradient>
      </defs>

      {/* y gridlines + labels */}
      {yTicks.map(t => (
        <g key={t}>
          <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="rgba(201,168,106,0.08)" strokeWidth="1" />
          <text x={padL - 6} y={y(t) + 3} fill="var(--muted-2)" fontSize="9" textAnchor="end"
                fontFamily="var(--mono)">${t.toFixed(0)}</text>
        </g>
      ))}

      {/* x ticks */}
      {xticks.map(t => (
        <text key={t} x={x(t)} y={H - 10} fill="var(--muted-2)" fontSize="9.5" textAnchor="middle"
              fontFamily="var(--mono)">{t}</text>
      ))}

      {/* strike marker */}
      <line x1={x(K)} y1={padT} x2={x(K)} y2={y(0)} stroke="var(--muted-2)" strokeWidth="1" strokeDasharray="3 4" />
      <text x={x(K) + 4} y={padT + 9} fill="var(--muted-2)" fontSize="9.5" fontFamily="var(--mono)">K {K}</text>

      {/* breakeven marker */}
      {beIn && (
        <g>
          <line x1={x(be)} y1={padT} x2={x(be)} y2={y(0)} stroke="var(--green)" strokeWidth="1"
                strokeDasharray="2 4" opacity="0.5" />
          <text x={x(be) + 4} y={padT + 20} fill="var(--green)" fontSize="9.5" opacity="0.9"
                fontFamily="var(--mono)">B/E {be.toFixed(0)}</text>
        </g>
      )}

      {/* payoff at expiry (intrinsic) */}
      <path d={payoffPath} fill="none" stroke="var(--muted-2)" strokeWidth="1.4" strokeDasharray="5 5" opacity="0.8" />

      {/* BS value curve + fill */}
      <path d={fillPath} fill="url(#valFill)" />
      <path className="chart-line" d={valuePath} fill="none" stroke="var(--gold)"
            strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />

      {/* hover crosshair + tooltip */}
      {hv != null && (
        <g>
          <line x1={hx} y1={padT} x2={hx} y2={y(0)} stroke="var(--ink)" strokeWidth="1" opacity="0.22" />
          <circle cx={hx} cy={hy} r="4" fill="var(--ink-bright)" />
          <g transform={`translate(${Math.min(Math.max(hx, 54), W - 66)}, ${Math.max(hy - 32, padT + 6)})`}>
            <rect x="-52" y="-16" width="104" height="30" rx="6" fill="#141210" stroke="var(--line-strong)" />
            <text x="0" y="-3" fill="var(--muted)" fontSize="9" textAnchor="middle" fontFamily="var(--mono)">
              spot {hoverS!.toFixed(0)}
            </text>
            <text x="0" y="9" fill="var(--ink-bright)" fontSize="10.5" fontWeight="700" textAnchor="middle"
                  fontFamily="var(--mono)">${hv.toFixed(2)}</text>
          </g>
        </g>
      )}

      {/* current spot */}
      <line x1={cx} y1={cy} x2={cx} y2={y(0)} stroke="var(--gold-bright)" strokeWidth="1" opacity="0.5" />
      <circle className="dot-ring" cx={cx} cy={cy} r="11" fill="none" stroke="var(--gold-bright)" strokeWidth="1" />
      <circle cx={cx} cy={cy} r="6" fill="var(--gold-bright)" stroke="#0c0b0a" strokeWidth="2" />
      {hv == null && (
        <text x={cx} y={cy - 15} fill="var(--ink-bright)" fontSize="11.5" fontWeight="700"
              textAnchor="middle" fontFamily="var(--mono)">${spotVal.toFixed(2)}</text>
      )}
    </svg>
  );
}

// ── component ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [status,  setStatus]  = useState<'connecting' | 'connected' | 'demo'>('connecting');
  const [snap,    setSnap]    = useState<Snapshot | null>(null);
  const [spot,    setSpot]    = useState(BASE_OPT.S);
  const [sigma,   setSigma]   = useState(BASE_OPT.sigma);
  const [rate,    setRate]    = useState(BASE_OPT.r);
  const [preset,  setPreset]  = useState<string>('Reset');
  const [live,    setLive]    = useState('');           // debounced screen-reader text
  const wsRef    = useRef<WebSocket | null>(null);
  const entryRef = useRef<number | null>(null);
  const demoRef  = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const computeLocal = useCallback((S: number, sig: number, r: number) => {
    const g = priceGreeks(S, sig, r);
    if (entryRef.current === null) entryRef.current = g.price;
    const pnl = (g.price - entryRef.current) * BASE_OPT.position * 100;
    setSnap({ ...g, pnl });
  }, []);

  const sendUpdate = useCallback((S: number, sig: number, r: number) => {
    if (demoRef.current) { computeLocal(S, sig, r); return; }
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'update', S, sigma: sig, r,
        t_ns: Math.round(performance.now() * 1_000_000),
      }));
    }
  }, [computeLocal]);

  // ── WebSocket lifecycle (falls back to in-browser demo) ──────────────────

  useEffect(() => {
    let ws: WebSocket | null = null;

    const goDemo = () => {
      if (demoRef.current) return;
      demoRef.current = true;
      setStatus('demo');
      computeLocal(BASE_OPT.S, BASE_OPT.sigma, BASE_OPT.r);
    };

    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/.test(host);
    if (!isLocal) { goDemo(); return; }

    const demoTimer = setTimeout(goDemo, 1200);
    try {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        clearTimeout(demoTimer);
        setStatus('connected');
        ws!.send(JSON.stringify({ type: 'subscribe', option: BASE_OPT }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === 'subscribed') {
          entryRef.current = msg.entry_price;
          setSnap({ price: msg.price, delta: msg.delta, gamma: msg.gamma,
                    theta: msg.theta, vega: msg.vega, pnl: 0, calcUs: 0 });
        } else if (msg.type === 'result') {
          setSnap({ price: msg.price, delta: msg.delta, gamma: msg.gamma,
                    theta: msg.theta, vega: msg.vega, pnl: msg.pnl,
                    calcUs: msg.calc_us });
        }
      };
      ws.onerror = () => { clearTimeout(demoTimer); goDemo(); };
      ws.onclose = () => { clearTimeout(demoTimer); goDemo(); };
    } catch {
      clearTimeout(demoTimer); goDemo();
    }
    return () => { clearTimeout(demoTimer); if (ws) ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── debounced screen-reader announcement of the current price ────────────
  useEffect(() => {
    if (!snap) return;
    const id = setTimeout(() => {
      setLive(`Price ${snap.price.toFixed(2)}, delta ${snap.delta.toFixed(3)}, ` +
              `P and L ${snap.pnl >= 0 ? 'up' : 'down'} ${Math.abs(snap.pnl).toFixed(0)} dollars.`);
    }, 550);
    return () => clearTimeout(id);
  }, [snap]);

  // ── manual slider handlers ───────────────────────────────────────────────
  const onSpot  = (v: number) => { setPreset(''); setSpot(v);  sendUpdate(v, sigma, rate); };
  const onSigma = (v: number) => { setPreset(''); setSigma(v); sendUpdate(spot, v, rate); };
  const onRate  = (v: number) => { setPreset(''); setRate(v);  sendUpdate(spot, sigma, v); };

  // ── animated scenario presets ────────────────────────────────────────────
  // setInterval-based tween (fires reliably in every browser/tab state) with a
  // guaranteed final-state apply, so a preset always lands exactly on target.
  const applyPreset = useCallback((p: typeof PRESETS[number]) => {
    setPreset(p.name);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    const apply = (S: number, sig: number, r: number) => {
      setSpot(S); setSigma(sig); setRate(r); sendUpdate(S, sig, r);
    };

    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { apply(p.S, p.sigma, p.r); return; }

    const s0 = spot, v0 = sigma, r0 = rate;
    const dur = 520, t0 = performance.now();
    const ease = (u: number) => 1 - Math.pow(1 - u, 3);
    timerRef.current = setInterval(() => {
      const u = Math.min(1, (performance.now() - t0) / dur), e = ease(u);
      apply(s0 + (p.S - s0) * e, v0 + (p.sigma - v0) * e, r0 + (p.r - r0) * e);
      if (u >= 1 && timerRef.current) {
        clearInterval(timerRef.current); timerRef.current = null;
        apply(p.S, p.sigma, p.r);
      }
    }, 16);
  }, [spot, sigma, rate, sendUpdate]);

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // ── P&L surface ──────────────────────────────────────────────────────────
  const surface = snap ? SPOT_SHOCKS.map(ds =>
    VOL_SHOCKS.map(dv => {
      const dS = spot * ds, dSig = sigma * dv;
      return (snap.delta * dS + 0.5 * snap.gamma * dS * dS + snap.vega * dSig)
             * BASE_OPT.position * 100;
    })
  ) : null;
  const surfMax = surface ? Math.max(1, ...surface.flat().map(v => Math.abs(v))) : 1;

  // ── derived ────────────────────────────────────────────────────────────────
  const statusColor = status === 'connected' ? 'var(--green)'
                    : status === 'connecting' ? '#e0a94a' : 'var(--gold)';
  const statusText  = status === 'connected' ? 'Connected'
                    : status === 'connecting' ? 'Connecting…' : 'Live demo';
  const moneyness = spot / BASE_OPT.K;
  const moneyLabel = moneyness > 1.002 ? 'ITM' : moneyness < 0.998 ? 'OTM' : 'ATM';

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '2rem 1.25rem 3rem' }}>

      {/* screen-reader live region */}
      <div className="sr-only" role="status" aria-live="polite">{live}</div>

      {/* ── header ──────────────────────────────────────────────────────── */}
      <header style={{ marginBottom: '1.4rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.85rem', flexWrap: 'wrap' }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
            <span aria-hidden="true" style={{
              display: 'inline-grid', placeItems: 'center', width: 30, height: 30,
              borderRadius: 8, fontSize: '.95rem', fontWeight: 800, color: '#1a1408',
              background: 'linear-gradient(135deg, #f7e8c6, var(--gold))',
              boxShadow: '0 2px 10px rgba(201,168,106,0.35)',
            }}>Q</span>
            QuantCore
          </h1>
          <span data-testid="ws-status" role="status"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem',
                         padding: '4px 11px', borderRadius: 999, fontSize: '.72rem',
                         fontWeight: 600, color: statusColor,
                         background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line-strong)' }}>
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%',
                         background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
            {statusText}
          </span>
          <nav style={{ marginLeft: 'auto', display: 'flex', gap: '1.1rem', fontSize: '.82rem' }}>
            <a href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
            <a href="https://gaurangkhurana.ca" target="_blank" rel="noopener noreferrer">Portfolio ↗</a>
          </nav>
        </div>
        <p style={{ marginTop: '.6rem', color: 'var(--muted)', fontSize: '.92rem', maxWidth: 650 }}>
          Real-time options pricing &amp; risk engine — a C++17 Black-Scholes / Monte&nbsp;Carlo core
          with analytic Greeks, GPU-accelerated on Apple&nbsp;Metal and streamed over WebSocket.
        </p>
        {status === 'demo' && (
          <p style={{ marginTop: '.55rem', fontSize: '.78rem', color: 'var(--muted-2)' }}>
            Hosted demo — priced live in your browser with the same Black-Scholes math as the C++
            engine. The native GPU / Monte-Carlo backend runs locally.
          </p>
        )}
      </header>

      {/* ── benchmark strip ─────────────────────────────────────────────── */}
      <ul style={{ listStyle: 'none', display: 'grid',
                   gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                   gap: '.7rem', marginBottom: '1.4rem' }}>
        {BENCH.map(b => (
          <li key={b.k} style={{ padding: '.85rem .95rem', borderRadius: 12,
                background: 'linear-gradient(180deg, rgba(201,168,106,0.06), rgba(201,168,106,0.015))',
                border: '1px solid var(--line)' }}>
            <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.16em',
                          color: 'var(--muted-2)' }}>{b.k}</div>
            <div className="mono" style={{ fontSize: '1.5rem', fontWeight: 700, lineHeight: 1.15,
                          margin: '.15rem 0 .1rem', color: 'var(--gold-bright)' }}>{b.v}</div>
            <div style={{ fontSize: '.68rem', color: 'var(--muted)' }}>{b.s}</div>
          </li>
        ))}
      </ul>

      {/* ── main grid: controls+pricing | chart ─────────────────────────── */}
      <div className="qc-grid" style={{ display: 'grid',
             gridTemplateColumns: 'minmax(260px, 0.85fr) minmax(320px, 1.3fr)',
             gap: '1.15rem', alignItems: 'start' }}>

        {/* left column */}
        <div style={{ display: 'grid', gap: '1.15rem' }}>
          {/* controls */}
          <section>
            <h2>Scenario Controls
              <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 600,
                     padding: '2px 8px', borderRadius: 999, letterSpacing: '.08em',
                     color: moneyLabel === 'ITM' ? 'var(--green)' : moneyLabel === 'OTM' ? 'var(--red)' : 'var(--gold)',
                     border: '1px solid var(--line)' }}>{moneyLabel}</span>
            </h2>

            {/* preset buttons */}
            <div role="group" aria-label="Scenario presets"
                 style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', margin: '1rem 0 .3rem' }}>
              {PRESETS.map(p => (
                <button key={p.name} className="preset" type="button"
                        aria-pressed={preset === p.name}
                        onClick={() => applyPreset(p)}>{p.name}</button>
              ))}
            </div>

            <div style={{ display: 'grid', gap: '1.15rem', marginTop: '1rem' }}>
              {[
                { label: 'Spot', sym: 'S', tid: 'spot-input',  val: spot,  set: onSpot,
                  min: CLAMP.S[0], max: CLAMP.S[1], step: 0.5,
                  disp: (v: number) => v.toFixed(2),           dtid: 'spot-display' },
                { label: 'Volatility', sym: 'σ', tid: 'vol-input', val: sigma, set: onSigma,
                  min: CLAMP.sigma[0], max: CLAMP.sigma[1], step: 0.005,
                  disp: (v: number) => (v*100).toFixed(1)+'%', dtid: 'vol-display' },
                { label: 'Rate', sym: 'r', tid: 'rate-input', val: rate,  set: onRate,
                  min: CLAMP.r[0], max: CLAMP.r[1], step: 0.001,
                  disp: (v: number) => (v*100).toFixed(2)+'%', dtid: 'rate-display' },
              ].map(({ label, sym, tid, val, set, min, max, step, disp, dtid }) => {
                const pct = ((val - min) / (max - min)) * 100;
                return (
                  <label key={tid} style={{ display: 'grid', gap: '.5rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
                        {label} <span className="mono" style={{ color: 'var(--muted-2)' }}>({sym})</span>
                      </span>
                      <strong data-testid={dtid} className="mono"
                              style={{ fontSize: '.98rem', color: 'var(--ink-bright)' }}>{disp(val)}</strong>
                    </div>
                    <input data-testid={tid} type="range"
                           min={min} max={max} step={step} value={val}
                           aria-label={`${label} (${sym})`} aria-valuetext={disp(val)}
                           onChange={e => set(parseFloat(e.target.value))}
                           style={{ background:
                             `linear-gradient(90deg, var(--gold) 0%, var(--gold) ${pct}%, rgba(201,168,106,0.14) ${pct}%, rgba(201,168,106,0.14) 100%)` }} />
                  </label>
                );
              })}
            </div>

            <div style={{ marginTop: '1.2rem', paddingTop: '.95rem', borderTop: '1px solid var(--line)',
                          fontSize: '.72rem', color: 'var(--muted-2)' }}>
              <span className="mono">SPY</span> call · strike <span className="mono">755</span> ·
              {' '}<span className="mono">47d</span> · <span className="mono">10</span> contracts
            </div>
          </section>

          {/* live pricing */}
          <section>
            <h2>Live Pricing
              {snap && (
                <span style={{ marginLeft: 'auto', fontSize: '.62rem', color: 'var(--muted-2)',
                               textTransform: 'none', letterSpacing: 0 }}>
                  {status === 'demo' ? 'in-browser' : 'C++ engine'} ·{' '}
                  <span data-testid="calc-us" className="mono">{snap.calcUs.toFixed(1)}</span> µs
                </span>
              )}
            </h2>
            {snap ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '.55rem',
                            marginTop: '1.05rem' }}>
                {([
                  ['Price',     'price',  snap.price.toFixed(3),       'var(--ink-bright)'],
                  ['Delta Δ',   'delta',  snap.delta.toFixed(4),       'var(--ink-bright)'],
                  ['Gamma Γ',   'gamma',  snap.gamma.toFixed(5),       'var(--ink-bright)'],
                  ['Theta/day', 'theta',  (snap.theta/365).toFixed(4), 'var(--ink-bright)'],
                  ['Vega ν',    'vega',   snap.vega.toFixed(3),        'var(--ink-bright)'],
                  ['P&L',       'pnl',    `${snap.pnl >= 0 ? '+' : ''}${snap.pnl.toFixed(0)}`,
                                          snap.pnl >= 0 ? 'var(--green)' : 'var(--red)'],
                ] as [string, string, string, string][]).map(([lbl, tid, val, color]) => (
                  <div key={tid} aria-label={`${lbl}: ${val}`}
                       style={{ padding: '.65rem .6rem .7rem', borderRadius: 11,
                                background: 'var(--panel-2)', border: '1px solid var(--line)' }}>
                    <div style={{ fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.09em',
                                  color: 'var(--muted-2)', marginBottom: '.3rem' }}>{lbl}</div>
                    <div data-testid={tid} className="mono" style={{ fontSize: '1.15rem', fontWeight: 650, color }}>
                      <span key={val} className="flash" style={{ color }}>{val}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div data-testid="loading" style={{ color: 'var(--muted)', marginTop: '1rem' }}>
                Waiting for pricing data…
              </div>
            )}
          </section>
        </div>

        {/* right column: payoff chart */}
        <section style={{ position: 'sticky', top: '1rem' }}>
          <h2>Option Value
            <span style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 400,
                           color: 'var(--muted-2)', letterSpacing: 0, textTransform: 'none' }}>
              value now vs payoff at expiry
            </span>
          </h2>
          <div style={{ marginTop: '.9rem' }}>
            <PayoffChart spot={spot} sigma={sigma} rate={rate} />
          </div>
          <div style={{ display: 'flex', gap: '1.2rem', marginTop: '.4rem', flexWrap: 'wrap',
                        fontSize: '.7rem', color: 'var(--muted)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
              <span style={{ width: 16, height: 2, background: 'var(--gold)', borderRadius: 2 }} /> value now
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
              <span style={{ width: 16, height: 0, borderTop: '2px dashed var(--muted-2)' }} /> payoff at expiry
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--gold-bright)' }} /> current spot
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}>
              <span style={{ width: 16, height: 0, borderTop: '2px dashed var(--green)' }} /> break-even
            </span>
          </div>
          <p style={{ marginTop: '.8rem', fontSize: '.68rem', color: 'var(--muted-2)', lineHeight: 1.55 }}>
            The gap between the two lines is time value — it grows with volatility and shrinks to zero at expiry.
            Hover the chart to read the value at any spot; drag a slider or pick a scenario to watch it move.
          </p>
        </section>
      </div>

      {/* ── P&L surface ─────────────────────────────────────────────────── */}
      {surface && (
        <section style={{ marginTop: '1.15rem' }}>
          <h2>P&amp;L Surface
            <span style={{ marginLeft: 'auto', fontSize: '.62rem', fontWeight: 400,
                           color: 'var(--muted-2)', letterSpacing: 0, textTransform: 'none' }}>
              δ-Γ-ν approximation · rows = spot shock · cols = vol shock
            </span>
          </h2>
          <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
            <table data-testid="pnl-surface" className="mono"
                   style={{ borderCollapse: 'separate', borderSpacing: 4, width: '100%',
                            fontSize: '.8rem', minWidth: 440 }}>
              <thead>
                <tr>
                  <th style={TH}><span style={{ color: 'var(--muted-2)' }}>ΔS \ Δσ</span></th>
                  {VOL_SHOCKS.map(v => (
                    <th key={v} style={TH}>{v >= 0 ? '+' : ''}{(v*100).toFixed(0)}%</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SPOT_SHOCKS.map((ds, ri) => (
                  <tr key={ds}>
                    <th scope="row" style={TH}>{ds >= 0 ? '+' : ''}{(ds*100).toFixed(0)}%</th>
                    {VOL_SHOCKS.map((dv, ci) => {
                      const v = surface[ri][ci];
                      const mag = Math.min(Math.abs(v) / surfMax, 1);
                      const a = 0.06 + mag * 0.66;
                      const bg = v >= 0 ? `rgba(99,216,145,${a})` : `rgba(244,122,128,${a})`;
                      const isCenter = ds === 0 && dv === 0;
                      return (
                        <td key={ci} data-testid={`pnl-${ri}-${ci}`}
                            title={`Spot ${ds >= 0 ? '+' : ''}${(ds*100).toFixed(0)}%, Vol ${dv >= 0 ? '+' : ''}${(dv*100).toFixed(0)}%  →  ${v >= 0 ? '+' : ''}$${v.toFixed(0)}`}
                            style={{ ...TD, background: bg,
                                     color: mag > 0.42 ? '#0a0806' : 'var(--ink)',
                                     fontWeight: mag > 0.42 ? 700 : 500,
                                     boxShadow: isCenter ? 'inset 0 0 0 1.5px var(--gold-bright)' : 'none' }}>
                          {v >= 0 ? '+' : ''}{v.toFixed(0)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', marginTop: '.9rem',
                        fontSize: '.68rem', color: 'var(--muted-2)' }}>
            <span>loss</span>
            <span aria-hidden="true" style={{ flex: 1, maxWidth: 200, height: 7, borderRadius: 999,
                   background: 'linear-gradient(90deg, var(--red-deep), rgba(120,110,95,0.25), var(--green-deep))' }} />
            <span>gain</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '.35rem' }}>
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3,
                     boxShadow: 'inset 0 0 0 1.5px var(--gold-bright)' }} /> current
            </span>
          </div>
        </section>
      )}

      {/* ── footer ──────────────────────────────────────────────────────── */}
      <footer style={{ marginTop: '1.6rem', textAlign: 'center', fontSize: '.72rem', color: 'var(--muted-2)' }}>
        C++17 · pybind11 · Apple Metal · FastAPI · Next.js —{' '}
        <a href="https://github.com/gkhurana21/quantcore" target="_blank" rel="noopener noreferrer">source on GitHub</a>
      </footer>

      <style>{`
        @media (max-width: 680px) {
          .qc-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </main>
  );
}

const TH: React.CSSProperties = {
  padding: '6px 8px', color: 'var(--muted)', textAlign: 'center', fontWeight: 600, fontSize: '.72rem',
};
const TD: React.CSSProperties = {
  padding: '9px 8px', textAlign: 'right', borderRadius: 7, transition: 'background .18s ease',
};
