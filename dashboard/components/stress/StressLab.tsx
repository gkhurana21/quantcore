'use client';

import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import type { Scenario, Shock } from '@/lib/risk/stress';
import { SCENARIOS, stressReport } from '@/lib/risk/stress';
import { shiftLegs } from '@/lib/strategy/portfolio';
import { legLabel } from '@/lib/strategy/labels';
import { num, pct, signed, signedPct, usd, usdSigned } from '@/lib/format';
import { AnimatedNumber, Button, cx, SliderField, ui } from '@/components/ui/primitives';
import st from './stress.module.css';

export const CUSTOM_SCENARIO = 'custom';

const sgn = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±');

export function shockText(s: Shock): string {
  const parts = [`S ${sgn(s.spotPct)}${Math.abs(s.spotPct)}%`];
  if (s.volMult !== 1) parts.push(`σ ×${s.volMult}`);
  if (s.volPts !== 0 || s.volMult === 1) parts.push(`σ ${sgn(s.volPts)}${Math.abs(s.volPts)}pt`);
  if (s.rateBp) parts.push(`r ${sgn(s.rateBp)}${Math.abs(s.rateBp)}bp`);
  if (s.days) parts.push(`+${s.days}d`);
  return parts.join(' · ');
}

function Move({ before, after, format, testid }: {
  before: number; after: number; format: (v: number) => string; testid?: string;
}) {
  return (
    <div className={st.move}>
      <span className={st.before}>{format(before)}</span>
      <span className={st.arrow} aria-hidden="true">→</span>
      <AnimatedNumber value={after} format={format} className={st.after} testid={testid} />
    </div>
  );
}

function Stage({ n, title, pulseKey, children }: { n: number; title: string; pulseKey: string; children: ReactNode }) {
  return (
    <div className={st.stage}>
      <span key={pulseKey} className={st.stagePulse} style={{ animationDelay: `${(n - 1) * 110}ms` }} aria-hidden="true" />
      <div className={st.stageHead}><span className={st.stageNum}>{n}</span>{title}</div>
      {children}
    </div>
  );
}

export function StressLab({ legs, market, scenarioId, onScenario, onApply, onRestore, canRestore }: {
  legs: Leg[]; market: Market; scenarioId: string; onScenario: (id: string) => void;
  onApply: (market: Market, legs: Leg[], label: string) => void; onRestore: () => void; canRestore: boolean;
}) {
  const [custom, setCustom] = useState<Shock>({ spotPct: -15, volPts: 20, volMult: 1, rateBp: 0, days: 0 });
  const cards: Scenario[] = useMemo(() => [...SCENARIOS, {
    id: CUSTOM_SCENARIO, name: 'Custom shock', tag: 'Custom',
    description: 'Set your own instantaneous spot, volatility and rate shocks, plus days of time decay.', shock: custom,
  }], [custom]);
  const current = cards.find(c => c.id === scenarioId) ?? cards[0];
  const shock = current.shock;
  const rep = useMemo(() => stressReport(legs, market, shock), [legs, market, shock]);
  const matrix = useMemo(() => cards.map(c => ({ ...c, rep: stressReport(legs, market, c.shock) })), [cards, legs, market]);
  const pulseKey = `${current.id}|${shockText(shock)}`;
  const maxLeg = Math.max(1, ...rep.pnlByLeg.map(Math.abs));
  const maxLadder = Math.max(1, ...rep.ladder.map(p => Math.abs(p.pnl)));
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const j = (i + dir + cards.length) % cards.length;
    onScenario(cards[j].id);
    refs.current[j]?.focus();
  };
  const setC = (patch: Partial<Shock>) => setCustom(c => ({ ...c, ...patch }));

  return (
    <div>
      {canRestore && (
        <div className={st.banner} role="status">
          The terminal is showing a stressed market — shocks below apply on top of it.
          <Button size="sm" onClick={onRestore} data-testid="stress-restore-banner">Reset to base</Button>
        </div>
      )}

      <div className={st.cards} role="radiogroup" aria-label="Stress scenario">
        {cards.map((c, i) => (
          <button key={c.id} ref={el => { refs.current[i] = el; }} type="button" role="radio"
                  aria-checked={c.id === current.id} tabIndex={c.id === current.id ? 0 : -1}
                  className={st.card} data-testid={`scenario-${c.id}`}
                  onClick={() => onScenario(c.id)} onKeyDown={e => onKey(e, i)}>
            <span className={st.cardTag}>{c.tag}</span>
            <span className={st.cardName}>{c.name}</span>
            <span className={st.cardShock}>{shockText(c.shock)}</span>
          </button>
        ))}
      </div>
      <p className={st.desc}>{current.description}</p>

      {current.id === CUSTOM_SCENARIO && (
        <div className={st.custom}>
          <SliderField label="Spot shock" value={custom.spotPct} min={-50} max={50} step={1} testid="custom-spot"
                       format={v => `${v > 0 ? '+' : ''}${v}%`} onChange={v => setC({ spotPct: v })} inputDecimals={0} />
          <SliderField label="Vol shock" value={custom.volPts} min={-30} max={80} step={1} testid="custom-vol"
                       format={v => `${v > 0 ? '+' : ''}${v} pts`} onChange={v => setC({ volPts: v })} inputDecimals={0} />
          <SliderField label="Rate shock" value={custom.rateBp} min={-300} max={300} step={25} testid="custom-rate"
                       format={v => `${v > 0 ? '+' : ''}${v} bp`} onChange={v => setC({ rateBp: v })} inputDecimals={0} />
          <SliderField label="Days elapsed" value={custom.days} min={0} max={90} step={1} testid="custom-days"
                       format={v => `${v}d`} onChange={v => setC({ days: v })} inputDecimals={0} />
        </div>
      )}

      <div className={st.pipeline} data-testid="stress-pipeline">
        <Stage n={1} title="Spot" pulseKey={pulseKey}>
          <Move before={rep.before.S} after={rep.after.S} format={v => num(v, 2)} testid="stress-spot-after" />
          <div className={st.sub}>{signedPct(rep.shocked.S / rep.base.S - 1)}</div>
        </Stage>
        <Stage n={2} title="Volatility" pulseKey={pulseKey}>
          <Move before={rep.before.sigma} after={rep.after.sigma} format={v => pct(v, 1)} testid="stress-vol-after" />
          <div className={st.sub}>r {pct(rep.before.r, 2)} → {pct(rep.after.r, 2)}{shock.days ? ` · +${shock.days}d` : ''}</div>
        </Stage>
        <Stage n={3} title="Greeks" pulseKey={pulseKey}>
          <Move before={rep.before.delta} after={rep.after.delta} format={v => `${signed(v, 0)} Δ`} testid="stress-delta-after" />
          <div className={st.greekLine}><span>Γ</span><span>{signed(rep.before.gamma, 2)} → {signed(rep.after.gamma, 2)}</span></div>
          <div className={st.greekLine}><span>Vega/pt</span><span>{usdSigned(rep.before.vega * 0.01)} → {usdSigned(rep.after.vega * 0.01)}</span></div>
        </Stage>
        <Stage n={4} title="P&L" pulseKey={pulseKey}>
          <AnimatedNumber value={rep.pnl} format={v => usdSigned(v)} testid="stress-pnl"
                          className={cx(st.big, rep.pnl > 0.5 ? 'pos' : rep.pnl < -0.5 ? 'neg' : undefined)} />
          <div className={st.sub}>{rep.pnlPct == null ? 'mark-to-model change' : `${signedPct(rep.pnlPct, 1)} of gross premium`}</div>
        </Stage>
        <Stage n={5} title="1-day 95% VaR" pulseKey={pulseKey}>
          <div className={st.move}>
            <span className={st.before} data-testid="stress-var-before" data-value={rep.before.var95}>{usd(rep.before.var95)}</span>
            <span className={st.arrow} aria-hidden="true">→</span>
            <AnimatedNumber value={rep.after.var95} format={v => usd(v)} className={st.after} testid="stress-var-after" />
          </div>
          <div className={st.sub}>delta-normal at the shocked market</div>
        </Stage>
      </div>

      <div className={st.two}>
        <div className={st.box}>
          <div className={st.boxHead}><span>P&amp;L by leg</span><span>full revaluation</span></div>
          <div className={st.legBars} data-testid="stress-legs">
            {legs.map((lg, i) => {
              const v = rep.pnlByLeg[i] ?? 0;
              const w = (Math.abs(v) / maxLeg) * 50;
              return (
                <div key={lg.id} className={st.legBar} data-testid="stress-leg-bar">
                  <span className={st.legName}>{i + 1} · {legLabel(lg)}</span>
                  <span className={st.barTrack} aria-hidden="true">
                    <span className={cx(st.barFill, v >= 0 ? st.barPos : st.barNeg)}
                          style={v >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
                  </span>
                  <span className={cx(st.legVal, v > 0.5 ? 'pos' : v < -0.5 ? 'neg' : undefined)}>{usdSigned(v)}</span>
                </div>
              );
            })}
          </div>
        </div>
        <div className={st.box}>
          <div className={st.boxHead}><span>P&amp;L vs spot move</span><span>at shocked vol &amp; rate · %</span></div>
          <div className={st.ladder} data-testid="stress-ladder" role="img"
               aria-label={`Portfolio P&L for spot moves from −40% to +40% at the shocked volatility. Largest loss ${usdSigned(Math.min(...rep.ladder.map(p => p.pnl)))}.`}>
            {rep.ladder.map(p => {
              const h = (Math.abs(p.pnl) / maxLadder) * 50;
              const near = Math.abs(p.spotPct - shock.spotPct) < 2.5;
              return (
                <div key={p.spotPct} className={cx(st.rung, near && st.rungActive)} title={`Spot ${p.spotPct > 0 ? '+' : ''}${p.spotPct}%: ${usdSigned(p.pnl)}`}>
                  <div className={st.rungTrack}>
                    <span className={cx(st.rungBar, p.pnl >= 0 ? st.barPos : st.barNeg)}
                          style={p.pnl >= 0 ? { bottom: '50%', height: `${h}%` } : { top: '50%', height: `${h}%` }} />
                  </div>
                  <span className={st.rungLabel}>{p.spotPct}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className={cx(ui.tableWrap, st.matrixWrap)}>
        <table className={ui.table} data-testid="stress-matrix">
          <thead>
            <tr>
              <th>Scenario</th><th className={ui.num}>Spot</th><th className={ui.num}>Vol</th><th className={ui.num}>Rate</th>
              <th className={ui.num}>P&amp;L</th><th className={ui.num}>% premium</th><th className={ui.num}>Δ after</th>
              <th className={ui.num}>VaR after</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map(m => (
              <tr key={m.id} className={m.id === current.id ? st.matrixActive : undefined}>
                <td><button type="button" className={st.matrixBtn} onClick={() => onScenario(m.id)}>{m.name}</button></td>
                <td className={ui.num}>{num(m.rep.shocked.S, 2)}</td>
                <td className={ui.num}>{pct(m.rep.shocked.sigma, 1)}</td>
                <td className={ui.num}>{pct(m.rep.shocked.r, 2)}</td>
                <td className={cx(ui.num, m.rep.pnl > 0.5 ? 'pos' : m.rep.pnl < -0.5 ? 'neg' : undefined)}>{usdSigned(m.rep.pnl)}</td>
                <td className={ui.num}>{m.rep.pnlPct == null ? '—' : signedPct(m.rep.pnlPct, 1)}</td>
                <td className={ui.num}>{signed(m.rep.after.delta, 0)}</td>
                <td className={ui.num}>{usd(m.rep.after.var95)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={st.actions}>
        <Button variant="primary" data-testid="stress-apply"
                onClick={() => onApply(rep.shocked, shiftLegs(legs, shock.days / 365), `Stress · ${current.name}`)}>
          Apply to terminal
        </Button>
        <Button data-testid="stress-restore" disabled={!canRestore} onClick={onRestore}>Reset to base</Button>
      </div>
      <p className={st.disclaimer}>
        Illustrative, instantaneous shocks in the spirit of historical episodes — not calibrated replays of them. Every
        leg is fully repriced with Black-Scholes at the shocked spot, volatility and rate (rates floor at 0%). The
        volatility surface is assumed flat, so skew steepening in a crash is not modelled.
      </p>
    </div>
  );
}
