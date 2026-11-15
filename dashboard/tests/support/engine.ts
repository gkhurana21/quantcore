// The native C++ engine (ws://localhost:8765) exists only on a machine that has built it. Specs that need it call
// needsEngine() first:
//   - `npm run test:e2e` (default): skipped, with the reason printed, when nothing answers on the port; run when
//     something does.
//   - `npm run test:e2e:engine` (QC_ENGINE=1): the engine server is started by playwright.config.ts and an
//     unreachable engine FAILS the run (global-setup.ts). It never skips.
import { expect, test } from '@playwright/test';

export const ENGINE_REQUIRED = process.env.QC_ENGINE === '1';
export const engineUp = (): boolean => process.env.QC_ENGINE_UP === '1';

export const ENGINE_SKIP_REASON =
  'needs the native C++ engine at ws://localhost:8765 (build it, then `npm run test:e2e:engine`)';

export function needsEngine(): void {
  if (ENGINE_REQUIRED) {
    expect(engineUp(), 'QC_ENGINE=1 but nothing answers at ws://localhost:8765: engine specs may not skip in this mode').toBe(true);
    return;
  }
  test.skip(!engineUp(), ENGINE_SKIP_REASON);
}

/** The Python that can `import quantcore` for reference values. PYTHON=… overrides; python3 otherwise. */
export const pythonBin = (): string => process.env.PYTHON ?? 'python3';

/**
 * The browser logs a failed WebSocket connection as a console error. With no engine on the port that is the
 * expected state, not an app error, so error watchers ignore exactly that line when the engine is down.
 */
export const isEngineRefusal = (text: string): boolean =>
  !engineUp() && /WebSocket connection to 'ws:\/\/localhost:8765\/ws' failed/.test(text);
