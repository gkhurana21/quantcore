'use client';

import type { Dispatch } from 'react';
import { useRef } from 'react';
import type { TerminalAction, TerminalState } from '@/components/terminal/useTerminalState';
import { spotBounds } from '@/components/builder/MarketControls';
import { days, num, pct, usd, usdSigned } from '@/lib/format';
import { firstExpiry } from '@/lib/strategy/portfolio';
import { cx } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/Icon';
import { useScrub } from '@/components/ui/useScrub';
import s from './layout.module.css';

/** "Preset · Iron Condor", "Imported · broker-export.csv", "Stress · COVID-style Crash". */
function sourceLabel(src: TerminalState['source']): string {
  return src.kind === 'import' ? `Imported · ${src.label}`
    : src.kind === 'stress' ? src.label
    : src.kind === 'custom' ? 'Custom position'
    : `Preset · ${src.label}`;
}

/** "P 715 · P 735 · C 775 · C 795 · ×10 · 47d", shortened when there are more legs than fit. */
function legsSummary(st: TerminalState): string {
  const shown = st.legs.slice(0, 4).map(l => `${l.call ? 'C' : 'P'} ${+l.K.toFixed(2)}`);
  const more = st.legs.length - shown.length;
  const qty = new Set(st.legs.map(l => l.qty));
  const parts = [shown.join(' · ') + (more > 0 ? ` +${more}` : '')];
  if (qty.size === 1) parts.push(`×${st.legs[0].qty}`);
  parts.push(`${days(firstExpiry(st.legs))}d`);
  return parts.join(' · ');
}

/** A market number you can drag sideways to change, and click to open where it can be set exactly. */
function Scrub({ label, symbol, value, display, delta, min, max, step, pxPerStep, onChange, onOpen, testid, className }: {
  label: string; symbol?: string; value: number; display: string; delta?: string | null;
  min: number; max: number; step: number; pxPerStep?: number;
  onChange: (v: number) => void; onOpen: (anchor: HTMLElement | null) => void; testid: string; className?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const { scrubbing, handlers } = useScrub({ value, min, max, step, pxPerStep, onChange, onClick: () => onOpen(ref.current) });
  return (
    <button type="button" ref={ref} className={cx(s.scrub, scrubbing && s.scrubActive, className)} {...handlers}
            aria-label={`${label} ${display} — drag to change, click for the market controls`}>
      <span className={s.scrubLabel}>
        {label}{symbol ? <> <span className={s.scrubSym}>{symbol}</span></> : null}
        {delta ? <> <span className={s.scrubDelta}>{delta}</span></> : null}
      </span>
      <span className={s.scrubValue} data-testid={testid}>{display}</span>
    </button>
  );
}

/**
 * The strip under the bar: which market, which position, what it is worth — on every workspace, so
 * the research views never make you scroll back to see what they are about. Market numbers scrub
 * under the pointer; a click opens the sheet where they can be typed.
 */
export function PositionStrip({ state, dispatch, value, pnl, volModel, onOpenMarket, onOpenSurface }: {
  state: TerminalState; dispatch: Dispatch<TerminalAction>;
  value: number; pnl: number; volModel: string;
  onOpenMarket: (anchor: HTMLElement | null) => void; onOpenSurface: (anchor: HTMLElement | null) => void;
}) {
  const { instrument: inst, market: m, base } = state;
  const [lo, hi] = spotBounds(base.S, inst.step);
  const set = (patch: Partial<typeof m>) => dispatch({ type: 'market', patch });
  const tickerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLButtonElement | null>(null);
  const spot = useScrub({ value: m.S, min: lo, max: hi, step: inst.step, pxPerStep: 4,
                          onChange: S => set({ S }), onClick: () => onOpenMarket(tickerRef.current) });
  const smileName = m.smile ? 'Smile' : 'Flat';
  const termName = m.term ? (m.term.kind === 'fitted' ? 'Fitted' : 'Curve') : 'Flat';

  return (
    <div className={s.stripWrap}>
      <div className={s.strip} role="group" aria-label="Current market">
        <button type="button" ref={tickerRef} className={cx(s.ticker, spot.scrubbing && s.scrubActive)} {...spot.handlers}
                aria-label={`${inst.sym} at ${num(m.S, 2)} — drag to move spot, click for the market controls`}>
          <span className={s.tickerTop}>
            <span className={s.tickerSym}>{inst.sym}</span>
            <span className={s.tickerSpot} data-testid="spot-display">{num(m.S, 2)}</span>
            <span className={s.tickerCaret}><Icon name="caret" size={12} /></span>
          </span>
          <span className={s.tickerName} data-testid="instrument-name">{inst.name}</span>
        </button>

        <div className={s.chips}>
          <Scrub label={m.term ? 'Vol · 30d' : 'Vol'} symbol="σ" value={m.sigma} min={0.01} max={1.5} step={0.005}
                 display={pct(m.sigma, 1)} testid="vol-display" onChange={sigma => set({ sigma })} onOpen={onOpenMarket}
                 delta={m.sigma !== base.sigma ? `${m.sigma > base.sigma ? '+' : '−'}${Math.abs((m.sigma - base.sigma) * 100).toFixed(1)}pt` : null} />
          <Scrub label="Rate" symbol="r" value={m.r} min={0} max={0.15} step={0.0005} className={s.p3} pxPerStep={3}
                 display={pct(m.r, 2)} testid="rate-display" onChange={r => set({ r })} onOpen={onOpenMarket} />
          <Scrub label="Div" symbol="q" value={m.q} min={0} max={0.08} step={0.0005} className={s.p4} pxPerStep={3}
                 display={pct(m.q, 2)} testid="q-display" onChange={q => set({ q })} onOpen={onOpenMarket} />
          <button type="button" ref={surfaceRef} className={cx(s.scrub, s.p2)} style={{ cursor: 'pointer' }}
                  onClick={() => onOpenSurface(surfaceRef.current)}
                  aria-label={`Volatility surface: ${volModel} — open the surface controls`}>
            <span className={s.scrubLabel}>Surface</span>
            <span className={s.scrubValue}>{smileName === 'Flat' && termName === 'Flat' ? 'Flat' : `${smileName} · ${termName}`}</span>
          </button>
        </div>

        <span className={s.stripDivider} aria-hidden="true" />

        <div className={s.position}>
          <span className={s.positionLabel} data-testid="legs-source">{sourceLabel(state.source)}</span>
          <span className={s.positionName}>
            {state.legs.length} leg{state.legs.length === 1 ? '' : 's'}{' '}
            <span className={s.positionLegs}>{legsSummary(state)}</span>
          </span>
        </div>

        <div className={s.metrics}>
          <div className={s.metric}>
            <span className={s.metricLabel}>Value</span>
            <span className={s.metricValue}>{usd(value)}</span>
          </div>
          <div className={s.metric}>
            <span className={s.metricLabel}>P&amp;L</span>
            <span className={cx(s.metricValue, pnl > 0.5 ? 'pos' : pnl < -0.5 ? 'neg' : undefined)}>{usdSigned(pnl)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
