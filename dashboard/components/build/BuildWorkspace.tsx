'use client';

import { useMemo } from 'react';
import type { Dispatch, ReactNode } from 'react';
import type { PayoffAnalytics } from '@/lib/strategy/portfolio';
import type { McVarResult } from '@/lib/risk/var';
import type { LabResult } from '@/lib/compute/tasks';
import type { TabId, TerminalAction, TerminalState } from '@/components/terminal/useTerminalState';
import { CHART_MODES } from '@/components/terminal/useTerminalState';
import type { LiveData } from '@/components/terminal/useLiveData';
import { Panel } from '@/components/ui/primitives';
import { StrategyBuilder } from '@/components/builder/StrategyBuilder';
import { SurfaceControls } from '@/components/builder/SurfaceControls';
import type { TileQuote } from '@/components/analytics/SummaryTiles';
import { SummaryTiles } from '@/components/analytics/SummaryTiles';
import { spotRange, StrategyChart } from '@/components/analytics/StrategyChart';
import { PnlSurface } from '@/components/analytics/PnlSurface';
import { Glance } from './Glance';
import b from './build.module.css';

/**
 * Build: the position on the left, what it does in the middle, what that means on the right.
 * The Greek tiles above the chart are also the chart's mode switch, so one row of numbers and
 * one chart cover what used to be a row of tiles plus a separate segmented control.
 */
export function BuildWorkspace({ state, dispatch, live, quote, analytics, source, mcVar, lab, labCurrent, onWorkspace, onScenario, onImport }: {
  state: TerminalState; dispatch: Dispatch<TerminalAction>; live: LiveData;
  quote: TileQuote; analytics: PayoffAnalytics; source: ReactNode;
  mcVar: McVarResult | null; lab: LabResult | null; labCurrent: boolean;
  onWorkspace: (id: TabId) => void; onScenario: (id: string) => void; onImport: () => void;
}) {
  const { legs, market } = state;
  const range = useMemo(() => spotRange(legs, state.base.S, market.S), [legs, state.base.S, market.S]);
  const mode = CHART_MODES.find(m => m.id === state.chartMode) ?? CHART_MODES[0];
  const volModel = market.smile && market.term ? 'SSVI surface' : market.smile ? 'SSVI smile'
    : market.term ? 'ATM term structure' : 'flat σ';

  return (
    <div className={b.build}>
      <aside className={b.rail} aria-label="Position and volatility surface">
        <Panel id="builder" title="Position" meta={<span data-testid="builder-position">{state.instrument.sym} · {state.legs.length} leg{state.legs.length === 1 ? '' : 's'}</span>}>
          <StrategyBuilder state={state} dispatch={dispatch} live={live} onImport={onImport} />
        </Panel>
        <Panel id="surface" title="Volatility surface" meta={<span data-testid="builder-vol-model">{volModel}</span>}>
          <SurfaceControls state={state} dispatch={dispatch} live={live} />
        </Panel>
      </aside>

      <div className={b.center}>
        <Panel title="Price &amp; Greeks" flush meta={source}>
          <SummaryTiles quote={quote} legs={legs} market={market} spotRange={range}
                        mode={state.chartMode} onMode={m => dispatch({ type: 'chartMode', mode: m })} />
        </Panel>

        <Panel title={mode.chartTitle} meta={<span>{mode.chartMeta}</span>}>
          <StrategyChart legs={legs} market={market} anchorS={state.base.S} mode={state.chartMode} analytics={analytics} />
        </Panel>

        <Panel title="P&amp;L surface" meta={<span>spot × vol · USD · full revaluation</span>}>
          <PnlSurface legs={legs} market={market} />
        </Panel>
      </div>

      <div className={b.side}>
        <Glance legs={legs} market={market} analytics={analytics} mcVar={mcVar} lab={lab} labCurrent={labCurrent}
                onWorkspace={onWorkspace} onScenario={onScenario} />
      </div>
    </div>
  );
}
