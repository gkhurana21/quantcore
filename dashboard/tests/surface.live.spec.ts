/**
 * Whole-surface calibration on live option chains, through the Go proxy. Skipped unless SURFACE_LIVE=1 with
 * proxy/ running on :8080. No credentials are read here — the proxy holds them.
 *
 *   ./proxy/dev.sh
 *   cd dashboard && SURFACE_LIVE=1 npx playwright test -c playwright.unit.config.ts tests/surface.live.spec.ts
 */

import { test, expect } from '@playwright/test';
import type { LiveChain } from '../lib/market/marketData';
import { loadSurfaceSlices, pickSurfaceExpiries } from '../lib/market/surfaceData';
import { calibrateSmile, calibrateSurface } from '../lib/quant/calibrate';
import type { Market } from '../lib/quant/types';
import { atmVariance, validSmile, validTerm } from '../lib/quant/volSurface';

const live = process.env.SURFACE_LIVE === '1';
const PROXY = 'http://localhost:8080';
const R = 0.045;   // the terminal's reference rate

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${PROXY}${path}`);
  if (!res.ok) throw new Error(`proxy ${res.status} ${path}`);
  return (await res.json()) as T;
}

test.describe('surface fit on live option chains (Go proxy)', () => {
  test.skip(!live, 'set SURFACE_LIVE=1 and run proxy/dev.sh');

  for (const sym of ['SPY', 'QQQ', 'AAPL']) {
    test(`${sym}: one arbitrage-free surface across a week to a year and a half`, async () => {
      test.setTimeout(120_000);
      const { last: S } = await get<{ last: number }>(`/v1/quote?symbol=${sym}`);
      const { expirations } = await get<{ expirations: string[] }>(`/v1/expirations?symbol=${sym}`);
      const expiries = pickSurfaceExpiries(expirations);
      const t0 = performance.now();
      const { slices, failed } = await loadSurfaceSlices(sym, expiries, S, R, 0, Date.now(),
        (s, e) => get<LiveChain>(`/v1/chain?symbol=${encodeURIComponent(s)}&expiration=${e}`));
      const loadMs = performance.now() - t0;
      const t1 = performance.now();
      const cal = calibrateSurface(slices, S, R, 0)!;
      const fitMs = performance.now() - t1;

      console.log(`  ${sym} ${S}: ${expiries.length} expiries, ${failed.length} failed, ${cal.quotes} quotes · chains ${loadMs.toFixed(0)} ms · fit ${fitMs.toFixed(0)} ms`);
      console.log(`    σ30 ${(cal.sigma * 100).toFixed(2)}% · ρ ${cal.smile.rho.toFixed(3)} · η ${cal.smile.eta.toFixed(3)} · γ ${cal.smile.gamma.toFixed(3)}` +
                  ` · RMSE ${cal.rmseVolPts.toFixed(2)} (max ${cal.maxErrVolPts.toFixed(2)}) vol pts · pooled ${cal.pooled} · at limit ${cal.atLimit}`);
      for (const s of cal.slices) {
        const alone = calibrateSmile(s.points.map(p => ({ K: p.K, iv: p.ivMarket, call: p.call })), S, R, 0, s.T, 0.5)!;
        console.log(`    ${s.expiry} ${String(Math.round(s.T * 365)).padStart(3)}d · ${String(s.points.length).padStart(3)} quotes · ATM ${(s.atmVol * 100).toFixed(2)}%` +
                    ` (market ${s.marketAtmVol ? `${(s.marketAtmVol * 100).toFixed(2)}%` : '—'}) · RMSE ${s.rmseVolPts.toFixed(2)} · this expiry alone ${alone.rmseVolPts.toFixed(2)}`);
      }

      expect(failed).toEqual([]);
      expect(cal.slices.length).toBeGreaterThanOrEqual(5);
      expect(validSmile(cal.smile)).toBe(true);
      expect(validTerm(cal.term!)).toBe(true);
      expect(cal.rmseVolPts).toBeLessThan(3);
      const m: Market = { S, sigma: cal.sigma, r: R, q: 0, smile: cal.smile, term: cal.term };
      for (let i = 1; i < cal.slices.length; i++) {
        expect(atmVariance(m, cal.slices[i].T)).toBeGreaterThanOrEqual(atmVariance(m, cal.slices[i - 1].T));
      }
    });
  }
});
