'use client';

// Exotic options on the terminal's market — continuously monitored barriers and Asian options — priced three ways:
// the closed forms under flat volatility at the strike's implied volatility; the C++ Monte Carlo kernel under that
// same flat volatility, where it must agree with them; and the same kernel under the surface's Dupire local
// volatility, where no closed form exists. Monte Carlo runs on the native engine when it speaks protocol v7 and
// otherwise on the WebAssembly build in a worker; the closed forms are lib/quant/exotics.ts.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Market } from '@/lib/quant/types';
import { bsPrice } from '@/lib/quant/blackScholes';
import { hasVolSurface, legSigma } from '@/lib/quant/volSurface';
import type { ExoticMcResult, ExoticSpec } from '@/lib/quant/exotics';
import {
  barrierPrices, controlVariate, geometricAsianPrice, MAX_ASIAN_FIXINGS, MAX_BARRIER_LEVELS,
} from '@/lib/quant/exotics';
import { LV_MIN_STEPS, LV_STEPS_PER_YEAR, LV_WASM_WORK } from '@/lib/compute/tasks';
import type { Engine } from '@/lib/engine/useEngine';
import type { WasmEngine } from '@/lib/engine/useWasmEngine';
import { exoticWorkPerPath } from '@/lib/engine/wasm';
import { marketKeyOf } from '@/lib/strategy/labels';
import { num, pct, signed, usd } from '@/lib/format';
import { linear, niceTicks } from '@/components/charts/scale';
import { useElementWidth } from '@/components/ui/useElementWidth';
import type { Tone } from '@/components/ui/primitives';
import { Badge, Button, cx, InfoTip, Segmented, SliderField, ui } from '@/components/ui/primitives';
import { SeedInput } from '@/components/lab/SeedInput';
import { fmtMs, fmtPaths, Z95 } from '@/components/lab/labFormat';
import l from '@/components/lab/lab.module.css';
import css from './exotics.module.css';

type Product = 'barrier' | 'asian';
type Schedule = 'monthly' | 'weekly' | 'daily';
type Backend = 'native' | 'wasm';

const SCHEDULES: { value: Schedule; label: string; perYear: number }[] = [
  { value: 'monthly', label: 'Monthly', perYear: 12 },
  { value: 'weekly', label: 'Weekly', perYear: 52 },
  { value: 'daily', label: 'Daily', perYear: 365 },
];
const BACKEND_LABEL = { native: 'C++ native', wasm: 'C++ WebAssembly' } as const;

/**
 * Evaluations for one native run, sized for about 1.5 s on an 8-thread Apple M3: 1M paths of a 16-level, 91-day
 * local-vol barrier (1.4·10⁹ evaluations) took 4.6 s. The engine refuses more than 4·10⁹.
 */
const NATIVE_WORK = 5e8;
const MAX_PATHS = { native: 1_000_000, wasmFlat: 1_000_000, wasmLocal: 400_000 };
const DEBOUNCE_MS = 350;

interface Run extends ExoticMcResult { ms: number; backend: Backend; seed: number; }

interface Setup {
  key: string; product: Product; call: boolean; up: boolean; spec: ExoticSpec;
  S: number; r: number; q: number; K: number; H: number; hPct: number; T: number;
  fixings: number; schedule: Schedule; sigmaK: number; sigmaH: number;
  levels: number[]; hIndex: number;          // barrier levels simulated on the same paths, and the selected one
  market: Market; flatMarket: Market; surface: boolean; stepsPerYear: number; seed: number;
}

interface Results { key: string; setup: Setup; flat: Run | null; local: Run | null; error: string | null; }

interface Verdict { tone: Tone; text: string; }

interface Row {
  id: string; model: string; detail: string; cells: ReactNode[]; z: number | null; ms: number | null;
  verdict: Verdict; local?: boolean; attrs?: { [k: `data-${string}`]: number | undefined };
}

/** Up to 16 barrier levels on the knock-out side of spot, spread over about 2.5 standard deviations, including the selected level. */
function barrierLadder(S: number, H: number, up: boolean, sdT: number): number[] {
  const span = Math.min(0.5, Math.max(0.08, 2.5 * sdT));
  const lo = up ? 1.005 : 1 - span, hi = up ? 1 + span : 0.995;
  const n = MAX_BARRIER_LEVELS - 1;
  const ladder = Array.from({ length: n }, (_, i) => S * (lo + ((hi - lo) * i) / (n - 1)))
    .filter(v => Math.abs(v - H) > S * 0.004);
  return [...ladder, H].sort((a, b) => a - b);
}

function buildSetup(product: Product, call: boolean, up: boolean, kPct: number, hPct: number, dayCount: number,
                    schedule: Schedule, market: Market, seed: number): Setup {
  const { S, r, q } = market;
  const T = dayCount / 365, K = (S * kPct) / 100, H = (S * hPct) / 100;
  const sigmaK = legSigma(market, K, T), sigmaH = legSigma(market, H, T);
  const perYear = SCHEDULES.find(s => s.value === schedule)?.perYear ?? 52;
  const fixings = Math.min(MAX_ASIAN_FIXINGS, Math.max(1, Math.round(T * perYear)));
  const levels = product === 'barrier' ? barrierLadder(S, H, up, sigmaK * Math.sqrt(T)) : [];
  const spec: ExoticSpec = product === 'barrier'
    ? { kind: 'barrier', call, K, T, up, levels }
    : { kind: 'asian', call, K, T, fixings };
  return {
    key: [product, call, up, kPct, hPct, dayCount, schedule, marketKeyOf(market), seed].join('|'),
    product, call, up, spec, S, r, q, K, H, hPct, T, fixings, schedule, sigmaK, sigmaH,
    levels, hIndex: levels.indexOf(H), market,
    flatMarket: { S, r, q, sigma: sigmaK, smile: null, term: null },
    surface: hasVolSurface(market),
    stepsPerYear: Math.max(LV_STEPS_PER_YEAR, Math.ceil(LV_MIN_STEPS / T)),
    seed,
  };
}

/** Paths for one run: the backend's evaluation budget divided by the work per path, in steps of 10k. */
function pathsFor(backend: Backend, spec: ExoticSpec, m: Market, stepsPerYear: number, extrapolate: boolean): number {
  const work = exoticWorkPerPath(spec, m, stepsPerYear, extrapolate);
  const [budget, cap] = backend === 'native' ? [NATIVE_WORK, MAX_PATHS.native]
    : [LV_WASM_WORK, extrapolate && m.smile ? MAX_PATHS.wasmLocal : MAX_PATHS.wasmFlat];
  return Math.min(cap, Math.max(10_000, Math.floor(budget / work / 10_000) * 10_000));
}

const zOf = (v: number, ref: number, se: number): number =>
  se > 0 ? Math.abs(v - ref) / se : Math.abs(v - ref) <= 1e-9 * Math.max(1, Math.abs(ref)) ? 0 : Infinity;

const agreement = (z: number): Verdict =>
  z <= Z95 ? { tone: 'good', text: 'Within 95% CI' }
    : z <= 3 ? { tone: 'warn', text: 'Outside 95% CI this draw' } : { tone: 'bad', text: 'Beyond 3σ' };

const repricing = (z: number): Verdict =>
  z <= Z95 ? { tone: 'good', text: 'Reprices the vanilla' }
    : z <= 3 ? { tone: 'warn', text: 'Vanilla outside 95% CI this draw' } : { tone: 'bad', text: 'Vanilla beyond 3σ' };

const REFERENCE: Verdict = { tone: 'muted', text: 'Reference' };

/** A standard error to two significant digits and at least four decimals: ± 0.0345, ± 0.000034. */
const fmtSe = (se: number): string => num(se, se > 0 ? Math.min(8, Math.max(4, 1 - Math.floor(Math.log10(se)))) : 4);

function Price({ v, se }: { v: number | null | undefined; se?: number | null }) {
  if (v == null || !Number.isFinite(v)) return <span className={css.dash}>—</span>;
  return (
    <>
      <span className={l.valueMain}>{usd(v, 4)}</span>
      {se != null && <span className={l.valueSub}>± {fmtSe(se)}</span>}
    </>
  );
}

function runDetail(run: Run, what: string): string {
  return `${BACKEND_LABEL[run.backend]} · ${fmtPaths(run.paths)} paths · ${run.steps} step${run.steps === 1 ? '' : 's'}` +
    `${run.vanillaFineBias != null ? ' · Richardson' : ''} · ${what} · seed ${run.seed}`;
}

const pendingRow = (id: string, model: string, status: string, cells: number, local = false): Row => ({
  id, model, detail: '', z: null, ms: null, verdict: { tone: 'muted', text: 'Pending' }, local,
  cells: Array.from({ length: cells }, (_, i) => (i === 0
    ? <span key={i} className={css.pending}>{status}</span>
    : <span key={i} className={css.dash}>—</span>)),
});

function ResultTable({ testid, head, zTip, rows }: {
  testid: string; head: { label: string; tip?: string }[]; zTip: string; rows: Row[];
}) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table} data-testid={testid}>
        <thead>
          <tr>
            <th className={css.modelCol}>Model</th>
            {head.map(h => (
              <th key={h.label} className={ui.num}>{h.label}{h.tip && <> <InfoTip text={h.tip} align="end" /></>}</th>
            ))}
            <th className={ui.num}>|z| <InfoTip text={zTip} align="end" /></th>
            <th className={ui.num}>Time</th>
            <th>Check</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} data-testid={`exo-row-${row.id}`} data-z={row.z ?? undefined} {...row.attrs}
                className={row.local ? l.engineRow : undefined}>
              <td><span className={l.modelName}>{row.model}</span>{row.detail && <span className={l.modelDetail}>{row.detail}</span>}</td>
              {row.cells.map((c, i) => <td key={i} className={ui.num}>{c}</td>)}
              <td className={ui.num}>{row.z == null ? '—' : Number.isFinite(row.z) ? row.z.toFixed(2) : '∞'}</td>
              <td className={ui.num}>{row.ms == null ? '—' : fmtMs(row.ms)}</td>
              <td><Badge tone={row.verdict.tone}>{row.verdict.text}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className={l.mcStat}>
      <dt>{label}</dt>
      <dd>{value}</dd>
      <dd className={l.statSub}>{sub}</dd>
    </div>
  );
}

// ── Barrier ─────────────────────────────────────────────────────────────────

const BarrierChart = memo(function BarrierChart({ setup: s, flat, local }: { setup: Setup; flat: Run | null; local: Run | null }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrap, 640);
  const height = 240;
  const pad = { l: 58, r: 18, t: 16, b: 32 };
  const lo = s.up ? s.S : s.levels[0], hi = s.up ? s.levels[s.levels.length - 1] : s.S;
  const curves = useMemo(() => {
    const hs: number[] = [], atK: number[] = [], atH: number[] = [];
    for (let i = 0; i <= 120; i++) {
      const H = lo + ((hi - lo) * i) / 120;
      hs.push(H);
      atK.push(barrierPrices(s.call, s.up, s.S, s.K, H, s.T, s.sigmaK, s.r, s.q).out);
      if (s.surface) atH.push(barrierPrices(s.call, s.up, s.S, s.K, H, s.T, legSigma(s.market, H, s.T), s.r, s.q).out);
    }
    return { hs, atK, atH };
  }, [s, lo, hi]);
  const vanilla = bsPrice(s.call, s.S, s.K, s.T, s.sigmaK, s.r, s.q);
  const points = (run: Run | null) => (run ? s.levels.map((H, j) => ({ H, v: run.out[j], se: run.outSe[j] })) : []);
  const flatPts = points(flat), localPts = points(local);
  const top = (Math.max(vanilla, ...curves.atK, ...curves.atH, ...[...flatPts, ...localPts].map(p => p.v + Z95 * p.se)) * 1.08) || 1;
  const X = linear(lo, hi, pad.l, width - pad.r);
  const Y = linear(0, top, height - pad.b, pad.t);
  const path = (ys: number[]) => ys.map((y, i) => `${i ? 'L' : 'M'}${X(curves.hs[i]).toFixed(1)},${Y(y).toFixed(1)}`).join('');
  const name = `${s.up ? 'up' : 'down'}-and-out ${s.call ? 'call' : 'put'}`;

  return (
    <div ref={wrap} data-testid="exo-chart" data-levels={s.levels.length} data-points={(local ?? flat)?.out.length ?? 0}>
      <svg className={l.chartSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
           aria-label={`Knock-out value per share of a ${name} struck at ${pct(s.K / s.S, 1)} of spot against the barrier level, from ${pct(lo / s.S, 1)} to ${pct(hi / s.S, 1)} of spot: the closed form at the strike’s implied volatility${s.surface ? ' and at each barrier’s implied volatility' : ''}, and Monte Carlo ${local ? 'under flat and local volatility' : 'under flat volatility'}.`}>
        {niceTicks(0, top, 4).map(t => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--line)" />
            <text x={pad.l - 8} y={Y(t) + 3.5} textAnchor="end" className={l.axis}>{`$${num(t, top < 20 ? 2 : 0)}`}</text>
          </g>
        ))}
        {niceTicks((lo / s.S) * 100, (hi / s.S) * 100, 5).map(t => (
          <text key={t} x={X((t / 100) * s.S)} y={height - 10} textAnchor="middle" className={l.axis}>{t === 100 ? 'spot' : `${t}%`}</text>
        ))}
        <line x1={pad.l} x2={width - pad.r} y1={Y(vanilla)} y2={Y(vanilla)} stroke="var(--ink-4)" strokeDasharray="2 3" />
        <text x={width - pad.r} y={Y(vanilla) - 5} textAnchor="end" className={l.axis}>vanilla</text>
        <line x1={X(s.H)} x2={X(s.H)} y1={pad.t} y2={height - pad.b} stroke="var(--amber)" strokeDasharray="3 3" opacity={0.7} />
        {s.surface && <path d={path(curves.atH)} fill="none" stroke="var(--blue)" strokeWidth={1.2} strokeDasharray="5 3" opacity={0.85} />}
        <path d={path(curves.atK)} fill="none" stroke="var(--blue)" strokeWidth={1.6} />
        {flatPts.map(p => (
          <circle key={`f${p.H}`} cx={X(p.H)} cy={Y(p.v)} r={3} fill="var(--bg-raise)" stroke="var(--blue)" strokeWidth={1.3} />
        ))}
        {localPts.map(p => (
          <g key={`l${p.H}`}>
            <line x1={X(p.H)} x2={X(p.H)} y1={Y(p.v - Z95 * p.se)} y2={Y(p.v + Z95 * p.se)} stroke="var(--amber-2)" strokeWidth={1.2} />
            <circle cx={X(p.H)} cy={Y(p.v)} r={3.2} fill="var(--amber-2)" />
          </g>
        ))}
      </svg>
      <div className={l.legend} aria-hidden="true">
        <span><i className={l.sw} style={{ background: 'var(--blue)' }} />Closed form at σ(K)</span>
        {s.surface && <span><i className={l.swDash} style={{ borderColor: 'var(--blue)' }} />Closed form at σ(H)</span>}
        <span><i className={css.ring} />Monte Carlo · flat σ(K)</span>
        {s.surface && <span><i className={css.dot} />Local vol · 95% CI</span>}
        <span><i className={l.swDash} />Vanilla at σ(K)</span>
      </div>
    </div>
  );
});

function BarrierView({ view, pendingText }: { view: Results; pendingText: string }) {
  const { setup: s, flat, local } = view;
  const j = s.hIndex;
  const name = `${s.up ? 'up' : 'down'}-and-out ${s.call ? 'call' : 'put'}`;
  const cfK = barrierPrices(s.call, s.up, s.S, s.K, s.H, s.T, s.sigmaK, s.r, s.q);
  const cfH = barrierPrices(s.call, s.up, s.S, s.K, s.H, s.T, s.sigmaH, s.r, s.q);
  const gap = (v: number, se: number | null) => (
    <>
      <span className={l.valueMain}>{signed(v - cfK.out, 4)}</span>
      {se != null && se > 0 && <span className={l.valueSub}>{signed((v - cfK.out) / se, 1)} SE</span>}
    </>
  );

  const rows: Row[] = [
    { id: 'bs-k', model: `Black-Scholes · σ(K) ${pct(s.sigmaK, 2)}`, detail: 'Reiner–Rubinstein closed form · reference',
      cells: [<Price key="out" v={cfK.out} />, <Price key="in" v={cfK.in} />, <Price key="van" v={cfK.vanilla} />,
              <span key="gap" className={css.dash}>—</span>],
      z: null, ms: null, verdict: REFERENCE },
  ];
  if (s.surface) {
    rows.push({ id: 'bs-h', model: `Black-Scholes · σ(H) ${pct(s.sigmaH, 2)}`, detail: 'closed form at the barrier’s implied volatility',
                cells: [<Price key="out" v={cfH.out} />, <Price key="in" v={cfH.in} />, <Price key="van" v={cfH.vanilla} />,
                        gap(cfH.out, null)],
                z: null, ms: null, verdict: { tone: 'muted', text: 'Heuristic' } });
  }
  let flatZ: number | null = null;
  if (flat) {
    flatZ = Math.max(zOf(flat.out[j], cfK.out, flat.outSe[j]), zOf(flat.in[j], cfK.in, flat.inSe[j]));
    rows.push({ id: 'mc-flat', model: 'Monte Carlo · flat σ(K)', detail: runDetail(flat, 'Brownian bridge'),
                cells: [<Price key="out" v={flat.out[j]} se={flat.outSe[j]} />, <Price key="in" v={flat.in[j]} se={flat.inSe[j]} />,
                        <Price key="van" v={flat.vanilla} se={flat.vanillaSe} />, gap(flat.out[j], flat.outSe[j])],
                z: flatZ, ms: flat.ms, verdict: agreement(flatZ) });
  } else {
    rows.push(pendingRow('mc-flat', 'Monte Carlo · flat σ(K)', pendingText, 4));
  }
  let headline: ReactNode = null;
  if (s.surface && local) {
    const z = zOf(local.vanilla, cfK.vanilla, local.vanillaSe);
    const d = local.out[j] - cfK.out, dz = local.outSe[j] > 0 ? d / local.outSe[j] : 0;
    rows.push({ id: 'local', model: 'Local vol (Dupire)', detail: runDetail(local, 'bridge at the step’s local variance'),
                cells: [<Price key="out" v={local.out[j]} se={local.outSe[j]} />, <Price key="in" v={local.in[j]} se={local.inSe[j]} />,
                        <Price key="van" v={local.vanilla} se={local.vanillaSe} />, gap(local.out[j], local.outSe[j])],
                z, ms: local.ms, verdict: repricing(z), local: true, attrs: { 'data-gap': d, 'data-gap-z': dz } });
    headline = (
      <span>
        Under local volatility the {name} is worth <b className="mono">{usd(local.out[j], 4)}</b> against {usd(cfK.out, 4)} at
        the strike’s implied volatility:{' '}
        <b className="mono" data-testid="exo-gap" data-value={d} data-z={dz}>{signed(d, 4)}</b> ({signed(dz, 1)} standard errors),
        while its vanilla on the same paths reprices within {z.toFixed(2)} standard errors.
      </span>
    );
  } else if (s.surface) {
    rows.push(pendingRow('local', 'Local vol (Dupire)', flat ? pendingText : 'after the flat run', 4, true));
  } else if (flatZ != null) {
    headline = (
      <span>
        The Brownian-bridge Monte Carlo sits <b className="mono">{flatZ.toFixed(2)}</b> standard errors from the
        Reiner–Rubinstein closed form for the {name}.
      </span>
    );
  }
  const shown = local ?? flat;
  const bias = local?.outFineBias[j];

  return (
    <>
      {headline && <div className={l.headline}>{headline}</div>}
      <ResultTable testid="exo-table" rows={rows}
                   head={[{ label: 'Knock-out' }, { label: 'Knock-in' }, { label: 'Vanilla' },
                          { label: 'Knock-out vs σ(K)', tip: 'Difference from the closed form at the strike’s implied volatility; for Monte Carlo rows also in standard errors.' }]}
                   zTip="Flat Monte Carlo: distance from the closed form in standard errors, the larger of knock-out and knock-in. Local vol: its vanilla on the same paths against Black-Scholes at σ(K) — a local-volatility model must reprice vanillas." />
      {!s.surface && (
        <p className={css.note} data-testid="exo-flat-note">
          With flat volatility, local volatility is σ everywhere and the closed form is the answer. Choose a smile or term
          structure under Market inputs to price the barrier under the surface’s local volatility.
        </p>
      )}
      <div className={l.card} style={{ marginTop: 14 }}>
        <div className={l.cardHead}>
          <span className={l.cardTitle}>Knock-out value against the barrier level</span>
          <span className={l.cardMeta}>{s.levels.length} levels on the same paths · per share</span>
        </div>
        <BarrierChart setup={s} flat={flat} local={local} />
      </div>
      <dl className={l.mcStats}>
        <Stat label="Barrier" value={usd(s.H, 2)} sub={`${num(s.hPct, 1)}% of spot · ${s.up ? 'above' : 'below'}`} />
        <Stat label="Implied volatility" value={`${pct(s.sigmaK, 2)} at K`} sub={`${pct(s.sigmaH, 2)} at H`} />
        <Stat label="Simulation" value={shown ? `${fmtPaths(shown.paths)} paths` : '—'}
              sub={shown ? `${shown.steps} step${shown.steps === 1 ? '' : 's'} · ${BACKEND_LABEL[shown.backend]}` : pendingText} />
        <Stat label="Fine-grid bias" value={bias != null ? signed(bias, 4) : '—'}
              sub={bias != null ? 'coarse − fine, knock-out' : s.surface ? 'no smile: exact variance steps' : 'exact bridge under flat σ'} />
      </dl>
    </>
  );
}

// ── Asian ───────────────────────────────────────────────────────────────────

function AsianView({ view, pendingText }: { view: Results; pendingText: string }) {
  const { setup: s, flat, local } = view;
  const kind = s.call ? 'call' : 'put';
  const geoCf = geometricAsianPrice(s.call, s.S, s.K, s.T, s.fixings, s.sigmaK, s.r, s.q);
  const vanCf = bsPrice(s.call, s.S, s.K, s.T, s.sigmaK, s.r, s.q);
  const cv = flat ? controlVariate(flat, geoCf) : null;

  const rows: Row[] = [
    { id: 'cf', model: `Closed form · σ(K) ${pct(s.sigmaK, 2)}`, detail: `geometric average · ${s.fixings} fixings · reference`,
      cells: [<span key="arith" className={css.dash}>—</span>, <span key="cv" className={css.dash}>—</span>,
              <Price key="geo" v={geoCf} />, <Price key="van" v={vanCf} />],
      z: null, ms: null, verdict: REFERENCE },
  ];
  let flatZ: number | null = null;
  if (flat) {
    flatZ = flat.geo != null && flat.geoSe != null ? zOf(flat.geo, geoCf, flat.geoSe) : Infinity;
    rows.push({ id: 'mc-flat', model: 'Monte Carlo · flat σ(K)', detail: runDetail(flat, `${s.fixings} fixings`),
                cells: [<Price key="arith" v={flat.arith} se={flat.arithSe} />,
                        cv ? <Price key="cv" v={cv.value} se={cv.se} /> : <span key="cv" className={css.dash}>—</span>,
                        <Price key="geo" v={flat.geo} se={flat.geoSe} />, <Price key="van" v={flat.vanilla} se={flat.vanillaSe} />],
                z: flatZ, ms: flat.ms, verdict: agreement(flatZ),
                attrs: { 'data-arith-se': flat.arithSe ?? undefined, 'data-cv-se': cv?.se } });
  } else {
    rows.push(pendingRow('mc-flat', 'Monte Carlo · flat σ(K)', pendingText, 4));
  }
  let headline: ReactNode = null;
  if (s.surface && local) {
    const z = zOf(local.vanilla, vanCf, local.vanillaSe);
    rows.push({ id: 'local', model: 'Local vol (Dupire)', detail: runDetail(local, `${s.fixings} fixings`),
                cells: [<Price key="arith" v={local.arith} se={local.arithSe} />, <span key="cv" className={css.dash}>—</span>,
                        <Price key="geo" v={local.geo} se={local.geoSe} />, <Price key="van" v={local.vanilla} se={local.vanillaSe} />],
                z, ms: local.ms, verdict: repricing(z), local: true });
    if (cv && local.arith != null && local.arithSe != null) {
      const d = local.arith - cv.value, dz = d / Math.hypot(local.arithSe, cv.se);
      headline = (
        <span>
          Under local volatility the arithmetic-average {kind} is worth <b className="mono">{usd(local.arith, 4)}</b> against{' '}
          {usd(cv.value, 4)} under flat σ(K):{' '}
          <b className="mono" data-testid="exo-gap" data-value={d} data-z={dz}>{signed(d, 4)}</b> ({signed(dz, 1)} standard errors),
          while its vanilla on the same paths reprices within {z.toFixed(2)} standard errors.
        </span>
      );
    }
  } else if (s.surface) {
    rows.push(pendingRow('local', 'Local vol (Dupire)', flat ? pendingText : 'after the flat run', 4, true));
  } else if (flat && cv && flat.arithSe != null && flatZ != null) {
    headline = (
      <span>
        The geometric average sits <b className="mono">{flatZ.toFixed(2)}</b> standard errors from its closed form; as a control
        variate it cuts the arithmetic average’s standard error{' '}
        <b className="mono">{(flat.arithSe / Math.max(cv.se, 1e-300)).toFixed(0)}×</b>, from ±{num(flat.arithSe, 4)} to ±{num(cv.se, 5)}.
      </span>
    );
  }
  const avg = local ?? flat;
  const discount = avg && avg.arith != null && avg.vanilla > 0 ? 1 - avg.arith / avg.vanilla : null;
  const scheduleLabel = SCHEDULES.find(x => x.value === s.schedule)?.label.toLowerCase() ?? '';

  return (
    <>
      {headline && <div className={l.headline}>{headline}</div>}
      <ResultTable testid="exo-table" rows={rows}
                   head={[{ label: 'Arithmetic' },
                          { label: 'Control variate', tip: 'The arithmetic average with the geometric average as control variate (Kemna–Vorst): exact under flat volatility, where the geometric price is known. Not used under local volatility, where it is not.' },
                          { label: 'Geometric' }, { label: 'Vanilla' }]}
                   zTip="Flat Monte Carlo: the geometric average against its closed form. Local vol: its vanilla on the same paths against Black-Scholes at σ(K) — a local-volatility model must reprice vanillas." />
      {!s.surface && (
        <p className={css.note} data-testid="exo-flat-note">
          With flat volatility, local volatility is σ everywhere. Choose a smile or term structure under Market inputs to price the
          average under the surface’s local volatility.
        </p>
      )}
      <dl className={l.mcStats}>
        <Stat label="Fixings" value={s.fixings} sub={`${scheduleLabel} · the last at expiry`} />
        <Stat label="Averaging discount" value={discount != null ? pct(discount, 1) : '—'}
              sub={avg ? `arithmetic vs vanilla · ${local ? 'local vol' : 'flat σ(K)'}` : pendingText} />
        <Stat label="Control variate" value={cv && flat?.arithSe ? `${(flat.arithSe / Math.max(cv.se, 1e-300)).toFixed(0)}× smaller SE` : '—'}
              sub={cv ? `β ${num(cv.beta, 3)} · flat σ(K)` : pendingText} />
        <Stat label="Fine-grid bias" value={local?.arithFineBias != null ? signed(local.arithFineBias, 4) : '—'}
              sub={local?.arithFineBias != null ? 'coarse − fine, arithmetic' : 'exact steps without a smile'} />
      </dl>
    </>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function ExoticsPanel({ market, engine, wasm, active }: { market: Market; engine: Engine; wasm: WasmEngine; active: boolean }) {
  const [product, setProduct] = useState<Product>('barrier');
  const [call, setCall] = useState(true);
  const [up, setUp] = useState(false);
  const [kPct, setKPct] = useState(100);
  const [hPct, setHPct] = useState(90);
  const [dayCount, setDayCount] = useState(91);
  const [schedule, setSchedule] = useState<Schedule>('weekly');
  const [seed, setSeed] = useState(11);

  const native = engine.status === 'connected' && (engine.info?.protocol ?? 0) >= 7;
  const backend: Backend | null = native ? 'native' : wasm.status === 'ready' ? 'wasm' : null;
  const setup = useMemo(() => buildSetup(product, call, up, kPct, hPct, dayCount, schedule, market, seed),
                        [product, call, up, kPct, hPct, dayCount, schedule, market, seed]);
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const key = `${setup.key}|${backend ?? 'none'}`;

  const { runExoticMc: runNative } = engine;
  const { runExoticMc: runWasm } = wasm;
  const simulate = useCallback((be: Backend, spec: ExoticSpec, m: Market, s: number, stepsPerYear: number, extrapolate: boolean) => {
    const paths = pathsFor(be, spec, m, stepsPerYear, extrapolate);
    return (be === 'native' ? runNative(spec, m, paths, s, stepsPerYear, extrapolate) : runWasm(spec, m, paths, s, stepsPerYear, extrapolate))
      .then((res): Run => ({ ...res, backend: be, seed: s }));
  }, [runNative, runWasm]);

  // Latest request wins: a run starts after the inputs settle, and a run for superseded inputs never lands.
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !backend || started.current === key) return;
    const timer = setTimeout(async () => {
      const s = setupRef.current, id = ++seq.current;
      started.current = key;
      setBusy(true);
      try {
        // flat volatility first: exact with one step (the bridge) or one step per fixing
        const flat = await simulate(backend, s.spec, s.flatMarket, s.seed, 1, false);
        if (id !== seq.current) return;
        setResults({ key, setup: s, flat, local: null, error: null });
        if (s.surface) {
          const local = await simulate(backend, s.spec, s.market, s.seed + 1, s.stepsPerYear, true);
          if (id !== seq.current) return;
          setResults({ key, setup: s, flat, local, error: null });
        }
      } catch (err) {
        if (id !== seq.current) return;
        started.current = null;
        setResults({ key, setup: s, flat: null, local: null, error: err instanceof Error ? err.message : String(err) });
      } finally {
        if (id === seq.current) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, backend, key, simulate]);

  const shown = results && results.setup.product === setup.product ? results : null;
  const view: Results = shown ?? { key, setup, flat: null, local: null, error: null };
  const stale = !!shown && shown.key !== key;
  const pendingText = backend ? 'simulating…' : wasm.status === 'loading' ? 'loading WebAssembly…' : 'no Monte Carlo engine';
  const total = (view.flat?.ms ?? 0) + (view.local?.ms ?? 0);
  const backendText = native ? `native C++ engine · CPU, ${engine.info?.cpuThreads ?? 'all'} threads`
    : backend ? 'C++ WebAssembly · single-threaded, in a worker'
    : wasm.status === 'loading' ? 'Loading the C++ WebAssembly engine…'
    : `No native engine is connected and WebAssembly could not load${wasm.error ? `: ${wasm.error}` : ''}`;
  const pctAndUsd = (v: number) => `${num(v, 1)}% · ${usd((market.S * v) / 100, 2)}`;

  return (
    <div>
      <p className={l.intro}>
        Path-dependent options on the terminal’s market, per share. Barriers are monitored continuously and pay no rebate;
        Asian options average on equally spaced fixings, the last at expiry. The closed forms assume one flat volatility. The
        same C++ Monte Carlo kernel runs under that volatility, where it must agree with them, and under the surface’s Dupire
        local volatility — the one diffusion consistent with every vanilla on the surface — where no closed form exists.
      </p>

      <div className={css.pickers}>
        <Segmented size="sm" accent label="Product" testid="exo-product" value={product}
                   options={[{ value: 'barrier', label: 'Barrier' }, { value: 'asian', label: 'Asian' }]} onChange={setProduct} />
        <Segmented size="sm" label="Option type" testid="exo-type" value={call ? 'call' : 'put'}
                   options={[{ value: 'call', label: 'Call' }, { value: 'put', label: 'Put' }]} onChange={v => setCall(v === 'call')} />
        {product === 'barrier' ? (
          <Segmented size="sm" label="Barrier side" testid="exo-side" value={up ? 'up' : 'down'}
                     options={[{ value: 'down', label: 'Down-and-out' }, { value: 'up', label: 'Up-and-out' }]}
                     onChange={v => {
                       if ((v === 'up') === up) return;
                       setUp(v === 'up');
                       setHPct(p => 200 - p);   // mirror the barrier to the other side of spot
                     }} />
        ) : (
          <Segmented size="sm" label="Fixing schedule" testid="exo-fixings" value={schedule}
                     options={SCHEDULES.map(x => ({ value: x.value, label: x.label }))} onChange={setSchedule} />
        )}
        <SeedInput value={seed} onChange={setSeed} testid="exo-seed" />
        <Button size="sm" variant="ghost" data-testid="exo-reseed"
                onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}>New draw</Button>
        <span className={l.status} data-testid="exo-status">
          {busy ? <><span className={l.spinner} aria-hidden="true" />Simulating…</>
            : view.flat ? `${fmtMs(total)} Monte Carlo` : ''}
        </span>
      </div>

      <div className={css.inputs}>
        <SliderField label="Strike" symbol="K" value={kPct} min={50} max={150} step={0.5} format={pctAndUsd}
                     onChange={setKPct} inputDecimals={1} testid="exo-k" displayTestid="exo-k-display" rangeLabels={['50%', '150%']} />
        {product === 'barrier' && (
          <SliderField label="Barrier" symbol="H" value={hPct} min={up ? 100.5 : 50} max={up ? 150 : 99.5} step={0.5}
                       format={pctAndUsd} onChange={setHPct} inputDecimals={1} testid="exo-h" displayTestid="exo-h-display"
                       tip="Monitored continuously: the option is extinguished the first time the price trades through the barrier."
                       rangeLabels={up ? ['100.5%', '150%'] : ['50%', '99.5%']} />
        )}
        <SliderField label="Expiry" symbol="T" value={dayCount} min={7} max={730} step={1} format={v => `${v} days`}
                     onChange={v => setDayCount(Math.round(v))} inputDecimals={0} testid="exo-days" displayTestid="exo-days-display"
                     rangeLabels={['7d', '2y']} />
      </div>

      <div className={l.engineBox} style={{ marginTop: 0, marginBottom: 12 }}>
        <strong>Monte Carlo engine</strong>
        <span data-testid="exo-backend">{backendText}</span>
        {backend && <span>seed {seed} flat · {seed + 1} local vol</span>}
      </div>

      {view.error && <p className="neg" role="status" data-testid="exo-error">{view.error}</p>}

      <div className={cx(stale && l.stale)} data-testid="exo-results" data-stale={stale}>
        {view.setup.product === 'barrier'
          ? <BarrierView view={view} pendingText={pendingText} />
          : <AsianView view={view} pendingText={pendingText} />}
      </div>

      <details className={l.formulas}>
        <summary>Exotic formulas and assumptions</summary>
        <div className={l.formulaGrid}>
          <div className={l.formula}>
            <h4>Barrier · Reiner–Rubinstein</h4>
            <pre>{`down-and-out call, K > H:  C = A − C₂
down-and-out call, K ≤ H:  C = B − D
up-and-out call,   K < H:  C = A − B + C₂ − D
knock-in = vanilla − knock-out   (no rebate)`}</pre>
            <p>
              Continuous monitoring, one flat volatility, continuous dividend yield (Haug, §4.17). The unit tests check every type
              against a Crank–Nicolson solver of the Black-Scholes PDE with an absorbing barrier.
            </p>
          </div>
          <div className={l.formula}>
            <h4>Brownian-bridge monitoring</h4>
            <pre>{`h = ln H;  x₀, x₁ = log price at a step's ends
P(no touch) = 1 − exp(−2(x₀ − h)(x₁ − h) / σ²Δt)
knock-out payoff × Π over steps P(no touch)`}</pre>
            <p>
              Exact under flat volatility, so one step prices the barrier. Under local volatility the step’s local variance stands
              in for σ²Δt; that error shrinks with the step, and 2·fine − coarse is applied to the barrier payoffs as to the vanilla.
            </p>
          </div>
          <div className={l.formula}>
            <h4>Asian · geometric closed form, control variate</h4>
            <pre>{`ln G ~ N(ln S + (r − q − σ²/2)·T(n+1)/2n,  σ²T(n+1)(2n+1)/6n²)
Â = Ā − β(Ḡ − G*),   β = Cov(A, G) / Var(G)
SE(Â) = √((Var A − Cov²/Var G) / N)`}</pre>
            <p>
              Fixings at T·i/n. The geometric price G* is exact only under flat volatility, so the control variate is applied there
              and not under local volatility.
            </p>
          </div>
          <div className={l.formula}>
            <h4>Local volatility</h4>
            <pre>{`dS/S = (r − q)·dt + σ_loc(S, t)·dW
σ_loc² = ∂T w / g(k)    (Dupire, on the SSVI surface)
V = 2·V_fine − V_coarse (same Brownian increments)`}</pre>
            <p>
              Log-Euler at {LV_STEPS_PER_YEAR} steps a year (at least {LV_MIN_STEPS}), with every barrier level and fixing on the same
              paths; without a smile each step’s variance is exact. The coarse − fine gap estimates the fine grid’s own bias.
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
