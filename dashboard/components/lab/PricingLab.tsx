'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import { hasVolSurface } from '@/lib/quant/volSurface';
import type { LabResult, LocalVolRequest, LocalVolResult } from '@/lib/compute/tasks';
import { LAB_PATHS, LV_MIN_STEPS, LV_PATHS, LV_STEPS_PER_YEAR } from '@/lib/compute/tasks';
import { useWorkerTask } from '@/lib/compute/useWorkerTask';
import type { Engine } from '@/lib/engine/useEngine';
import type { WasmEngine } from '@/lib/engine/useWasmEngine';
import { legLabel, legsKeyOf, marketKeyOf } from '@/lib/strategy/labels';
import { signed, usd, usdSigned } from '@/lib/format';
import type { Tone } from '@/components/ui/primitives';
import { Badge, Button, cx, InfoTip, Segmented, ui } from '@/components/ui/primitives';
import { ConvergenceChart, CrrChart } from './ConvergenceChart';
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

/**
 * Runs the portfolio under Dupire local volatility in its own worker, on request. Mounted only when the market has a
 * smile or term structure, so a flat market starts no extra worker.
 */
function LocalVolCheck({ legs, market, seed, runKey, stale, onResult }: {
  legs: Leg[]; market: Market; seed: number; runKey: string; stale: boolean;
  onResult: (key: string, res: LocalVolResult) => void;
}) {
  const [job, setJob] = useState<{ id: string; runKey: string; req: LocalVolRequest } | null>(null);
  const task = useWorkerTask('localvol', job?.req ?? null, job?.id ?? '', 0);
  useEffect(() => {
    if (job && task.resultKey === job.id && task.result && !task.error) onResult(job.runKey, task.result);
  }, [job, task.resultKey, task.result, task.error, onResult]);
  const busy = !!job && task.resultKey !== job.id;

  return (
    <div className={l.engineBox} data-testid="lab-localvol">
      <strong>Local volatility cross-check</strong>
      <Button size="sm" onClick={() => setJob({ id: `${runKey}|${Date.now()}`, runKey, req: { legs, market, seed } })}
              disabled={busy} data-testid="lab-localvol-run">
        {busy ? 'Simulating local-vol paths…' : `Simulate ${fmtPaths(LV_PATHS)} local-volatility paths`}
      </Button>
      <span>
        σ_loc(S, t) from Dupire’s formula on this surface · log-Euler at {LV_STEPS_PER_YEAR} steps a year (at least {LV_MIN_STEPS}),
        Richardson-extrapolated over a coupled half-step grid · one diffusion for every leg, so it must reprice each at its own
        implied volatility
      </span>
      {task.error && job && task.resultKey === job.id && <span className="neg">{task.error}</span>}
      {stale && !busy && <span>Inputs changed since the last local-vol run.</span>}
    </div>
  );
}

export function PricingLab({ legs, market, engine, wasm, active }: {
  legs: Leg[]; market: Market; engine: Engine; wasm: WasmEngine; active: boolean;
}) {
  const [seed, setSeed] = useState(42);
  const [antithetic, setAntithetic] = useState(false);
  const legsKey = legsKeyOf(legs);
  const key = `${legsKey}|${marketKeyOf(market)}|${seed}|${antithetic ? 1 : 0}`;
  const task = useWorkerTask('lab', active ? { legs, market, seed, antithetic } : null, key, 120);
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

  let engRow: Row | null = null;
  if (eng?.res && eng.key === engKey && r) {
    const { price: value, stdError: se } = eng.res;
    const z = se > 0 ? Math.abs(value - ref) / se : 0;
    engRow = { id: 'engine', model: `C++ ${eng.res.native ? 'native' : 'WebAssembly'} · ${fmtPaths(eng.res.paths)}`,
               detail: `whole portfolio · ${eng.res.native ? 'CPU multithreaded' : 'single-threaded'}${antithetic ? ' · antithetic' : ''}`,
               value, se, ms: eng.res.ms, z, verdict: mcVerdict(z), engine: true };
  }

  // Dupire local volatility: one diffusion for every leg, which must reprice each at its own implied volatility
  const surface = hasVolSurface(market);
  const lvKey = `${legsKey}|${marketKeyOf(market)}|${seed}`;
  const [lv, setLv] = useState<{ key: string; res: LocalVolResult } | null>(null);
  const onLocalVol = useCallback((key: string, res: LocalVolResult) => setLv({ key, res }), []);
  let lvRow: Row | null = null;
  if (surface && lv && lv.key === lvKey && r) {
    const { price: value, se } = lv.res;
    const z = se > 0 ? Math.abs(value - ref) / se : 0;
    lvRow = { id: 'localvol', model: `Local vol (Dupire) · ${fmtPaths(lv.res.paths)}`,
              detail: lv.res.extrapolated
                ? `Richardson 2·fine − coarse · ${lv.res.steps} steps · fine-grid bias est. ${usdSigned(lv.res.fineBias ?? 0, 2)} · seed ${lv.res.seed}`
                : `exact variance steps (no smile) · ${lv.res.steps} steps · seed ${lv.res.seed}`,
              value, se, ms: lv.res.ms, z, verdict: mcVerdict(z), engine: true };
  }
  const allRows = [...rows, ...(lvRow ? [lvRow] : []), ...(engRow ? [engRow] : [])];
  const head = rows.find(x => x.id === 'mc200k');
  const final = r ? r.mc[r.mc.length - 1] : null;

  return (
    <div>
      <p className={l.intro}>
        One portfolio, three pricing models. Black-Scholes-Merton is the closed-form reference; the CRR lattice and
        Monte Carlo must converge to it. Monte Carlo error is reported as standard error, a 95% interval and |z| against
        the reference, so an unlucky draw is visible rather than hidden.
      </p>

      <div className={l.controls}>
        <SeedInput value={seed} onChange={setSeed} testid="lab-seed" />
        <Button size="sm" variant="ghost" data-testid="lab-reseed"
                onClick={() => setSeed(Math.floor(Math.random() * 1_000_000))}>New draw</Button>
        <Segmented size="sm" label="Variance reduction" testid="lab-antithetic" value={antithetic ? 'on' : 'off'}
                   options={[{ value: 'off', label: 'Plain MC' }, { value: 'on', label: 'Antithetic' }]}
                   onChange={v => setAntithetic(v === 'on')} />
        <span className={l.status}>
          {task.running ? <><span className={l.spinner} aria-hidden="true" />Pricing…</>
            : r ? `${task.mode === 'worker' ? 'Web Worker' : 'Main thread'} · MC total ${fmtMs(r.mc.reduce((a, x) => a + x.ms, 0))}` : ''}
        </span>
      </div>

      {!r ? (
        <p className={l.intro} data-testid="loading">Running the first pricing pass…</p>
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
                  <th className={ui.num}>95% CI</th>
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
                      <td className={ui.num}>
                        {row.se == null ? '—' : `${usd(row.value - Z95 * row.se, 2)} – ${usd(row.value + Z95 * row.se, 2)}`}
                      </td>
                      <td className={ui.num} data-testid={`lab-z-${row.id}`}>{row.z == null ? '—' : row.z.toFixed(2)}</td>
                      <td className={ui.num}>{fmtMs(row.ms)}</td>
                      <td><Badge tone={row.verdict.tone} testid={`lab-verdict-${row.id}`}>{row.verdict.text}</Badge></td>
                    </tr>
                  );
                })}
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
                  {legs.map((lg, i) => {
                    const p = r.perLeg[i];
                    if (!p) return null;
                    const z = p.mcSe > 0 ? Math.abs(p.mc - p.bs) / p.mcSe : 0;
                    return (
                      <tr key={lg.id}>
                        <td className="mono">{legLabel(lg)}</td>
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

      <div className={l.engineBox} data-testid="lab-engine">
        <strong>C++ engine cross-check</strong>
        {engineBlocker ? <span>{engineBlocker}</span> : (
          <>
            <Button size="sm" variant="primary" onClick={runEngine} disabled={eng?.busy} data-testid="lab-engine-run">
              {eng?.busy ? 'Simulating in C++…' : `Run ${fmtPaths(ENGINE_PATHS)} paths of this portfolio in C++`}
            </Button>
            <span data-testid="lab-engine-backend">{backend} · seed {seed}{antithetic ? ' · antithetic' : ''}</span>
            {eng?.error && eng.key === engKey && <span className="neg">{eng.error}</span>}
            {eng?.res && eng.key !== engKey && <span>Inputs changed since the last C++ run.</span>}
          </>
        )}
      </div>

      {surface && r && (
        <LocalVolCheck legs={legs} market={market} seed={seed + 3} runKey={lvKey} onResult={onLocalVol}
                       stale={!!lv && lv.key !== lvKey} />
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
