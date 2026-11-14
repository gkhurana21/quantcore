'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import { hasVolSurface } from '@/lib/quant/volSurface';
import type { LabResult, LocalVolRequest } from '@/lib/compute/tasks';
import {
  LAB_PATHS, localVolStepsPerYear, localVolWasmPaths, LV_MIN_STEPS, LV_NATIVE_PATHS, LV_PATHS, LV_STEPS_PER_YEAR,
} from '@/lib/compute/tasks';
import type { WorkerTaskState } from '@/lib/compute/useWorkerTask';
import { useWorkerTask } from '@/lib/compute/useWorkerTask';
import type { Engine } from '@/lib/engine/useEngine';
import type { WasmEngine } from '@/lib/engine/useWasmEngine';
import { legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { signed, usd, usdSigned } from '@/lib/format';
import type { Tone } from '@/components/ui/primitives';
import { Badge, Button, cx, InfoTip, Segmented, ui } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/Skeleton';
import { ConvergenceChart, CrrChart } from './ConvergenceChart';
import { EarlyExercise } from './EarlyExercise';
import { GreeksLadder } from './GreeksLadder';
import { SeedInput } from './SeedInput';
import { fmtMs, fmtPaths, Z95 } from './labFormat';
import l from './lab.module.css';

const ENGINE_PATHS = 1_000_000;

interface Verdict { tone: Tone; text: string; }

const mcVerdict = (z: number): Verdict =>
  z <= Z95 ? { tone: 'good', text: 'Within 95% CI' }
    : z <= 3 ? { tone: 'warn', text: 'Outside 95% CI this draw' }
    : { tone: 'bad', text: 'Beyond 3σ' };

interface Row {
  id: string; model: string; detail: string; value: number; se: number | null;
  ms: number; z: number | null; verdict: Verdict; engine?: boolean;
}

/** A C++ Monte Carlo run of the whole portfolio ($ value). */
interface EngineRun { price: number; stdError: number; paths: number; ms: number; native: boolean; }

/** A local-volatility run of the portfolio ($ value), from whichever backend ran it. */
interface LocalVolRun {
  price: number; se: number; paths: number; steps: number; ms: number;
  fineBias: number | null;   // null without extrapolation (no smile: exact variance steps)
  seed: number;
  backend: 'native' | 'wasm' | 'ts';
}

const LV_BACKEND_LABEL = { native: 'C++ native', wasm: 'C++ WebAssembly', ts: 'TypeScript' } as const;

function buildRows(r: LabResult): Row[] {
  const ref = r.bs.value;
  return [
    { id: 'bs', model: 'Black-Scholes-Merton', detail: 'closed form · reference', value: ref, se: null,
      ms: r.bs.ms, z: null, verdict: { tone: 'muted', text: 'Reference' } },
    { id: 'crr', model: 'Binomial CRR', detail: `${r.crr.steps}-step lattice`, value: r.crr.value, se: null,
      ms: r.crr.ms, z: null, verdict: { tone: 'muted', text: 'Lattice O(1/N) error' } },
    ...r.mc.map((run, i): Row => {
      const z = run.se > 0 ? Math.abs(run.price - ref) / run.se : 0;
      return { id: `mc${LAB_PATHS[i] / 1000}k`, model: `Monte Carlo · ${fmtPaths(run.paths)}`,
               detail: `seed ${run.seed}${run.antithetic ? ' · antithetic' : ''}`,
               value: run.price, se: run.se, ms: run.ms, z, verdict: mcVerdict(z) };
    }),
  ];
}

/** The TypeScript fallback, in its own worker — mounted only while it runs, when no C++ backend is available. */
function TsLocalVolRun({ job, onDone }: {
  job: { id: string; req: LocalVolRequest };
  onDone: (res: LocalVolRun | null, error: string | null) => void;
}) {
  const task = useWorkerTask('localvol', job.req, job.id, 0);
  useEffect(() => {
    if (task.resultKey !== job.id) return;
    const res = task.result;
    onDone(!task.error && res ? { price: res.price, se: res.se, paths: res.paths, steps: res.steps, ms: res.ms,
                                  fineBias: res.fineBias, seed: res.seed, backend: 'ts' } : null, task.error);
  }, [job.id, task.resultKey, task.result, task.error, onDone]);
  return null;
}

/**
 * Prices the portfolio under Dupire local volatility on request: the native C++ engine (multithreaded) when it speaks
 * protocol v6, otherwise the same C++ kernel in WebAssembly, and the TypeScript kernel only when neither is available.
 * Mounted only when the market has a smile or term structure.
 */
function LocalVolCheck({ legs, market, seed, runKey, stale, engine, wasm, onResult }: {
  legs: Leg[]; market: Market; seed: number; runKey: string; stale: boolean; engine: Engine; wasm: WasmEngine;
  onResult: (key: string, res: LocalVolRun) => void;
}) {
  const native = engine.status === 'connected' && (engine.info?.protocol ?? 0) >= 6;
  const inWasm = !native && wasm.status === 'ready';
  const stepsPerYear = localVolStepsPerYear(legs);
  const paths = native ? LV_NATIVE_PATHS : inWasm ? localVolWasmPaths(legs, stepsPerYear) : LV_PATHS;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tsJob, setTsJob] = useState<{ id: string; runKey: string; req: LocalVolRequest } | null>(null);
  const onTsDone = useCallback((res: LocalVolRun | null, err: string | null) => {
    setTsJob(job => {
      if (job && res) onResult(job.runKey, res);
      return null;
    });
    setError(err);
  }, [onResult]);

  const run = async () => {
    setError(null);
    if (!native && !inWasm) {
      setTsJob({ id: `${runKey}|${Date.now()}`, runKey, req: { legs, market, seed } });
      return;
    }
    setBusy(true);
    try {
      const res = native
        ? await engine.runLocalVolMc(legs, market, paths, seed, stepsPerYear, true)
        : await wasm.runLocalVolMc(legs, market, paths, seed, stepsPerYear, true);
      onResult(runKey, { price: res.price, se: res.stdError, paths: res.paths, steps: res.steps, ms: res.ms,
                         fineBias: res.fineBias, seed, backend: native ? 'native' : 'wasm' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const running = busy || !!tsJob;

  return (
    <div className={l.engineBox} data-testid="lab-localvol">
      <strong>Local volatility cross-check</strong>
      <Button size="sm" onClick={run} disabled={running} data-testid="lab-localvol-run">
        {running ? 'Simulating local-vol paths…' : `Simulate ${fmtPaths(paths)} local-volatility paths`}
      </Button>
      <span data-testid="lab-localvol-backend">
        {native ? `native C++ engine · CPU, ${engine.info?.cpuThreads ?? 'all'} threads`
          : inWasm ? 'C++ WebAssembly · single-threaded, in a worker' : 'TypeScript · in a worker'} · seed {seed}
      </span>
      <span>
        σ_loc(S, t) from Dupire’s formula on this surface · log-Euler at {LV_STEPS_PER_YEAR} steps a year (at least {LV_MIN_STEPS}),
        Richardson-extrapolated over a coupled half-step grid · one diffusion for every leg, so it must reprice each at its own
        implied volatility
      </span>
      {error && <span className="neg">{error}</span>}
      {stale && !running && <span>Inputs changed since the last local-vol run.</span>}
      {tsJob && <TsLocalVolRun job={tsJob} onDone={onTsDone} />}
    </div>
  );
}

/** The scale every row's interval is drawn on: wide enough for every value, its interval and the reference. */
function agreementSpan(rows: Row[], reference: number): [number, number] {
  const vals = [reference];
  for (const row of rows) {
    vals.push(row.value);
    if (row.se != null) vals.push(row.value - Z95 * row.se, row.value + Z95 * row.se);
  }
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.12, Math.abs(reference) * 2e-4, 1e-6);
  return [lo - pad, hi + pad];
}

const AGREE_W = 208, AGREE_H = 34;

/**
 * One row's price against the closed form: the dashed line is Black-Scholes, the dot is this
 * model's value, the whisker its 95% interval. Convergence is then something you see rather than
 * something you work out from four columns of numbers.
 */
function Agreement({ value, se, reference, span, accent }: {
  value: number; se: number | null; reference: number; span: [number, number]; accent?: boolean;
}) {
  const x = (v: number) => 4 + ((v - span[0]) / (span[1] - span[0] || 1)) * (AGREE_W - 8);
  const ci = se == null ? null : [value - Z95 * se, value + Z95 * se] as const;
  const label = se == null
    ? `${usd(value, 2)} against the reference ${usd(reference, 2)}`
    : `${usd(value, 2)}, 95% interval ${usd(value - Z95 * se, 2)} to ${usd(value + Z95 * se, 2)}, against the reference ${usd(reference, 2)}`;
  return (
    <svg width={AGREE_W} height={AGREE_H} viewBox={`0 0 ${AGREE_W} ${AGREE_H}`} role="img" aria-label={label}
         className={l.agree}>
      <line x1={x(reference)} x2={x(reference)} y1={0} y2={AGREE_H} stroke="var(--amber)" strokeOpacity={0.6} strokeDasharray="3 3" />
      {ci && (
        <g stroke="var(--ink-3)" strokeWidth={1.5}>
          <line x1={x(ci[0])} x2={x(ci[1])} y1={AGREE_H / 2} y2={AGREE_H / 2} />
          <line x1={x(ci[0])} x2={x(ci[0])} y1={AGREE_H / 2 - 5} y2={AGREE_H / 2 + 5} />
          <line x1={x(ci[1])} x2={x(ci[1])} y1={AGREE_H / 2 - 5} y2={AGREE_H / 2 + 5} />
        </g>
      )}
      <circle cx={x(value)} cy={AGREE_H / 2} r={accent ? 5 : 4} fill={accent ? 'var(--amber)' : 'var(--blue)'}
              stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  );
}

export function PricingLab({ legs, market, engine, wasm, active, task, taskKey, seed, onSeed, antithetic, onAntithetic }: {
  legs: Leg[]; market: Market; engine: Engine; wasm: WasmEngine; active: boolean;
  /** The lab task runs in the Dashboard: the Build workspace reads the same result. */
  task: WorkerTaskState<LabResult>; taskKey: string;
  seed: number; onSeed: (seed: number) => void; antithetic: boolean; onAntithetic: (on: boolean) => void;
}) {
  const legsKey = legsKeyOf(legs);
  const key = taskKey;
  const r = task.result;
  const rows = useMemo(() => (r ? buildRows(r) : []), [r]);
  const ref = r?.bs.value ?? 0;
  const gross = r?.gross ?? 0;
  const single = legs.length === 1 ? legs[0] : null;
  const w = single ? signedQty(single) * M : 1;

  // C++ cross-check of the whole portfolio: the native engine when it speaks protocol v5, otherwise the same
  // kernel compiled to WebAssembly in a worker — available everywhere, including the hosted site.
  const native = engine.status === 'connected' && (engine.info?.protocol ?? 0) >= 5;
  const [eng, setEng] = useState<{ key: string; busy: boolean; res?: EngineRun; error?: string } | null>(null);
  const engKey = `${legsKey}|${marketKeyOf(market)}|${seed}|${antithetic ? 1 : 0}|${native ? 'native' : 'wasm'}`;
  const engineBlocker = native || wasm.status === 'ready' ? null
    : wasm.status === 'loading' ? 'Loading the C++ WebAssembly engine…'
    : 'No native engine is connected and the WebAssembly build could not load.';
  const backend = native
    ? `native engine · CPU, ${engine.info?.cpuThreads ?? 'all'} threads`
    : 'WebAssembly · single-threaded, in this tab';

  const runEngine = async () => {
    const runKey = engKey;
    setEng({ key: runKey, busy: true });
    try {
      const res: EngineRun = native
        ? { ...(await engine.runPortfolioMc(legs, market, ENGINE_PATHS, seed, antithetic)), native: true }
        : { ...(await wasm.runPortfolioMc(legs, market, ENGINE_PATHS, seed, antithetic)), native: false };
      setEng({ key: runKey, busy: false, res });
    } catch (err) {
      setEng({ key: runKey, busy: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // A cross-check is compared with the reference only once the Lab's own result belongs to the same inputs; while the
  // Lab re-prices, its Black-Scholes value is still the previous portfolio's.
  const current = !!r && task.resultKey === key;
  const compare = (value: number, se: number) => {
    if (!current) return { z: null, verdict: { tone: 'muted', text: 'Updating reference…' } as Verdict };
    const z = se > 0 ? Math.abs(value - ref) / se : 0;
    return { z, verdict: mcVerdict(z) };
  };

  let engRow: Row | null = null;
  if (eng?.res && eng.key === engKey && r) {
    const { price: value, stdError: se } = eng.res;
    engRow = { id: 'engine', model: `C++ ${eng.res.native ? 'native' : 'WebAssembly'} · ${fmtPaths(eng.res.paths)}`,
               detail: `whole portfolio · ${eng.res.native ? 'CPU multithreaded' : 'single-threaded'}${antithetic ? ' · antithetic' : ''}`,
               value, se, ms: eng.res.ms, ...compare(value, se), engine: true };
  }

  // Dupire local volatility: one diffusion for every leg, which must reprice each at its own implied volatility
  const surface = hasVolSurface(market);
  const lvKey = `${legsKey}|${marketKeyOf(market)}|${seed}`;
  const [lv, setLv] = useState<{ key: string; res: LocalVolRun } | null>(null);
  const onLocalVol = useCallback((key: string, res: LocalVolRun) => setLv({ key, res }), []);
  let lvRow: Row | null = null;
  if (surface && lv && lv.key === lvKey && r) {
    const { price: value, se } = lv.res;
    lvRow = { id: 'localvol', model: `Local vol (Dupire) · ${LV_BACKEND_LABEL[lv.res.backend]} · ${fmtPaths(lv.res.paths)}`,
              detail: lv.res.fineBias != null
                ? `Richardson · ${lv.res.steps} steps · fine-grid bias ${usdSigned(lv.res.fineBias, 2)} · seed ${lv.res.seed}`
                : `exact variance steps (no smile) · ${lv.res.steps} steps · seed ${lv.res.seed}`,
              value, se, ms: lv.res.ms, ...compare(value, se), engine: true };
  }
  const allRows = [...rows, ...(lvRow ? [lvRow] : []), ...(engRow ? [engRow] : [])];
  const span = agreementSpan(allRows, ref);
  const head = rows.find(x => x.id === 'mc200k');
  const final = r ? r.mc[r.mc.length - 1] : null;

  return (
    <div>
      <div className={l.controls}>
        <SeedInput value={seed} onChange={onSeed} testid="lab-seed" />
        <Button size="sm" variant="ghost" data-testid="lab-reseed"
                onClick={() => onSeed(Math.floor(Math.random() * 1_000_000))}>New draw</Button>
        <Segmented size="sm" label="Variance reduction" testid="lab-antithetic" value={antithetic ? 'on' : 'off'}
                   options={[{ value: 'off', label: 'Plain MC' }, { value: 'on', label: 'Antithetic' }]}
                   onChange={v => onAntithetic(v === 'on')} />
        <span className={l.status}>
          {task.running ? <><span className={l.spinner} aria-hidden="true" />Pricing…</>
            : r ? `${task.mode === 'worker' ? 'Web Worker' : 'Main thread'} · MC total ${fmtMs(r.mc.reduce((a, x) => a + x.ms, 0))}` : ''}
        </span>
      </div>

      {!r ? (
        <div data-testid="loading" style={{ display: 'grid', gap: 14 }}>
          <Skeleton shape="lines" lines={2} label="Running the first pricing pass…" />
          <div className={l.card}><Skeleton shape="lines" lines={6} label="Pricing the portfolio three ways…" /></div>
        </div>
      ) : (
        <div className={cx(task.running && l.stale)}>
          {head && (
            <div className={l.headline}>
              <Badge tone={head.verdict.tone} testid="lab-verdict">{head.verdict.text}</Badge>
              <span>
                200k-path Monte Carlo sits <b className="mono">{(head.z ?? 0).toFixed(2)}</b> standard errors from
                Black-Scholes ({usdSigned(head.value - ref, 2)} on {usd(ref, 2)}).
              </span>
            </div>
          )}

          <div className={ui.tableWrap}>
            <table className={ui.table} data-testid="lab-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className={ui.num}>Value</th>
                  <th className={ui.num}>Δ vs BS</th>
                  <th className={ui.num}>bp <InfoTip text="Difference relative to gross position value Σ|qty × 100 × BS price|, in basis points." align="end" /></th>
                  <th className={ui.num}>Std error</th>
                  <th className={l.agreeHead}>
                    <span>Agreement vs Black-Scholes</span>
                    <span className={l.agreeAxis} aria-hidden="true"><span>{usd(span[0], 0)}</span><span>{usd(span[1], 0)}</span></span>
                  </th>
                  <th className={ui.num}>|z|</th>
                  <th className={ui.num}>Time</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {allRows.map(row => {
                  const diff = row.value - ref;
                  return (
                    <tr key={row.id} data-testid={`lab-row-${row.id}`} data-z={row.z ?? undefined}
                        className={row.engine ? l.engineRow : undefined}>
                      <td><span className={l.modelName}>{row.model}</span><span className={l.modelDetail}>{row.detail}</span></td>
                      <td className={ui.num}>
                        <span className={l.valueMain} data-testid={`lab-value-${row.id}`} data-value={row.value}>{usd(row.value, 2)}</span>
                        {single && <span className={l.valueSub}>{(row.value / w).toFixed(4)} / sh</span>}
                      </td>
                      <td className={ui.num}>{row.id === 'bs' ? '—' : usdSigned(diff, 2)}</td>
                      <td className={ui.num}>{row.id === 'bs' || !(gross > 0) ? '—' : signed((diff / gross) * 1e4, 2)}</td>
                      <td className={ui.num} data-testid={`lab-se-${row.id}`} data-value={row.se ?? ''}>
                        {row.se == null ? '—' : usd(row.se, 2)}
                      </td>
                      <td className={l.agreeCell}>
                        <Agreement value={row.value} se={row.se} reference={ref} span={span} accent={row.id === 'bs'} />
                      </td>
                      <td className={ui.num} data-testid={`lab-z-${row.id}`}>{row.z == null ? '—' : row.z.toFixed(2)}</td>
                      <td className={ui.num}>{fmtMs(row.ms)}</td>
                      <td><Badge tone={row.verdict.tone} testid={`lab-verdict-${row.id}`}>{row.verdict.text}</Badge></td>
                    </tr>
                  );
                })}
                {!engRow && (
                  <tr className={l.engineRow} data-testid="lab-row-engine-pending">
                    <td>
                      <span className={l.modelName}>C++ Monte Carlo · {fmtPaths(ENGINE_PATHS)}</span>
                      <span className={l.modelDetail} data-testid="lab-engine-backend">
                        {backend} · seed {seed}{antithetic ? ' · antithetic' : ''}
                      </span>
                    </td>
                    <td className={ui.num}>
                      {engineBlocker ? '—' : (
                        <Button size="sm" onClick={runEngine} disabled={eng?.busy} data-testid="lab-engine-run">
                          {eng?.busy ? 'Simulating…' : 'Run in C++'}
                        </Button>
                      )}
                    </td>
                    <td colSpan={5} className={l.engineNote}>
                      {engineBlocker ?? 'The same portfolio through the C++ core — natively on every CPU thread when the engine runs, otherwise WebAssembly in this tab.'}
                      {eng?.error && eng.key === engKey && <span className="neg"> {eng.error}</span>}
                      {eng?.res && eng.key !== engKey && <span> Inputs changed since the last C++ run.</span>}
                    </td>
                    <td className={ui.num}>{eng?.res && eng.key === engKey ? fmtMs(eng.res.ms) : '—'}</td>
                    <td><Badge tone="muted">{eng?.busy ? 'Running' : 'Not run'}</Badge></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className={l.grid}>
            <div className={l.card} id="convergence">
              <div className={l.cardHead}>
                <span className={l.cardTitle}>Monte Carlo convergence</span>
                <span className={l.cardMeta}>1k → 200k paths · log scale</span>
              </div>
              {final && (
                <ConvergenceChart checkpoints={final.checkpoints} reference={ref}
                                  sigmaHat={final.se * Math.sqrt(final.antithetic ? final.paths / 2 : final.paths)} />
              )}
            </div>
            <div className={l.card}>
              <div className={l.cardHead}>
                <span className={l.cardTitle}>Binomial lattice error</span>
                <span className={l.cardMeta}>CRR − BS · steps 4 → 512</span>
              </div>
              <CrrChart curve={r.crrCurve} />
              <p className={ui.note}>
                Odd and even step counts straddle the closed form, and the error decays roughly as 1/N. At {r.crr.steps} steps
                the portfolio error is {usdSigned(r.crr.value - ref, 4)}.
              </p>
            </div>
          </div>

          <div className={l.card} style={{ marginTop: 14 }} data-testid="lab-american">
            <div className={l.cardHead}>
              <span className={l.cardTitle}>Early exercise · American options (CRR {r.crr.steps} steps)</span>
              <span className={l.cardMeta}>{fmtMs(r.american.ms)}</span>
            </div>
            <div className={l.headline} style={{ marginBottom: 0 }}>
              <span>American value{' '}
                <b className="mono" data-testid="lab-american-value" data-value={r.american.value}>{usd(r.american.value, 2)}</b>
              </span>
              <span>European lattice <b className="mono">{usd(r.crr.value, 2)}</b></span>
              <span>Early-exercise premium{' '}
                <b className="mono" data-testid="lab-eep" data-value={r.american.value - r.crr.value}>
                  {usdSigned(r.american.value - r.crr.value, 2)}
                </b>
              </span>
            </div>
            <p className={ui.note} style={{ marginTop: 6 }}>
              Listed single-stock and ETF options are American. The same lattice with an exercise check at every node,
              minus the European lattice, isolates the value of early exercise: zero for calls without dividends,
              positive for in-the-money puts, and for calls when the dividend yield is high. Black-Scholes, Monte Carlo
              and the Greeks elsewhere in the terminal are European.
            </p>
          </div>

          <EarlyExercise legs={legs} market={market} wasm={wasm} active={active} lab={r} labCurrent={current} />

          <GreeksLadder legs={legs} market={market} wasm={wasm} active={active} />

          <div className={l.card} style={{ marginTop: 14 }}>
            <div className={l.cardHead}>
              <span className={l.cardTitle}>Per-leg prices (per share)</span>
              <span className={l.cardMeta}>MC {fmtPaths(r.legMcPaths)} paths per leg</span>
            </div>
            <div className={ui.tableWrap}>
              <table className={ui.table} data-testid="lab-legs">
                <thead>
                  <tr>
                    <th>Leg</th><th className={ui.num}>Black-Scholes</th><th className={ui.num}>CRR 512</th>
                    <th className={ui.num}>CRR − BS</th><th className={ui.num}>Monte Carlo</th>
                    <th className={ui.num}>± SE</th><th className={ui.num}>|z|</th>
                    <th className={ui.num}>American</th><th className={ui.num}>Early-ex.</th>
                  </tr>
                </thead>
                <tbody>
                  {r.perLeg.map((p, i) => {
                    // labels come with the result, so a re-pricing never pairs new legs with old numbers
                    const z = p.mcSe > 0 ? Math.abs(p.mc - p.bs) / p.mcSe : 0;
                    return (
                      <tr key={`${i}-${r.legLabels[i]}`}>
                        <td className="mono">{r.legLabels[i]}</td>
                        <td className={ui.num}>{p.bs.toFixed(4)}</td>
                        <td className={ui.num}>{p.crr.toFixed(4)}</td>
                        <td className={ui.num}>{signed(p.crr - p.bs, 4)}</td>
                        <td className={ui.num}>{p.mc.toFixed(4)}</td>
                        <td className={ui.num}>{p.mcSe.toFixed(4)}</td>
                        <td className={ui.num}>{z.toFixed(2)}</td>
                        <td className={ui.num}>{p.american.toFixed(4)}</td>
                        <td className={ui.num}>{signed(p.american - p.crr, 4)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {surface && r && (
        <LocalVolCheck legs={legs} market={market} seed={seed + 3} runKey={lvKey} onResult={onLocalVol}
                       stale={!!lv && lv.key !== lvKey} engine={engine} wasm={wasm} />
      )}

      <details className={l.formulas}>
        <summary>Model formulas and assumptions</summary>
        <div className={l.formulaGrid}>
          <div className={l.formula}>
            <h4>Black-Scholes-Merton</h4>
            <pre>{`d₁ = [ln(S/K) + (r − q + σ²/2)T] / (σ√T)
d₂ = d₁ − σ√T
C = S·e^(−qT)·N(d₁) − K·e^(−rT)·N(d₂)
P = K·e^(−rT)·N(−d₂) − S·e^(−qT)·N(−d₁)`}</pre>
            <p>European exercise, constant σ and r, continuous dividend yield q. Greeks are analytic.</p>
          </div>
          <div className={l.formula}>
            <h4>Cox-Ross-Rubinstein lattice</h4>
            <pre>{`Δt = T/N,  u = e^(σ√Δt),  d = 1/u
p = (e^((r−q)Δt) − d) / (u − d)
V = e^(−rΔt)·[p·V_up + (1 − p)·V_down]`}</pre>
            <p>Backward induction from terminal payoffs; European, so no early-exercise check.</p>
          </div>
          <div className={l.formula}>
            <h4>Monte Carlo</h4>
            <pre>{`S_t = S₀·exp((r − q − σ²/2)t + σW_t)
V̂ = mean(Σ legs e^(−rT)·qty·100·payoff)
SE = s/√N,   95% CI = V̂ ± 1.96·SE
|z| = |V̂ − V_BS| / SE`}</pre>
            <p>
              Seeded mulberry32 + Box-Muller. One Brownian path is observed at every distinct expiry, so mixed-maturity
              legs stay correctly correlated. Antithetic mode averages each draw with its mirror (−Z).
            </p>
          </div>
        </div>
      </details>
    </div>
  );
}
