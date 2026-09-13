'use client';

import { memo, useEffect, useState } from 'react';
import type { Dispatch } from 'react';
import { bsPrice } from '@/lib/quant/blackScholes';
import { impliedVol } from '@/lib/quant/impliedVol';
import type { Leg } from '@/lib/quant/types';
import { CONTRACT_MULT as M, signedQty } from '@/lib/quant/types';
import type { Instrument } from '@/lib/market/instruments';
import type { PresetName } from '@/lib/strategy/presets';
import { buildPreset, MAX_LEGS, PRESETS } from '@/lib/strategy/presets';
import { usdSigned } from '@/lib/format';
import { Button, cx, Segmented } from '@/components/ui/primitives';
import type { TerminalAction, TerminalState } from '@/components/terminal/useTerminalState';
import type { LiveData } from '@/components/terminal/useLiveData';
import b from './builder.module.css';

export const presetSlug = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, '-');

// Expiry payoff shape of each preset on a reference underlying, drawn as a tiny glyph.
const GLYPH_INST: Instrument = { sym: 'REF', name: 'ref', spot: 100, vol: 0.25, q: 0, step: 0.5, kstep: 2.5 };
const GLYPHS: Record<string, string> = Object.fromEntries(PRESETS.map(name => {
  const m = { S: 100, sigma: 0.25, r: 0.04, q: 0 };
  const legs = buildPreset(name, GLYPH_INST, m);
  const xs = Array.from({ length: 41 }, (_, i) => 84 + i * 0.8);
  const ys = xs.map(x => legs.reduce((a, l) =>
    a + signedQty(l) * ((l.call ? Math.max(x - l.K, 0) : Math.max(l.K - x, 0)) - l.premium), 0));
  const lo = Math.min(...ys, 0), hi = Math.max(...ys, 0);
  const pts = xs.map((_, i) => `${((i / 40) * 100).toFixed(1)},${(15 - ((ys[i] - lo) / (hi - lo || 1)) * 14).toFixed(1)}`);
  const zero = (15 - ((0 - lo) / (hi - lo || 1)) * 14).toFixed(1);
  return [name, `${pts.join(' ')}|${zero}`];
}));

function PresetButton({ name, active, onClick }: { name: PresetName; active: boolean; onClick: () => void }) {
  const [pts, zero] = GLYPHS[name].split('|');
  return (
    <button type="button" className={b.preset} aria-pressed={active} onClick={onClick}
            data-testid={`preset-${presetSlug(name)}`}>
      <svg className={b.glyph} viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="100" y1={zero} y2={zero} stroke="var(--line-2)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <span className={b.presetName}>{name}</span>
    </button>
  );
}

/** Numeric cell that edits a draft and commits on blur / Enter, so typing never reprices mid-number. */
function NumberCell({ label, value, display, onCommit, validate, testid, step, inputMode = 'decimal' }: {
  label: string; value: number; display: string; onCommit: (v: number) => void;
  validate: (v: number) => boolean; testid: string; step?: number; inputMode?: 'decimal' | 'numeric';
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? display;
  const parsed = parseFloat(text);
  const invalid = draft != null && !(Number.isFinite(parsed) && validate(parsed));
  const commit = () => {
    if (draft != null && draft !== display && Number.isFinite(parsed) && validate(parsed)) onCommit(parsed);
    setDraft(null);
  };
  useEffect(() => { setDraft(null); }, [value]);
  return (
    <label className={b.cell}>
      <span className={b.cellLabel}>{label}</span>
      <input className={cx(b.cellInput, invalid && b.cellInvalid)} value={text} inputMode={inputMode}
             data-testid={testid} aria-invalid={invalid || undefined} step={step}
             onChange={e => setDraft(e.target.value)} onBlur={commit}
             onKeyDown={e => {
               if (e.key === 'Enter') { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); }
               if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
               if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && step) {
                 e.preventDefault();
                 const next = +(value + (e.key === 'ArrowUp' ? step : -step)).toFixed(6);
                 if (validate(next)) onCommit(next);
               }
             }} />
    </label>
  );
}

const LegRow = memo(function LegRow({ leg, index, state, dispatch, live, canRemove }: {
  leg: Leg; index: number; state: TerminalState; dispatch: Dispatch<TerminalAction>; live: LiveData; canRemove: boolean;
}) {
  const { market: m, instrument: inst } = state;
  const update = (patch: Partial<Omit<Leg, 'id'>>) => dispatch({ type: 'updateLeg', id: leg.id, patch });
  const mark = bsPrice(leg.call, m.S, leg.K, leg.T, m.sigma, m.r, m.q);
  const pnl = signedQty(leg) * M * (mark - leg.premium);
  const iv = impliedVol(leg.call, leg.premium, m.S, leg.K, leg.T, m.r, m.q);
  const ivText = iv ? `${(iv.sigma * 100).toFixed(1)}%` : '—';
  const dte = Math.round(leg.T * 365);
  const chainStrikes = live.chain
    .filter(o => o.type === (leg.call ? 'call' : 'put'))
    .sort((a, c) => a.strike - c.strike)
    .filter((o, i, arr) => i === 0 || arr[i - 1].strike !== o.strike);

  return (
    <div className={b.leg} data-testid="leg-row">
      <div className={b.legTop}>
        <span className={b.legIdx}>{index + 1}</span>
        <Segmented size="sm" label={`Leg ${index + 1} option type`} testid={`leg-${index}-type`}
                   value={leg.call ? 'call' : 'put'}
                   options={[{ value: 'call', label: 'Call' }, { value: 'put', label: 'Put' }]}
                   onChange={v => update({ call: v === 'call' })} />
        <Segmented size="sm" label={`Leg ${index + 1} side`} testid={`leg-${index}-side`} value={leg.side}
                   options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]}
                   onChange={side => update({ side })} />
        <span className={b.legMark}
              title={`Implied volatility of the entry premium: ${iv ? ivText : 'none (premium outside no-arbitrage bounds)'} · model price ${mark.toFixed(2)} · leg P&L at the current market`}>
          <span data-testid={`leg-${index}-iv`} data-value={iv?.sigma ?? ''}>IV {ivText}</span>
          {' · '}<span className={pnl > 0.5 ? 'pos' : pnl < -0.5 ? 'neg' : undefined}>{usdSigned(pnl)}</span>
        </span>
        <button type="button" className={b.remove} disabled={!canRemove} onClick={() => dispatch({ type: 'removeLeg', id: leg.id })}
                aria-label={`Remove leg ${index + 1}`} data-testid={`leg-${index}-remove`}>×</button>
      </div>
      <div className={b.legFields}>
        {chainStrikes.length > 0 ? (
          <label className={b.cell}>
            <span className={b.cellLabel}>Strike</span>
            <select className={b.select} value={String(leg.K)} data-testid={`leg-${index}-strike`}
                    onChange={e => update({ K: parseFloat(e.target.value) })}>
              {!chainStrikes.some(o => o.strike === leg.K) && <option value={String(leg.K)}>{leg.K}</option>}
              {chainStrikes.map(o => (
                <option key={o.strike} value={String(o.strike)} disabled={!live.usableIv(o.iv)}>
                  {o.strike}{live.usableIv(o.iv) ? ` · ${(o.iv! * 100).toFixed(1)}%` : ' · no IV'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <NumberCell label="Strike" testid={`leg-${index}-strike`} value={leg.K} display={String(+leg.K.toFixed(4))}
                      step={inst.kstep} validate={v => v > 0 && v < 1e7} onCommit={K => update({ K })} />
        )}
        <NumberCell label="Qty" testid={`leg-${index}-qty`} value={leg.qty} display={String(leg.qty)} step={1}
                    inputMode="numeric" validate={v => v > 0 && v <= 100_000 && Number.isInteger(v)}
                    onCommit={qty => update({ qty })} />
        <NumberCell label="DTE" testid={`leg-${index}-dte`} value={leg.T} display={String(dte)} step={1}
                    inputMode="numeric" validate={v => v >= 1 && v <= 1095 && Number.isInteger(v)}
                    onCommit={d => update({ T: d / 365 })} />
        <NumberCell label="Premium" testid={`leg-${index}-premium`} value={leg.premium} display={leg.premium.toFixed(2)}
                    step={0.05} validate={v => v >= 0 && v < 1e6} onCommit={premium => update({ premium })} />
      </div>
    </div>
  );
});

export function StrategyBuilder({ state, dispatch, live }: {
  state: TerminalState; dispatch: Dispatch<TerminalAction>; live: LiveData;
}) {
  const { legs, preset, source } = state;
  return (
    <div>
      <div className={b.presets} role="group" aria-label="Strategy presets">
        {PRESETS.map(name => (
          <PresetButton key={name} name={name} active={preset === name && source.kind === 'preset'}
                        onClick={() => dispatch({ type: 'preset', name })} />
        ))}
      </div>

      <div className={b.sectionLabel}>
        <span>Legs</span>
        <span className={b.sourceTag} data-testid="legs-source">
          {source.kind === 'import' ? `Imported · ${source.label}` : source.kind === 'stress' ? source.label
            : source.kind === 'custom' ? 'Custom' : `Preset · ${source.label}`}
        </span>
      </div>

      {live.expirations.length > 0 && (
        <label className={b.expiry}>
          Listed expiry
          <select className={b.select} value={live.expiry} onChange={e => live.applyExpiry(e.target.value)}>
            <option value="">custom DTE</option>
            {live.expirations.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          {live.chainMsg && <span className={b.subtle}>{live.chainMsg}</span>}
        </label>
      )}

      <div className={b.legs}>
        {legs.map((l, i) => (
          <LegRow key={l.id} leg={l} index={i} state={state} dispatch={dispatch} live={live} canRemove={legs.length > 1} />
        ))}
      </div>

      <div className={b.legActions}>
        <Button size="sm" data-testid="add-leg" disabled={legs.length >= MAX_LEGS}
                onClick={() => dispatch({ type: 'addLeg' })}>+ Add leg</Button>
        <span className={b.subtle} data-testid="leg-count">{legs.length} / {MAX_LEGS} legs</span>
      </div>
    </div>
  );
}
