'use client';

import { memo, useMemo, useRef } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { normInv, normPdf } from '@/lib/quant/normal';
import type { McVarResult } from '@/lib/risk/var';
import { deltaGammaVaR, deltaNormalVaR, exposures, horizonVol } from '@/lib/risk/var';
import { useWorkerTask } from '@/lib/compute/useWorkerTask';
import { legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { VAR_BACKTEST } from '@/lib/engine/benchmarks';
import { num, pct, signed, usd, usdSigned } from '@/lib/format';
import { linear, niceTicks, usdTick } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import { cx, Segmented, ui } from '@/components/ui/primitives';
import { fmtMs } from '@/components/lab/labFormat';
import r from './risk.module.css';

const MC_SCENARIOS = 20_000;
const MC_SEED = 11;
// Illustrative equity-index values: implied vol moves ~100%/yr and falls when spot rises.
const VOL_FACTOR = { volOfVol: 1.0, rho: -0.7 };

const PnlHistogram = memo(function PnlHistogram({ res }: { res: McVarResult }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 520);
  const height = 220;
  const pad = { l: 12, r: 12, t: 22, b: 30 };
  const X = linear(res.lo, res.hi, pad.l, width - pad.r);
  const maxN = Math.max(1, ...res.bins.map(b => b.n));
  const Y = linear(0, maxN * 1.12, height - pad.b, pad.t);
  const clampX = (v: number) => Math.min(width - pad.r, Math.max(pad.l, X(v)));

  return (
    <div ref={wrap} data-testid="var-hist">
      <svg className={r.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Distribution of ${res.scenarios} simulated P&L outcomes; VaR ${usd(res.var)}, expected shortfall ${usd(res.es)}.`}>
        {res.bins.map((b, i) => {
          const tail = b.x1 <= -res.var;
          return (
            <rect key={i} x={X(b.x0) + 0.5} y={Y(b.n)} width={Math.max(1, X(b.x1) - X(b.x0) - 1)}
                  height={Math.max(0, Y(0) - Y(b.n))} rx={1}
                  fill={tail ? 'rgba(240,106,110,0.85)' : b.x1 <= 0 ? 'rgba(240,106,110,0.35)' : 'rgba(76,203,141,0.45)'} />
          );
        })}
        {res.lo < 0 && res.hi > 0 && <line x1={X(0)} x2={X(0)} y1={pad.t} y2={height - pad.b} stroke="var(--line-3)" />}
        <line x1={clampX(-res.var)} x2={clampX(-res.var)} y1={pad.t - 4} y2={height - pad.b} stroke="var(--red)" strokeWidth={1.5} />
        <text x={clampX(-res.var) + 4} y={pad.t + 6} className={r.label} fill="var(--red)">VaR {usdTick(res.var)}</text>
        <line x1={clampX(-res.es)} x2={clampX(-res.es)} y1={pad.t + 12} y2={height - pad.b} stroke="var(--red)" strokeDasharray="4 3" />
        <text x={clampX(-res.es) + 4} y={pad.t + 20} className={r.label} fill="var(--red)">ES {usdTick(res.es)}</text>
        {niceTicks(res.lo, res.hi, width < 420 ? 3 : 5).map(t => (
          <text key={t} x={X(t)} y={height - 10} textAnchor="middle" className={r.axis}>{usdTick(t)}</text>
        ))}
      </svg>
    </div>
  );
});

export function RiskPanel({ legs, market, conf, horizon, onConf, onHorizon, active }: {
  legs: Leg[]; market: Market; conf: number; horizon: number;
  onConf: (c: number) => void; onHorizon: (h: number) => void; active: boolean;
}) {
  const var95 = useMemo(() => deltaNormalVaR(legs, market, 0.95, 1), [legs, market]);
  const ex = useMemo(() => exposures(legs, market), [legs, market]);
  const dn = useMemo(() => deltaNormalVaR(legs, market, conf, horizon), [legs, market, conf, horizon]);
  const dg = useMemo(() => deltaGammaVaR(legs, market, conf, horizon), [legs, market, conf, horizon]);
  const z = normInv(conf);
  const hVol = horizonVol(market.sigma, horizon);
  const esDn = Math.abs(ex.dollarDelta) * hVol * normPdf(z) / (1 - conf);

  const key = `${legsKeyOf(legs)}|${marketKeyOf(market)}|${conf}|${horizon}`;
  const mc = useWorkerTask('mcvar', active
    ? { legs, market, conf, hDays: horizon, nScen: MC_SCENARIOS, seed: MC_SEED } : null, key, 150);
  const res = mc.result;
  const mc2 = useWorkerTask('mcvar', active
    ? { legs, market, conf, hDays: horizon, nScen: MC_SCENARIOS, seed: MC_SEED, volFactor: VOL_FACTOR } : null,
    `${key}|2f`, 150);
  const res2 = mc2.result;
  const label = `${horizon}-day ${Math.round(conf * 100)}%`;

  return (
    <div>
      <div className={r.head}>
        <div>
          <div className={ui.eyebrow}>1-day 95% VaR · parametric (delta-normal)</div>
          <div className={r.big} data-testid="var-95" data-value={var95}>{usd(var95)}</div>
          <div className={r.formula}>
            1.645 × |$Δ {usd(Math.abs(ex.dollarDelta))}| × σ√(1/252) {pct(horizonVol(market.sigma, 1), 2)}
          </div>
        </div>
        <p className={r.explain}>
          Under the model&rsquo;s assumptions, the position should lose more than this on roughly one trading day in
          twenty. It is a first-order, single-factor estimate: the table below shows how convexity (delta-gamma) and full
          revaluation (Monte Carlo) change the picture — and why option books need more than a linear VaR.
        </p>
      </div>

      <div className={r.controls}>
        <span className={r.control}>Confidence
          <Segmented size="sm" accent label="VaR confidence" testid="var-conf" value={conf} onChange={onConf}
                     options={[0.9, 0.95, 0.99].map(c => ({ value: c, label: `${Math.round(c * 100)}%` }))} />
        </span>
        <span className={r.control}>Horizon
          <Segmented size="sm" accent label="VaR horizon" testid="var-horizon" value={horizon} onChange={onHorizon}
                     options={[1, 5, 10].map(h => ({ value: h, label: `${h}d` }))} />
        </span>
        <span className={r.control}>z = {num(z, 3)} · σ√h = {pct(hVol, 2)}</span>
      </div>

      <div className={r.grid}>
        <div className={r.box}>
          <div className={r.boxHead}><span>VaR by method · {label}</span><span>loss, USD</span></div>
          <div className={ui.tableWrap}>
            <table className={ui.table} data-testid="var-methods">
              <thead><tr><th>Method</th><th className={ui.num}>VaR</th><th className={ui.num}>ES</th></tr></thead>
              <tbody>
                <tr>
                  <td><span className={r.method}>Delta-normal</span>
                    <span className={r.methodNote}>z·|Δ·S|·σ√(h/252). Linear in spot; ignores convexity.</span></td>
                  <td className={ui.num} data-testid="var-delta-normal" data-value={dn}>{usd(dn)}</td>
                  <td className={ui.num}>{usd(esDn)}</td>
                </tr>
                <tr>
                  <td><span className={r.method}>Delta-gamma</span>
                    <span className={r.methodNote}>Worst of Δ·dS + ½Γ·dS² at dS = ±z·S·σ√h. Adds convexity.</span></td>
                  <td className={ui.num} data-testid="var-delta-gamma" data-value={dg}>{usd(dg)}</td>
                  <td className={ui.num}>—</td>
                </tr>
                <tr>
                  <td><span className={r.method}>Monte Carlo, full revaluation</span>
                    <span className={r.methodNote}>
                      {MC_SCENARIOS.toLocaleString('en-US')} seeded lognormal spot scenarios; every leg repriced with its
                      expiry shortened by the horizon.
                    </span></td>
                  <td className={ui.num} data-testid="var-mc" data-value={res?.var ?? ''}>{res ? usd(res.var) : '…'}</td>
                  <td className={ui.num} data-testid="es-mc" data-value={res?.es ?? ''}>{res ? usd(res.es) : '…'}</td>
                </tr>
                <tr>
                  <td><span className={r.method}>Monte Carlo, spot + implied vol</span>
                    <span className={r.methodNote}>
                      Same spot scenarios plus a correlated lognormal implied-vol shock (vol-of-vol {VOL_FACTOR.volOfVol * 100}%/yr,
                      ρ = {VOL_FACTOR.rho} with spot — illustrative equity-index values), so vega risk enters VaR.
                    </span></td>
                  <td className={ui.num} data-testid="var-mc-2f" data-value={res2?.var ?? ''}>{res2 ? usd(res2.var) : '…'}</td>
                  <td className={ui.num} data-testid="es-mc-2f" data-value={res2?.es ?? ''}>{res2 ? usd(res2.es) : '…'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className={ui.note} style={{ marginTop: 8 }}>
            ES (expected shortfall) is the average loss beyond VaR.
            {res ? ` Monte Carlo: ${fmtMs(res.ms)} in a ${mc.mode === 'worker' ? 'Web Worker' : 'main-thread fallback'}.` : ''}
          </p>
        </div>
        <div className={cx(r.box, mc.running && 'stale')}>
          <div className={r.boxHead}><span>Simulated P&amp;L distribution · {label}</span><span>seed {MC_SEED}</span></div>
          {res ? <PnlHistogram res={res} /> : <p className={ui.note}>Simulating scenarios…</p>}
        </div>
      </div>

      <dl className={r.exposures}>
        <div className={r.exp}><dt>Position value</dt><dd>{usd(ex.value)}</dd><dd className={r.expSub}>mark to model</dd></div>
        <div className={r.exp}><dt>Delta</dt><dd>{signed(ex.deltaShares, 0)} sh</dd><dd className={r.expSub}>$Δ {usdSigned(ex.dollarDelta)}</dd></div>
        <div className={r.exp}><dt>Gamma, 1% move</dt><dd>{usdSigned(ex.gammaPerPct)}</dd><dd className={r.expSub}>½Γ(0.01·S)²</dd></div>
        <div className={r.exp}><dt>Vega</dt><dd>{usdSigned(ex.vegaPerPt)}</dd><dd className={r.expSub}>per +1 vol point</dd></div>
        <div className={r.exp}><dt>Theta</dt><dd>{usdSigned(ex.thetaPerDay)}</dd><dd className={r.expSub}>per calendar day</dd></div>
        <div className={r.exp}><dt>1σ daily move</dt><dd>±{usd(market.S * horizonVol(market.sigma, 1), 2)}</dd><dd className={r.expSub}>S·σ/√252</dd></div>
      </dl>

      <div className={r.bottom}>
        <div className={r.box}>
          <div className={r.boxHead}><span>Assumptions</span><span>read before relying on a number</span></div>
          <ul className={r.list}>
            <li>One risk factor: the underlying follows a zero-drift lognormal process over the horizon.</li>
            <li>Rates are held fixed. Volatility is fixed in the parametric and one-factor rows; the two-factor row adds implied-vol risk with illustrative parameters, not a calibrated vol model.</li>
            <li data-testid="var-vol-assumption">
              {market.term
                ? `Implied volatility from the ${market.smile ? 'SSVI smile and ' : ''}ATM term structure: spot returns use the 30-day σ, ` +
                  `${market.smile ? 'each strike keeps its smile volatility (sticky strike), ' : ''}each leg reads its volatility at its remaining maturity, ` +
                  'and vol shocks scale every expiry in proportion'
                : market.smile
                  ? 'Implied volatility from the SSVI smile: spot returns use the at-the-money σ, each strike keeps its smile volatility (sticky strike), and the two-factor row shocks the at-the-money level'
                  : 'Flat implied volatility across strikes and expiries (no skew or smile)'}; European exercise.
            </li>
            <li>σ√(h/252) scaling assumes independent daily returns (square-root-of-time).</li>
            <li>Parametric methods use today&rsquo;s Greeks; delta-normal is exact only for linear positions.</li>
          </ul>
        </div>
        <div className={r.box}>
          <div className={r.boxHead}><span>How to read this</span><span>educational research model</span></div>
          <p className={ui.note}>
            This is a research and teaching tool, not a regulatory or trading risk system, and nothing here is investment
            advice. Short-option books can lose far more than VaR in a gap move — see the Stress Lab.
          </p>
          <p className={ui.note} style={{ marginTop: 8 }}>{VAR_BACKTEST}</p>
        </div>
      </div>
    </div>
  );
}
