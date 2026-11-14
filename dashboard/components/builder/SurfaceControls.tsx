'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { Market, Smile, TermStructure } from '@/lib/quant/types';
import type { SurfaceCalibration } from '@/lib/quant/calibrate';
import { MIN_QUOTES } from '@/lib/quant/calibrate';
import type { SmilePreset, TermPreset } from '@/lib/quant/volSurface';
import { clampSmile, clampTerm, SMILE_PRESETS, TERM_LIMITS, TERM_PRESETS } from '@/lib/quant/volSurface';
import { loadSurfaceSlices, pickSurfaceExpiries } from '@/lib/market/surfaceData';
import type { SurfaceRequest } from '@/lib/compute/tasks';
import { useWorkerTask } from '@/lib/compute/useWorkerTask';
import { firstExpiry } from '@/lib/strategy/portfolio';
import { pct } from '@/lib/format';
import { Button, InfoTip, Segmented, SliderField } from '@/components/ui/primitives';
import { SmileChart } from './SmileChart';
import { TermChart } from './TermChart';
import type { TerminalAction, TerminalState } from '@/components/terminal/useTerminalState';
import type { LiveData } from '@/components/terminal/useLiveData';
import b from './builder.module.css';

const SMILE_CHOICES = ['Flat', 'Equity index', 'Single stock', 'Custom'] as const;
type SmileChoice = typeof SMILE_CHOICES[number];

const TERM_CHOICES = ['Flat', 'Upward', 'Inverted', 'Custom'] as const;
type TermChoice = typeof TERM_CHOICES[number] | 'Fitted';

/** Largest curvature on the slider grid that stays arbitrage-free for this skew: η ≤ 2 / (1 + |ρ|). */
const etaCap = (rho: number) => +(Math.floor(2 / (1 + Math.abs(rho)) / 0.05 + 1e-9) * 0.05).toFixed(2);

/** Slider-aligned smile parameters inside the arbitrage-free region. */
function snapSmile(s: Smile): Smile {
  const c = clampSmile({ rho: +s.rho.toFixed(2), eta: +s.eta.toFixed(2), gamma: s.gamma });
  return { ...c, eta: Math.min(c.eta, etaCap(c.rho)) };
}

type Fit = SurfaceCalibration & { sym: string; ms: number };

/** The σ the sliders can show for a fit. */
const fitSigma = (c: SurfaceCalibration) => Math.min(1.5, Math.max(0.01, c.sigma));

/** The volatility surface: a smile across strikes and an at-the-money curve across expiries. */
export function SurfaceControls({ state, dispatch, live }: {
  state: TerminalState; dispatch: Dispatch<TerminalAction>; live: LiveData;
}) {
  const { instrument: inst, market: m } = state;
  const set = (patch: Partial<Market>) => dispatch({ type: 'market', patch });

  // ── smile ──────────────────────────────────────────────────────────────────
  const [customSmile, setCustomSmile] = useState(false);
  const smile = m.smile;
  const presetName = smile
    ? (Object.keys(SMILE_PRESETS) as SmilePreset[]).find(k =>
        SMILE_PRESETS[k].rho === smile.rho && SMILE_PRESETS[k].eta === smile.eta && SMILE_PRESETS[k].gamma === smile.gamma)
    : undefined;
  const smileChoice: SmileChoice = !smile ? 'Flat' : customSmile || !presetName ? 'Custom' : presetName;
  const setSmile = (s: Smile | null) => set({ smile: s ? snapSmile(s) : null });
  const chooseSmile = (c: SmileChoice) => {
    setCustomSmile(c === 'Custom');
    if (c === 'Flat') setSmile(null);
    else if (c === 'Custom') setSmile(smile ?? { rho: -0.5, eta: 1, gamma: 0.45 });
    else setSmile(SMILE_PRESETS[c]);
  };

  // ── ATM term structure ────────────────────────────────────────────────────
  const [customTerm, setCustomTerm] = useState(false);
  const term = m.term ?? null;
  const termPreset = term?.kind === 'curve'
    ? (Object.keys(TERM_PRESETS) as TermPreset[]).find(k => TERM_PRESETS[k].ratio === term.ratio && TERM_PRESETS[k].halfLife === term.halfLife)
    : undefined;
  const termChoice: TermChoice = !term ? 'Flat' : term.kind === 'fitted' ? 'Fitted' : customTerm || !termPreset ? 'Custom' : termPreset;
  const termOptions: TermChoice[] = term?.kind === 'fitted' ? [...TERM_CHOICES, 'Fitted'] : [...TERM_CHOICES];
  const setTerm = (t: TermStructure | null) => set({ term: t ? clampTerm(t) : null });
  const chooseTerm = (c: TermChoice) => {
    if (c === 'Fitted') return;
    setCustomTerm(c === 'Custom');
    if (c === 'Flat') setTerm(null);
    else if (c === 'Custom') setTerm(term?.kind === 'curve' ? term : { kind: 'curve', ratio: 0.8, halfLife: 0.25 });
    else setTerm(TERM_PRESETS[c]);
  };

  // ── surface fit to the listed option chains (live data only) ──────────────
  const [fit, setFit] = useState<Fit | null>(null);
  const onFitted = useCallback((f: Fit) => {
    if (f.sym !== inst.sym) return;
    setCustomSmile(true);
    setFit(f);
    dispatch({ type: 'market', patch: { sigma: fitSigma(f), smile: f.smile, term: f.term } });   // unrounded
    dispatch({ type: 'repriceLegs' });   // re-enter premiums at the fitted vols
  }, [dispatch, inst.sym]);
  const fitShown = fit && smile && inst.sym === fit.sym && m.sigma === fitSigma(fit) && (m.term ?? null) === fit.term &&
    smile.rho === fit.smile.rho && smile.eta === fit.smile.eta && smile.gamma === fit.smile.gamma ? fit : null;
  const canFit = live.mode === 'live' && live.allExpirations.length > 0 && !inst.custom;
  const chartT = state.legs.length ? Math.max(firstExpiry(state.legs), 1 / 365) : 30 / 365;
  const chartSlice = fitShown?.slices.find(s => Math.abs(s.T - chartT) < 0.5 / 365);
  const termPoints = fitShown?.slices.flatMap(s => (s.marketAtmVol != null ? [{ T: s.T, vol: s.marketAtmVol }] : []));

  return (
    <div className={b.surface}>
      <div className={b.surfaceBlock} data-testid="smile-panel">
        <span className={b.smileTitle}>
          Smile · by strike
          <InfoTip align="start" text="SSVI (Gatheral–Jacquier): every strike gets its own implied volatility, with parameters kept in the arbitrage-free region. σ is the at-the-money volatility. Scenarios keep each strike's volatility when spot moves (sticky strike)." />
        </span>
        <Segmented size="sm" full label="Volatility smile" testid="smile" value={smileChoice}
                   options={SMILE_CHOICES.map(v => ({ value: v, label: v === 'Equity index' ? 'Index' : v === 'Single stock' ? 'Stock' : v, title: v }))}
                   onChange={chooseSmile} />
        {smile && (
          <div className={b.sliders} style={{ marginTop: 0 }}>
            <SliderField label="Skew" symbol="ρ" value={smile.rho} min={-0.95} max={0.95} step={0.05}
                         format={v => v.toFixed(2)} testid="smile-rho" displayTestid="smile-rho-display"
                         onChange={rho => { setCustomSmile(true); setSmile({ ...smile, rho }); }}
                         tip="Negative skew makes downside strikes richer than upside strikes, as in equity markets." />
            <SliderField label="Curvature" symbol="η" value={smile.eta} min={0.05} max={etaCap(smile.rho)} step={0.05}
                         format={v => v.toFixed(2)} testid="smile-eta" displayTestid="smile-eta-display"
                         onChange={eta => { setCustomSmile(true); setSmile({ ...smile, eta }); }}
                         tip="How fast volatility rises away from the money. Capped at 2 / (1 + |ρ|), the arbitrage-free limit." />
          </div>
        )}
        <SmileChart market={m} legs={state.legs} quotes={chartSlice?.points} />
      </div>

      <div className={b.surfaceBlock} data-testid="term-panel">
        <span className={b.smileTitle}>
          Term structure · by expiry
          <InfoTip align="start" text="How at-the-money volatility changes with expiry. With a term structure, σ is the 30-day ATM volatility. Total variance never falls with maturity, so calendar spreads stay arbitrage-free; vol scenarios scale every expiry in proportion." />
        </span>
        <Segmented size="sm" full label="ATM term structure" testid="term" value={termChoice}
                   options={termOptions.map(v => ({ value: v, label: v, ...(v === 'Fitted' ? { title: 'Fitted to the listed option chains' } : {}) }))}
                   onChange={chooseTerm} />
        {term?.kind === 'curve' && (
          <div className={b.sliders} style={{ marginTop: 0 }}>
            <SliderField label="Short end ÷ long run" value={term.ratio} min={TERM_LIMITS.ratio[0]} max={TERM_LIMITS.ratio[1]} step={0.05}
                         format={v => `${v.toFixed(2)}×`} testid="term-ratio" displayTestid="term-ratio-display"
                         onChange={ratio => { setCustomTerm(true); setTerm({ ...term, ratio: +ratio.toFixed(2) }); }}
                         tip="Instantaneous ATM volatility at the short end relative to its long-run level: below 1 the curve slopes upward (calm markets), above 1 it inverts (stress)." />
            <SliderField label="Half-life" value={term.halfLife} min={TERM_LIMITS.halfLife[0]} max={TERM_LIMITS.halfLife[1]} step={1 / 365}
                         format={v => `${Math.round(v * 365)} d`} testid="term-halflife" displayTestid="term-halflife-display"
                         inputScale={365} inputDecimals={0}
                         onChange={h => { setCustomTerm(true); setTerm({ ...term, halfLife: Math.max(TERM_LIMITS.halfLife[0], Math.round(h * 365) / 365) }); }}
                         tip="How quickly short-dated volatility reverts to its long-run level (the variance gap halves in this time)." />
          </div>
        )}
        <TermChart market={m} legs={state.legs} points={termPoints} />
        {canFit && <SurfaceFit key={inst.sym} sym={inst.sym} market={m} live={live} shown={fitShown} onFitted={onFitted} />}
      </div>
    </div>
  );
}

/**
 * Loads a spread of listed expiries' chains and fits one arbitrage-free SSVI surface to them in the compute
 * worker. Mounted only with live data, so the hosted snapshot site starts no worker for it.
 */
function SurfaceFit({ sym, market, live, shown, onFitted }: {
  sym: string; market: Market; live: LiveData; shown: Fit | null; onFitted: (fit: Fit) => void;
}) {
  const [job, setJob] = useState<{ key: string; sym: string; req: SurfaceRequest; failed: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const task = useWorkerTask('surface', job?.req ?? null, job?.key ?? '', 0);
  const applied = useRef('');
  const seq = useRef(0);

  useEffect(() => {
    if (!job || task.resultKey !== job.key || applied.current === job.key) return;
    applied.current = job.key;
    const cal = task.error ? null : task.result?.cal ?? null;
    if (!cal) {
      setMsg(task.error ? `Surface fit failed: ${task.error}`
        : `No expiry had ${MIN_QUOTES} or more out-of-the-money quotes with a market implied volatility.`);
      return;
    }
    setMsg(job.failed.length ? `Chain unavailable for ${job.failed.join(', ')} — fitted without ${job.failed.length === 1 ? 'it' : 'them'}.` : '');
    onFitted({ ...cal, sym: job.sym, ms: task.result?.ms ?? 0 });
  }, [job, task.resultKey, task.result, task.error, onFitted]);

  const run = async () => {
    const id = ++seq.current;
    setLoading(true);
    setMsg('');
    const expiries = pickSurfaceExpiries(live.allExpirations, live.expiry);
    const { slices, failed } = await loadSurfaceSlices(sym, expiries, market.S, market.r, market.q);
    if (id !== seq.current) return;
    setLoading(false);
    setJob({ key: `${sym}|${id}`, sym, req: { slices, S: market.S, r: market.r, q: market.q }, failed });
  };
  const fitting = loading || (!!job && task.resultKey !== job.key);

  return (
    <>
      <div className={b.fitRow}>
        <Button size="sm" onClick={run} disabled={fitting} data-testid="surface-fit">
          {loading ? 'Loading chains…' : fitting ? 'Fitting surface…' : `Fit surface to ${sym} chains`}
        </Button>
        {shown && (
          <span className={b.subtle} data-testid="surface-fit-stats" data-rmse={shown.rmseVolPts} data-n={shown.quotes}
                data-expiries={shown.slices.length} data-term={shown.term ? 'fitted' : 'flat'}
                title="Root-mean-square gap between the fitted surface and the market implied vols of out-of-the-money quotes, over every expiry">
            {shown.slices.length} {shown.slices.length === 1 ? 'expiry' : 'expiries'} · {shown.quotes} quotes · RMSE {shown.rmseVolPts.toFixed(2)} vol pts
            {shown.atLimit ? ' · at the arbitrage-free limit' : ''}{shown.pooled ? ' · calendar arbitrage in the quotes pooled' : ''}
          </span>
        )}
      </div>
      {msg && <p className={b.searchMsg} role="status" data-testid="surface-fit-msg">{msg}</p>}
      {shown && (
        <details className={b.fitDetails}>
          <summary>
            Fit by expiry · ρ {shown.smile.rho.toFixed(2)} · η {shown.smile.eta.toFixed(2)} · γ {shown.smile.gamma.toFixed(2)} · {Math.round(shown.ms)} ms
          </summary>
          <div className={b.fitTableWrap}>
            <table className={b.fitTable} data-testid="surface-fit-table">
              <thead>
                <tr><th scope="col">Expiry</th><th scope="col">Days</th><th scope="col">Quotes</th>
                    <th scope="col">ATM fit</th><th scope="col">ATM mkt</th><th scope="col">RMSE</th></tr>
              </thead>
              <tbody>
                {shown.slices.map(s => (
                  <tr key={s.expiry}>
                    <td>{s.expiry}</td><td>{Math.round(s.T * 365)}</td><td>{s.points.length}</td>
                    <td>{pct(s.atmVol, 1)}</td><td>{s.marketAtmVol != null ? pct(s.marketAtmVol, 1) : '—'}</td>
                    <td>{s.rmseVolPts.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  );
}
