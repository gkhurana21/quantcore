'use client';

// Early exercise under the volatility surface. Each leg's American value by finite differences (core/src/pde.cpp,
// in the WebAssembly worker) under the surface's Dupire local volatility and at the leg's own implied volatility, the
// early-exercise premium each implies, and the exercise boundary: under an equity skew the deep in-the-money spots
// where a put would be exercised carry far higher local volatility than the strike's implied volatility, so holding
// is worth more and the boundary sits lower.

import { memo, useMemo, useRef, useState } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import { bsPrice } from '@/lib/quant/blackScholes';
import { hasVolSurface, legSigma } from '@/lib/quant/volSurface';
import type { LabResult } from '@/lib/compute/tasks';
import type { WasmEngine } from '@/lib/engine/useWasmEngine';
import type { PdeItem } from '@/lib/engine/usePdeBatch';
import { usePdeBatch } from '@/lib/engine/usePdeBatch';
import type { LsmResult, PdeResult } from '@/lib/engine/wasm';
import { PDE_GRID } from '@/lib/engine/wasm';
import { legLabel, legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { num, signed, usd, usdSigned } from '@/lib/format';
import { linear, niceTicks, strikeTick } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import { Badge, Button, cx, ui } from '@/components/ui/primitives';
import { fmtMs, fmtPaths } from './labFormat';
import l from './lab.module.css';

type Boundary = PdeResult['boundary'];

/** The Longstaff–Schwartz cross-check: a policy fitted on one set of paths, valued on another (policy × dates ≤ 600k cells). */
const LSM = { policyPaths: 20_000, valuePaths: 200_000, dates: 26, stepsPerYear: 365, seed: 31 } as const;

interface Plan { leg: number; flat: number; lvAm: number | null; lvEu: number | null; }

interface Row {
  leg: number; label: string; call: boolean; K: number; T: number; weight: number;
  bs: number;                                   // European at the leg's implied volatility (closed form)
  amFlat: number;                               // American at that volatility (PDE)
  crr: number | null; crrEu: number | null;     // the Lab's 512-step lattice, American and European
  euLv: number | null; amLv: number | null;     // European and American under local volatility (PDE)
  eepFlat: number; eepLv: number | null;
  todayFlat: number | null; todayLv: number | null;
  boundaryFlat: Boundary; boundaryLv: Boundary | null;
}

function buildItems(legs: Leg[], m: Market, surface: boolean): { items: PdeItem[]; plan: Plan[] } {
  const items: PdeItem[] = [];
  const plan: Plan[] = [];
  legs.forEach((leg, i) => {
    if (!(leg.T > 0) || !(leg.K > 0)) return;
    const flat: Market = { S: m.S, r: m.r, q: m.q, sigma: legSigma(m, leg.K, leg.T), smile: null, term: null };
    const base = { call: leg.call, K: leg.K, T: leg.T };
    const p: Plan = { leg: i, flat: items.push({ spec: { ...base, kind: 'american' }, market: flat }) - 1, lvAm: null, lvEu: null };
    if (surface) {
      p.lvAm = items.push({ spec: { ...base, kind: 'american' }, market: m }) - 1;
      p.lvEu = items.push({ spec: { ...base, kind: 'european' }, market: m }) - 1;
    }
    plan.push(p);
  });
  return { items, plan };
}

const today = (b: Boundary | null | undefined): number | null => (b && b.length ? b[b.length - 1].S : null);

const BoundaryChart = memo(function BoundaryChart({ row, spot }: { row: Row; spot: number }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 640);
  const height = 220;
  const pad = { l: 58, r: 16, t: 14, b: 32 };
  const days = row.T * 365;
  const values = [row.boundaryFlat, row.boundaryLv ?? []].flatMap(b => b.flatMap(p => (p.S == null ? [] : [p.S])));
  let lo = Math.min(...values, row.K, spot), hi = Math.max(...values, row.K, spot);
  const span = hi - lo || hi * 0.1;
  lo = Math.max(0, lo - span * 0.08);
  hi += span * 0.08;
  const X = linear(0, days, pad.l, width - pad.r);
  const Y = linear(lo, hi, height - pad.b, pad.t);
  const path = (b: Boundary) => {
    let d = '', pen = false;
    for (const p of b) {
      if (p.S == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${X(p.tau * 365).toFixed(1)},${Y(p.S).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const side = row.call ? 'above' : 'below';

  return (
    <div ref={wrap} data-testid="lab-pde-boundary" data-flat-today={row.todayFlat ?? ''} data-lv-today={row.todayLv ?? ''}
         data-points={row.boundaryFlat.filter(p => p.S != null).length}>
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Early-exercise boundary of ${row.label}: exercised ${side} ${row.todayFlat != null ? strikeTick(row.todayFlat) : 'no spot'} today at the leg's implied volatility${row.boundaryLv ? ` and ${side} ${row.todayLv != null ? strikeTick(row.todayLv) : 'no spot'} under local volatility` : ''}, rising towards the strike ${strikeTick(row.K)} at expiry.`}>
        {niceTicks(lo, hi, 4).map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={l.axis}>{strikeTick(t)}</text>
          </g>
        ))}
        {niceTicks(0, days, 5).map(t => (
          <text key={t} x={X(t)} y={height - 10} textAnchor="middle" className={l.axis}>{t === 0 ? 'expiry' : `${t}d`}</text>
        ))}
        <line x1={pad.l} x2={width - pad.r} y1={Y(row.K)} y2={Y(row.K)} stroke="var(--ink-4)" strokeDasharray="2 3" />
        <text x={width - pad.r} y={Y(row.K) - 5} textAnchor="end" className={l.axis}>strike {strikeTick(row.K)}</text>
        <line x1={pad.l} x2={width - pad.r} y1={Y(spot)} y2={Y(spot)} stroke="var(--blue)" strokeDasharray="1 4" opacity={0.8} />
        <text x={pad.l + 6} y={Y(spot) - 5} className={l.axis}>spot</text>
        <path d={path(row.boundaryFlat)} fill="none" stroke="var(--blue)" strokeWidth={1.6} />
        {row.boundaryLv && <path d={path(row.boundaryLv)} fill="none" stroke="var(--amber-2)" strokeWidth={1.8} />}
      </svg>
      <div className={l.legend} aria-hidden="true">
        <span><i className={l.sw} style={{ background: 'var(--blue)' }} />Implied volatility σ(K, T)</span>
        {row.boundaryLv && <span><i className={l.sw} style={{ background: 'var(--amber-2)' }} />Local volatility</span>}
        <span>exercise {side} the line · x: days to expiry</span>
      </div>
    </div>
  );
});

export function EarlyExercise({ legs, market, wasm, active, lab, labCurrent }: {
  legs: Leg[]; market: Market; wasm: WasmEngine; active: boolean; lab: LabResult; labCurrent: boolean;
}) {
  const surface = hasVolSurface(market);
  const key = `${legsKeyOf(legs)}|${marketKeyOf(market)}`;
  const { items, plan } = useMemo(() => buildItems(legs, market, surface), [legs, market, surface]);
  const batch = usePdeBatch(wasm, active ? items : null, key);
  const { result: batchResult, current: batchCurrent } = batch;

  const rows = useMemo((): Row[] => {
    const res = batchCurrent ? batchResult?.results : undefined;
    if (!res) return [];
    return plan.flatMap((p): Row[] => {
      const leg = legs[p.leg];
      const flat = res[p.flat], lvAm = p.lvAm != null ? res[p.lvAm] : null, lvEu = p.lvEu != null ? res[p.lvEu] : null;
      if (!flat || (surface && (!lvAm || !lvEu))) return [];
      const bs = bsPrice(leg.call, market.S, leg.K, leg.T, legSigma(market, leg.K, leg.T), market.r, market.q);
      return [{
        leg: p.leg, label: legLabel(leg), call: leg.call, K: leg.K, T: leg.T, weight: signedQty(leg) * M, bs,
        amFlat: flat.price, crr: labCurrent ? lab.perLeg[p.leg]?.american ?? null : null,
        crrEu: labCurrent ? lab.perLeg[p.leg]?.crr ?? null : null,
        euLv: lvEu?.price ?? null, amLv: lvAm?.price ?? null,
        eepFlat: flat.price - bs, eepLv: lvAm && lvEu ? lvAm.price - lvEu.price : null,
        todayFlat: today(flat.boundary), todayLv: today(lvAm?.boundary),
        boundaryFlat: flat.boundary, boundaryLv: lvAm?.boundary ?? null,
      }];
    });
  }, [batchCurrent, batchResult, plan, legs, market, surface, lab, labCurrent]);

  const eepFlat = rows.reduce((a, r) => a + r.weight * r.eepFlat, 0);
  const eepLv = surface ? rows.reduce((a, r) => a + r.weight * (r.eepLv ?? 0), 0) : null;
  const chartRow = rows.reduce<Row | null>((best, r) =>
    Math.max(r.eepFlat, r.eepLv ?? 0) > 1e-6 && (!best || Math.max(r.eepFlat, r.eepLv ?? 0) > Math.max(best.eepFlat, best.eepLv ?? 0)) ? r : best, null);
  // early-exercise premium against the lattice's own (American − European on the same lattice), which cancels its bias
  const latticeEep = (r: Row) => (r.crr != null && r.crrEu != null ? r.crr - r.crrEu : null);
  const lattice = rows.reduce((a, r) => { const e = latticeEep(r); return e == null ? a : Math.max(a, Math.abs(r.eepFlat - e)); }, 0);
  const reprice = surface ? rows.reduce((a, r) => Math.max(a, Math.abs((r.euLv ?? r.bs) - r.bs) / r.bs), 0) : null;
  // Longstaff–Schwartz on the chart's leg: an independent check of the PDE's American value, run on request
  const [lsm, setLsm] = useState<{ key: string; busy: boolean; run?: LsmResult & { ms: number }; error?: string } | null>(null);
  const lsmKey = chartRow ? `${key}|${chartRow.leg}` : '';
  const lsmRun = lsm && lsm.key === lsmKey ? lsm : null;
  const pdeAmerican = chartRow ? (surface ? chartRow.amLv ?? chartRow.amFlat : chartRow.amFlat) : null;
  const runLsm = async () => {
    if (!chartRow) return;
    const leg = legs[chartRow.leg];
    setLsm({ key: lsmKey, busy: true });
    try {
      const on: Market = surface ? market
        : { S: market.S, r: market.r, q: market.q, sigma: legSigma(market, leg.K, leg.T), smile: null, term: null };
      const run = await wasm.runLsm(leg.call, leg.K, leg.T, on, LSM.policyPaths, LSM.valuePaths, LSM.seed, LSM.dates, LSM.stepsPerYear);
      setLsm({ key: lsmKey, busy: false, run });
    } catch (err) {
      setLsm({ key: lsmKey, busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const status = wasm.status === 'loading' ? 'Loading the C++ WebAssembly engine…'
    : wasm.status === 'unavailable' ? 'WebAssembly could not load, so the finite-difference solver is unavailable.'
    : batch.error ? `Finite differences failed: ${batch.error}` : null;

  return (
    <div className={l.card} style={{ marginTop: 14 }} data-testid="lab-pde">
      <div className={l.cardHead}>
        <span className={l.cardTitle}>Early exercise {surface ? 'under the volatility surface' : ''} · finite differences</span>
        <span className={l.cardMeta}>
          {batch.busy ? 'solving…' : batch.result ? `C++ WebAssembly · BDF2 ${PDE_GRID.nodes} × ${PDE_GRID.steps} · ${batch.result.results.length} solves in ${fmtMs(batch.result.ms)}` : ''}
        </span>
      </div>
      {status ? <p className={ui.note}>{status}</p> : !rows.length ? (
        <p className={ui.note}>{items.length ? 'Solving each leg on a finite-difference grid…' : 'No leg has time left to expiry.'}</p>
      ) : (
        <div className={cx(!batch.current && l.stale)}>
          <div className={l.headline}>
            <span data-testid="lab-pde-headline" data-eep-flat={eepFlat} data-eep-lv={eepLv ?? ''}>
              {surface
                ? <>Early exercise adds <b className="mono">{usdSigned(eepLv ?? 0, 2)}</b> to the position under local volatility, against{' '}
                    <b className="mono">{usdSigned(eepFlat, 2)}</b> with each leg at its implied volatility.</>
                : <>Early exercise adds <b className="mono">{usdSigned(eepFlat, 2)}</b> to the position.</>}
            </span>
          </div>
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Leg (per share)</th>
                  <th className={ui.num}>American σ(K,T)</th>
                  {surface && <th className={ui.num}>European LV</th>}
                  {surface && <th className={ui.num}>American LV</th>}
                  <th className={ui.num}>Early exercise</th>
                  <th className={ui.num}>Exercise today</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const eepLattice = latticeEep(r);
                  return (
                    <tr key={`${r.leg}-${r.label}`} data-testid={`lab-pde-row-${r.leg}`} data-bs={r.bs} data-am-flat={r.amFlat}
                        data-crr={r.crr ?? ''} data-crr-eu={r.crrEu ?? ''} data-eu-lv={r.euLv ?? ''} data-am-lv={r.amLv ?? ''}>
                      <td className="mono">{r.label}</td>
                      <td className={ui.num}>
                        <span className={l.valueMain}>{r.amFlat.toFixed(4)}</span>
                        {eepLattice != null && <span className={l.valueSub}>lattice EEP {signed(r.eepFlat - eepLattice, 4)}</span>}
                      </td>
                      {surface && (
                        <td className={ui.num}>
                          <span className={l.valueMain}>{r.euLv!.toFixed(4)}</span>
                          <span className={l.valueSub}>vs BS {signed(((r.euLv! - r.bs) / r.bs) * 1e4, 1)} bp</span>
                        </td>
                      )}
                      {surface && <td className={ui.num}><span className={l.valueMain}>{r.amLv!.toFixed(4)}</span></td>}
                      <td className={ui.num}>
                        <span className={l.valueMain}>{signed(r.eepFlat, 4)}</span>
                        {surface && <span className={l.valueSub}>LV {signed(r.eepLv ?? 0, 4)}</span>}
                      </td>
                      <td className={ui.num}>
                        <span className={l.valueMain}>{r.call ? 'above ' : 'below '}{r.todayFlat != null ? usd(r.todayFlat, 2) : '—'}</span>
                        {surface && <span className={l.valueSub}>LV {r.todayLv != null ? usd(r.todayLv, 2) : 'none'}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {chartRow ? (
            <div style={{ marginTop: 10 }}>
              <div className={l.cardHead}>
                <span className={l.cardTitle}>Exercise boundary · {chartRow.label}</span>
                <span className={l.cardMeta}>spot at which exercising beats holding, by days to expiry</span>
              </div>
              <BoundaryChart row={chartRow} spot={market.S} />
            </div>
          ) : (
            <p className={ui.note}>No leg is worth exercising early: calls on an underlying without a dividend yield never are.</p>
          )}
          <p className={ui.note} style={{ marginTop: 8 }}>
            The local-volatility PDE in log spot, V_τ = ½σ²V_xx + (r − q − ½σ²)V_x − rV, solved with BDF2 on a time grid graded
            towards today (the smile makes local variance singular as t → 0) and the American constraint V ≥ intrinsic solved
            exactly at every step by policy iteration. LV is local volatility; EEP the early-exercise premium, American −
            European. Checks on these legs: the premium at σ(K, T) against the 512-step lattice’s own (its American −
            European, which cancels the lattice’s bias) within {num(lattice, 4)} per share
            {reprice != null && <>; the European under local volatility reprices each leg’s implied volatility within {num(reprice * 1e4, 1)} bp</>}.
            {surface && <> Close to today the local-volatility boundary drops steeply: the power-law smile makes short-dated
              local volatility very high away from the money, so holding a deep in-the-money option is worth more there.</>}
          </p>

          {chartRow && pdeAmerican != null && (
            <div className={l.engineBox} data-testid="lab-lsm">
              <strong>Longstaff–Schwartz check</strong>
              <Button size="sm" onClick={runLsm} disabled={!!lsmRun?.busy || wasm.status !== 'ready'} data-testid="lab-lsm-run">
                {lsmRun?.busy ? 'Simulating…' : `Value ${fmtPaths(LSM.valuePaths)} paths on a regression policy`}
              </Button>
              <span>
                {chartRow.label} · {LSM.dates} exercise dates · policy fitted on {fmtPaths(LSM.policyPaths)} separate paths · seed {LSM.seed}
              </span>
              {lsmRun?.run && (() => {
                const r = lsmRun.run!;
                const gap = r.price - pdeAmerican;
                const z = r.stdError > 0 ? gap / r.stdError : 0;
                const consistent = gap <= 4 * r.stdError && -gap <= 4 * r.stdError + 0.01 * pdeAmerican;
                return (
                  <>
                    <span data-testid="lab-lsm-result" data-price={r.price} data-se={r.stdError} data-european={r.european}
                          data-pde={pdeAmerican} data-z={z}>
                      American <b className="mono">{r.price.toFixed(4)}</b> ± {num(r.stdError, 4)} vs PDE {pdeAmerican.toFixed(4)}
                      {' '}({signed(gap, 4)}, {signed(z, 2)} SE) · European on the same paths {r.european.toFixed(4)} ± {num(r.europeanSe, 4)}
                      {' '}· {r.exerciseDates}/{r.dates} dates with an exercise rule · {r.steps} steps · {fmtMs(r.ms)}
                    </span>
                    <Badge tone={consistent ? 'good' : 'warn'}>{consistent ? 'Consistent with the PDE' : 'Outside the expected band'}</Badge>
                  </>
                );
              })()}
              {lsmRun?.error && <span className="neg">{lsmRun.error}</span>}
              <span>
                The policy is fitted on paths it never values, so this price is low biased: it should sit at the PDE’s value or a
                little below it — the gap is what discrete exercise dates cost.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
