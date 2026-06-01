'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── constants ──────────────────────────────────────────────────────────────

const WS_URL   = 'ws://localhost:8765/ws';
const BASE_OPT = { S: 756.48, K: 755.0, r: 0.045, sigma: 0.138, T: 0.129,
                   call: true, position: 10 };

const SPOT_SHOCKS = [-0.10, -0.05, 0, +0.05, +0.10];
const VOL_SHOCKS  = [-0.50, -0.25, 0, +0.25, +0.50];

// ── types ──────────────────────────────────────────────────────────────────

interface Snapshot {
  price: number; delta: number; gamma: number;
  theta: number; vega: number;  pnl:   number;
  calcUs: number;
}

// ── component ──────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [status,  setStatus]  = useState<'connecting'|'connected'|'disconnected'>('connecting');
  const [snap,    setSnap]    = useState<Snapshot | null>(null);
  const [spot,    setSpot]    = useState(BASE_OPT.S);
  const [sigma,   setSigma]   = useState(BASE_OPT.sigma);
  const [rate,    setRate]    = useState(BASE_OPT.r);
  const wsRef = useRef<WebSocket | null>(null);
  const entryRef = useRef<number | null>(null);

  // ── WebSocket lifecycle ─────────────────────────────────────────────────

  const sendUpdate = useCallback((S: number, sig: number, r: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'update', S, sigma: sig, r,
        t_ns: Math.round(performance.now() * 1_000_000),
      }));
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('connected');
      ws.send(JSON.stringify({ type: 'subscribe', option: BASE_OPT }));
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

    ws.onclose = () => setStatus('disconnected');
    ws.onerror = () => setStatus('disconnected');

    return () => { ws.close(); };
  }, []);

  // ── handlers ───────────────────────────────────────────────────────────

  const onSpot  = (v: number) => { setSpot(v);  sendUpdate(v, sigma, rate); };
  const onSigma = (v: number) => { setSigma(v); sendUpdate(spot, v, rate); };
  const onRate  = (v: number) => { setRate(v);  sendUpdate(spot, sigma, v); };

  // ── P&L surface (delta-gamma-vega approximation) ───────────────────────

  const surface = snap ? SPOT_SHOCKS.map(ds =>
    VOL_SHOCKS.map(dv => {
      const dS    = spot * ds;
      const dSig  = sigma * dv;
      const pnl   = (snap.delta * dS + 0.5 * snap.gamma * dS * dS
                     + snap.vega * dSig) * BASE_OPT.position * 100;
      return pnl;
    })
  ) : null;

  // ── render ─────────────────────────────────────────────────────────────

  const statusColor = status === 'connected' ? '#22c55e'
                    : status === 'connecting' ? '#f59e0b' : '#ef4444';

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '1.5rem' }}>

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
        <h1>QuantCore Dashboard</h1>
        <span data-testid="ws-status"
              style={{ padding: '3px 12px', borderRadius: 20, fontSize: '.8rem',
                       background: statusColor, color: '#fff', fontWeight: 600 }}>
          {status === 'connected' ? 'Connected'
         : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </span>
        {snap && (
          <span style={{ marginLeft: 'auto', fontSize: '.75rem', color: '#64748b' }}>
            C++ calc: <span data-testid="calc-us">{snap.calcUs.toFixed(1)}</span> µs
          </span>
        )}
      </div>

      {/* scenario controls */}
      <section>
        <h2>Scenario Controls</h2>
        <div style={{ display: 'grid', gap: '1rem' }}>
          {[
            { label: 'Spot (S)',   tid: 'spot-input',  val: spot,  set: onSpot,
              min: 680, max: 830, step: 0.5,
              disp: (v: number) => v.toFixed(2),          dtid: 'spot-display' },
            { label: 'Vol (σ)',    tid: 'vol-input',   val: sigma, set: onSigma,
              min: 0.05, max: 0.50, step: 0.005,
              disp: (v: number) => (v*100).toFixed(1)+'%', dtid: 'vol-display' },
            { label: 'Rate (r)',   tid: 'rate-input',  val: rate,  set: onRate,
              min: 0.00, max: 0.10, step: 0.001,
              disp: (v: number) => (v*100).toFixed(2)+'%', dtid: 'rate-display' },
          ].map(({ label, tid, val, set, min, max, step, disp, dtid }) => (
            <label key={tid} style={{ display: 'grid', gap: '.3rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{label}</span>
                <strong data-testid={dtid}>{disp(val)}</strong>
              </div>
              <input data-testid={tid} type="range"
                     min={min} max={max} step={step} value={val}
                     onChange={e => set(parseFloat(e.target.value))} />
            </label>
          ))}
        </div>
      </section>

      {/* live pricing */}
      <section>
        <h2>Live Pricing
          <small style={{ fontWeight: 400, marginLeft: '.5rem', color: '#64748b' }}>
            K=755 · T=47d · 10 contracts
          </small>
        </h2>

        {snap ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '.75rem' }}>
            {([
              ['Price',     'price',  snap.price.toFixed(4)             ],
              ['Delta (Δ)', 'delta',  snap.delta.toFixed(4)             ],
              ['Gamma (Γ)', 'gamma',  snap.gamma.toFixed(6)             ],
              ['Theta/day', 'theta',  (snap.theta/365).toFixed(4)       ],
              ['Vega (ν)',  'vega',   snap.vega.toFixed(4)              ],
              ['P&L ($)',   'pnl',    `${snap.pnl >= 0 ? '+' : ''}${snap.pnl.toFixed(2)}`],
            ] as [string,string,string][]).map(([lbl, tid, val]) => (
              <div key={tid}
                   style={{ textAlign: 'center', padding: '.6rem',
                            background: '#0f172a', borderRadius: 6,
                            border: '1px solid #334155' }}>
                <div style={{ fontSize: '.75rem', color: '#64748b', marginBottom: '.2rem' }}>
                  {lbl}
                </div>
                <div data-testid={tid}
                     style={{ fontSize: '1.3rem', fontWeight: 700, color: '#e2e8f0' }}>
                  {val}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div data-testid="loading" style={{ color: '#64748b' }}>
            Waiting for pricing data…
          </div>
        )}
      </section>

      {/* P&L surface */}
      {surface && (
        <section>
          <h2>P&L Surface
            <small style={{ fontWeight: 400, marginLeft: '.5rem', color: '#64748b' }}>
              δ-Γ-ν approx · rows = ΔS · cols = Δσ · updates live
            </small>
          </h2>
          <table data-testid="pnl-surface"
                 style={{ borderCollapse: 'collapse', width: '100%', fontSize: '.85rem' }}>
            <thead>
              <tr>
                <th style={TH}>ΔS \ Δσ</th>
                {VOL_SHOCKS.map(v => (
                  <th key={v} style={TH}>{v >= 0 ? '+' : ''}{(v*100).toFixed(0)}%</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SPOT_SHOCKS.map((ds, ri) => (
                <tr key={ds}>
                  <td style={TH}>{ds >= 0 ? '+' : ''}{(ds*100).toFixed(0)}%</td>
                  {VOL_SHOCKS.map((_, ci) => {
                    const v   = surface[ri][ci];
                    const mag = Math.min(Math.abs(v) / 3000, 0.7);
                    const bg  = v >= 0
                      ? `rgba(34,197,94,${mag})`
                      : `rgba(239,68,68,${mag})`;
                    return (
                      <td key={ci}
                          data-testid={`pnl-${ri}-${ci}`}
                          style={{ ...TD, background: bg }}>
                        {v >= 0 ? '+' : ''}{v.toFixed(0)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

    </main>
  );
}

const TH: React.CSSProperties = {
  border: '1px solid #334155', padding: '6px 10px',
  background: '#1e293b', color: '#94a3b8', textAlign: 'center',
};
const TD: React.CSSProperties = {
  border: '1px solid #334155', padding: '6px 10px', textAlign: 'right',
};
