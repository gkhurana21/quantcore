'use client';

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Leg, Market } from '@/lib/quant/types';
import type { PayoffAnalytics } from '@/lib/strategy/portfolio';
import { grossPremium, netPremium, profitOutlook } from '@/lib/strategy/portfolio';
import { SCENARIOS, stressReport } from '@/lib/risk/stress';
import { deltaGammaVaR, deltaNormalVaR, horizonVol } from '@/lib/risk/var';
import type { McVarResult } from '@/lib/risk/var';
import type { LabResult } from '@/lib/compute/tasks';
import { Z95 } from '@/components/lab/labFormat';
import { days, num, pct, signed, usd, usdSigned } from '@/lib/format';
import type { TabId } from '@/components/terminal/useTerminalState';
import { Badge, cx } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/Skeleton';
import { Icon } from '@/components/ui/Icon';
import g from './build.module.css';

const RANGE = 0.08;   // the profit-range bar spans spot ±8%

function Section({ title, to, go, onGo, children }: {
  title: string; to?: TabId; go?: string; onGo?: (id: TabId) => void; children: ReactNode;
}) {
  const head = (
    <>
      {title}
      {go && <span className={g.glanceGo}>{go}<Icon name="arrow" size={13} /></span>}
    </>
  );
  return (
    <section className={g.glanceSection}>
      {to && onGo
        ? <a className={g.glanceSectionHead} href={`#${to}`} onClick={e => { e.preventDefault(); onGo(to); }}>{head}</a>
        : <div className={g.glanceSectionHead}>{head}</div>}
      {children}
    </section>
  );
}

const Row = ({ label, value, tone, testid, raw, count }: {
  label: ReactNode; value: ReactNode; tone?: 'pos' | 'neg'; testid?: string; raw?: number | string; count?: number;
}) => (
  <div className={g.row}>
    <span className={g.rowLabel}>{label}</span>
    <span className={cx(g.rowValue, tone)} data-testid={testid} data-value={raw} data-count={count}>{value}</span>
  </div>
);

/**
 * The answer column: what this position makes, how likely that is, what it can lose in a day, what
 * a crash does to it, and whether the models agree about its price. Every heading is a link to the
 * workspace that owns the number, so the terminal's depth is one click from the first screen.
 */
export function Glance({ legs, market, analytics, mcVar, lab, labCurrent, onWorkspace, onScenario }: {
  legs: Leg[]; market: Market; analytics: PayoffAnalytics;
  mcVar: McVarResult | null; lab: LabResult | null; labCurrent: boolean;
  onWorkspace: (id: TabId) => void; onScenario: (id: string) => void;
}) {
  const net = netPremium(legs);
  const be = analytics.breakevens;
  const outlook = useMemo(() => profitOutlook(legs, market, analytics), [legs, market, analytics]);
  const dn = useMemo(() => deltaNormalVaR(legs, market, 0.95, 1), [legs, market]);
  const dg = useMemo(() => deltaGammaVaR(legs, market, 0.95, 1), [legs, market]);
  const stress = useMemo(() => SCENARIOS
    .map(s => ({ id: s.id, name: s.name, pnl: stressReport(legs, market, s.shock).pnl }))
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 3), [legs, market]);
  const worst = Math.min(-1, ...stress.map(s => s.pnl));

  const rr = analytics.maxProfitUnbounded || analytics.maxLossUnbounded || !analytics.maxLoss
    ? null : Math.abs(analytics.maxProfit / analytics.maxLoss);
  // the profit band between the first and last break-even, as a share of a ±8% spot window
  const at = (S: number) => Math.min(1, Math.max(0, (S / market.S - 1 + RANGE) / (2 * RANGE)));
  const zone = be.length ? { from: at(be[0]), to: at(be[be.length - 1]) } : null;

  const mc200 = lab?.mc[lab.mc.length - 1];
  const z = mc200 && lab && mc200.se > 0 ? Math.abs(mc200.price - lab.bs.value) / mc200.se : null;
  const crrBp = lab && lab.gross > 0 ? ((lab.crr.value - lab.bs.value) / lab.gross) * 1e4 : null;
  const eep = lab ? lab.american.value - lab.crr.value : null;

  return (
    <section className={g.glancePanel} aria-labelledby="glance-title">
      <div className={g.glanceHead}>
        <h2 className={g.glanceTitle} id="glance-title">At a glance</h2>
        <span className={g.glanceMeta}>{legs.length} leg{legs.length === 1 ? '' : 's'} · {days(analytics.horizonT)}d</span>
      </div>

      <div className={g.glanceSections}>
        <Section title={analytics.exact ? 'Payoff at expiry' : 'Payoff at first expiry'}>
          <Row label={net >= 0 ? 'Net debit' : 'Net credit'} value={usd(Math.abs(net))} testid="net-premium" raw={net} />
          <Row label="Max profit" tone="pos" testid="max-profit"
               raw={analytics.maxProfitUnbounded ? 'unbounded' : analytics.maxProfit}
               value={analytics.maxProfitUnbounded ? 'Unlimited' : usdSigned(analytics.maxProfit)} />
          <Row label="Max loss" tone="neg" testid="max-loss"
               raw={analytics.maxLossUnbounded ? 'unbounded' : analytics.maxLoss}
               value={analytics.maxLossUnbounded ? 'Unlimited' : usdSigned(analytics.maxLoss)} />
          <Row label={`Break-even${be.length === 1 ? '' : 's'}`} testid="breakevens" count={be.length}
               value={be.length ? be.map(b => num(b, 2)).join(' · ') : '—'} />
          <Row label="Gross premium" value={usd(grossPremium(legs))} />
          {rr != null && <Row label="Reward : risk" value={`${rr.toFixed(2)}×`} />}
          {zone && (
            <div className={g.range} role="img"
                 aria-label={`Profitable between ${be.map(b => num(b, 2)).join(' and ')}, on a scale of spot plus or minus 8 per cent`}>
              <div className={g.rangeTrack}>
                <span className={g.rangeBase} />
                <span className={g.rangeZone} style={{ left: `${zone.from * 100}%`, width: `${Math.max(1, (zone.to - zone.from) * 100)}%` }} />
                <span className={g.rangeSpot} style={{ left: '50%' }} />
              </div>
              <div className={g.rangeLabels} aria-hidden="true">
                <span style={{ left: 0 }}>−8%</span>
                <span style={{ left: '50%', transform: 'translateX(-50%)', color: 'var(--amber-2)' }}>spot</span>
                <span style={{ right: 0 }}>+8%</span>
              </div>
            </div>
          )}
        </Section>

        <Section title={`Probability · ${days(analytics.horizonT)}d`} to="mc" go="Simulate" onGo={onWorkspace}>
          <div className={g.big}>
            <span className={g.rowLabel}>P(profit), risk-neutral</span>
            <span className={g.bigValue}>{pct(outlook.pProfit, 1)}</span>
          </div>
          <div className={g.meter} aria-hidden="true"><div className={g.meterFill} style={{ width: `${outlook.pProfit * 100}%` }} /></div>
          <Row label="Expected P&amp;L" value={usdSigned(outlook.expectedPnl)} />
          <Row label="1σ daily move" value={`±${usd(market.S * horizonVol(market.sigma, 1), 2)}`} />
        </Section>

        <Section title="Risk · 1-day 95%" to="risk" go="Risk" onGo={onWorkspace}>
          <Row label="VaR, delta-normal" value={usd(dn)} />
          <Row label="VaR, delta-gamma" value={usd(dg)} />
          <Row label="VaR, full revaluation" value={mcVar ? usd(mcVar.var) : <Skeleton shape="inline" label="Simulating…" />} />
          <Row label="Expected shortfall" value={mcVar ? usd(mcVar.es) : <Skeleton shape="inline" label="Simulating…" />} />
          {mcVar && dn > 0 && mcVar.var / dn > 1.15 && (
            <p className={g.rowNote}>Convexity costs more than delta says: full revaluation is {(mcVar.var / dn).toFixed(1)}× the linear estimate.</p>
          )}
        </Section>

        <Section title="Stress · worst first" to="stress" go="Stress" onGo={onWorkspace}>
          {stress.map(s => (
            <button key={s.id} type="button" className={g.scenario} data-testid={`glance-scenario-${s.id}`}
                    onClick={() => { onScenario(s.id); onWorkspace('stress'); }}>
              <span className={g.scenarioName}>{s.name.replace(/-style/, '')}</span>
              <span className={g.scenarioTrack} aria-hidden="true">
                <span className={g.scenarioBar} style={{ width: `${Math.min(100, (Math.abs(s.pnl) / Math.abs(worst)) * 100)}%` }} />
              </span>
              <span className={g.scenarioValue}>{usdSigned(s.pnl)}</span>
            </button>
          ))}
        </Section>

        <Section title="Model check" to="lab" go="Price" onGo={onWorkspace}>
          {lab && labCurrent && z != null ? (
            <>
              <div style={{ margin: '2px 0 7px' }}>
                <Badge tone={z <= Z95 ? 'good' : z <= 3 ? 'warn' : 'bad'}>
                  {z <= Z95 ? 'All models within 95% CI' : z <= 3 ? 'Outside 95% CI this draw' : 'Beyond 3σ'}
                </Badge>
              </div>
              <Row label="Monte Carlo 200k" value={`|z| ${z.toFixed(2)}`} />
              {crrBp != null && <Row label="CRR 512 vs BSM" value={`${signed(crrBp, 2)} bp`} />}
              {eep != null && <Row label="Early exercise" value={usdSigned(eep)} tone={eep < -0.5 ? 'neg' : undefined} />}
            </>
          ) : (
            <Skeleton shape="lines" lines={3} label="Pricing the portfolio three ways…" />
          )}
        </Section>
      </div>
    </section>
  );
}
