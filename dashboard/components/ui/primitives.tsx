'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import s from './ui.module.css';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ── Panel ───────────────────────────────────────────────────────────────────

export function Panel({ title, index, meta, children, flush, id, className, bodyClassName }: {
  title: ReactNode; index?: string; meta?: ReactNode; children: ReactNode;
  flush?: boolean; id?: string; className?: string; bodyClassName?: string;
}) {
  const auto = useId();
  const headId = `${id ?? auto}-title`;
  return (
    <section id={id} className={cx(s.panel, className)} aria-labelledby={headId}>
      <header className={s.panelHead}>
        <h2 id={headId} className={s.panelTitle}>
          {index && <span className={s.panelIndex}>{index}</span>}
          {title}
        </h2>
        {meta && <div className={s.panelMeta}>{meta}</div>}
      </header>
      <div className={cx(flush ? s.panelFlush : s.panelBody, bodyClassName)}>{children}</div>
    </section>
  );
}

// ── Segmented (WAI-ARIA radiogroup) ─────────────────────────────────────────

export interface SegOption<T extends string | number> {
  value: T; label: ReactNode; title?: string; disabled?: boolean;
}

export function Segmented<T extends string | number>({
  label, options, value, onChange, size = 'md', accent, full, testid, className,
}: {
  label: string; options: SegOption<T>[]; value: T | null; onChange: (v: T) => void;
  size?: 'sm' | 'md'; accent?: boolean; full?: boolean; testid?: string; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex(o => o.value === value);
  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    let j = i;
    for (let k = 0; k < options.length; k++) {
      j = (j + dir + options.length) % options.length;
      if (!options[j].disabled) break;
    }
    onChange(options[j].value);
    refs.current[j]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} data-testid={testid}
         className={cx(s.seg, size === 'sm' && s.segSm, accent && s.segAccent, full && s.segFull, className)}>
      {options.map((o, i) => (
        <button key={String(o.value)} ref={el => { refs.current[i] = el; }} type="button" role="radio"
                aria-checked={o.value === value}
                tabIndex={o.value === value || (selected < 0 && i === 0) ? 0 : -1}
                disabled={o.disabled} title={o.title}
                data-testid={testid ? `${testid}-${o.value}` : undefined}
                className={s.segBtn}
                onClick={() => onChange(o.value)} onKeyDown={e => onKey(e, i)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Tabs (WAI-ARIA tablist; panels rendered by the parent) ──────────────────

export interface TabDef<T extends string> { id: T; label: string; badge?: boolean; }

export const tabId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

export function Tabs<T extends string>({ tabs, active, onChange, prefix, label, showKeys }: {
  tabs: readonly TabDef<T>[]; active: T; onChange: (id: T) => void; prefix: string; label: string; showKeys?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j < 0) return;
    e.preventDefault();
    onChange(tabs[j].id);
    refs.current[j]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={s.tabs}>
      {tabs.map((t, i) => (
        <button key={t.id} ref={el => { refs.current[i] = el; }} type="button" role="tab"
                id={tabId(prefix, t.id)} aria-controls={tabPanelId(prefix, t.id)}
                aria-selected={t.id === active} tabIndex={t.id === active ? 0 : -1}
                data-testid={`tab-${t.id}`}
                className={s.tab} onClick={() => onChange(t.id)} onKeyDown={e => onKey(e, i)}>
          {t.label}
          {t.badge && <span className={s.tabBadge} aria-hidden="true" />}
          {showKeys && <span className={s.tabKey} aria-hidden="true">{i + 1}</span>}
        </button>
      ))}
    </div>
  );
}

// ── SliderField: range input + click-to-type value ──────────────────────────

export function SliderField({
  label, symbol, value, min, max, step, format, onChange, testid, displayTestid,
  inputScale = 1, inputDecimals = 2, delta, tip, rangeLabels,
}: {
  label: string; symbol?: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
  testid?: string; displayTestid?: string;
  inputScale?: number; inputDecimals?: number;
  delta?: string | null; tip?: string; rangeLabels?: [string, string];
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const id = useId();
  useEffect(() => { if (draft != null) inputRef.current?.select(); }, [draft != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    if (draft == null) return;
    const v = parseFloat(draft.replace(/[,%$\s]/g, ''));
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v / inputScale)));
    setDraft(null);
  };
  const pct = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;

  return (
    <div className={s.field}>
      <div className={s.fieldHead}>
        <label htmlFor={id} className={s.fieldLabel}>{label}</label>
        {symbol && <span className={s.fieldSym}>{symbol}</span>}
        {tip && <InfoTip text={tip} align="start" />}
        {delta ? <span className={s.fieldDelta}>{delta}</span> : <span className={s.fieldDelta} />}
        {draft != null ? (
          <input ref={inputRef} className={s.fieldInput} value={draft} inputMode="decimal"
                 aria-label={`${label} value`}
                 onChange={e => setDraft(e.target.value)} onBlur={commit}
                 onKeyDown={e => {
                   if (e.key === 'Enter') { e.preventDefault(); commit(); }
                   if (e.key === 'Escape') { e.preventDefault(); setDraft(null); }
                 }} />
        ) : (
          <button type="button" className={s.fieldValue} data-testid={displayTestid}
                  title="Click to type a value" aria-label={`${label} ${format(value)} — edit value`}
                  onClick={() => setDraft((value * inputScale).toFixed(inputDecimals))}>
            {format(value)}
          </button>
        )}
      </div>
      <input id={id} type="range" data-testid={testid} min={min} max={max} step={step} value={value}
             aria-valuetext={format(value)}
             style={{ ['--pct' as string]: `${pct}%` }}
             onChange={e => onChange(parseFloat(e.target.value))} />
      {rangeLabels && (
        <div className={s.fieldRange} aria-hidden="true"><span>{rangeLabels[0]}</span><span>{rangeLabels[1]}</span></div>
      )}
    </div>
  );
}

// ── InfoTip ─────────────────────────────────────────────────────────────────

export function InfoTip({ text, align = 'center' }: { text: string; align?: 'center' | 'start' | 'end' }) {
  return (
    <span className={s.tip} tabIndex={0} role="note" aria-label={text}>
      i
      <span className={cx(s.tipBubble, align === 'start' && s.tipStart, align === 'end' && s.tipEnd)}
            aria-hidden="true">{text}</span>
    </span>
  );
}

// ── Badge ───────────────────────────────────────────────────────────────────

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'info';

export function Badge({ tone = 'muted', children, pulse, title, testid, className }: {
  tone?: Tone; children: ReactNode; pulse?: boolean; title?: string; testid?: string; className?: string;
}) {
  return (
    <span className={cx(s.badge, className)} title={title} data-testid={testid}>
      <span className={cx(s.dot, s[tone], pulse && s.pulse)} aria-hidden="true" />
      {children}
    </span>
  );
}

// ── Button ──────────────────────────────────────────────────────────────────

export function Button({ variant = 'default', size = 'md', className, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost'; size?: 'sm' | 'md' }) {
  return (
    <button type="button" {...rest}
            className={cx(s.btn, variant === 'primary' && s.btnPrimary, variant === 'ghost' && s.btnGhost,
                          size === 'sm' && s.btnSm, className)} />
  );
}

// ── AnimatedNumber: eased tween between successive values ───────────────────

export function AnimatedNumber({ value, format, duration = 520, className, testid }: {
  value: number; format: (v: number) => string; duration?: number; className?: string; testid?: string;
}) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const from = fromRef.current, to = value;
    if (from === to || !Number.isFinite(from) || !Number.isFinite(to) || prefersReducedMotion()) {
      fromRef.current = to;
      setShown(to);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const u = Math.min(1, (performance.now() - t0) / duration);
      const v = from + (to - from) * (1 - Math.pow(1 - u, 3));
      fromRef.current = v;
      setShown(v);
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // rAF is paused in background tabs — guarantee the final value lands
    const done = setTimeout(() => { cancelAnimationFrame(raf); fromRef.current = to; setShown(to); }, duration + 60);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [value, duration]);
  return <span className={className} data-testid={testid} data-value={value}>{format(shown)}</span>;
}

// ── Sparkline ───────────────────────────────────────────────────────────────

export function Sparkline({ values, width = 120, height = 28, stroke = 'var(--amber)', label, zero }: {
  values: number[]; width?: number; height?: number; stroke?: string; label: string; zero?: boolean;
}) {
  if (values.length < 2) {
    return <svg width={width} height={height} role="img" aria-label={`${label}: not enough data`} className={s.spark} />;
  }
  let lo = Math.min(...values), hi = Math.max(...values);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-12) { hi += 1; lo -= 1; }
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - lo) / (hi - lo)) * (height - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const last = values[values.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className={s.spark}>
      {zero && <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--line-2)" strokeDasharray="2 3" />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.2} fill={stroke} />
    </svg>
  );
}

export { s as ui, cx };
