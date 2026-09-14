/**
 * Live parity between the hosted function (lib/market/alpaca.ts) and the Go proxy. Skipped
 * unless ALPACA_LIVE=1 with Alpaca credentials in the environment and proxy/ running on :8080:
 *
 *   ./proxy/dev.sh
 *   cd dashboard && (set -a; . ../proxy/.env.local; set +a; ALPACA_LIVE=1 npx playwright test -c playwright.unit.config.ts tests/alpaca.live.spec.ts)
 *
 * Credentials are read from the environment only and never logged.
 */

import { test, expect } from '@playwright/test';
import { handleMarket, resetMarketState } from '../lib/market/alpaca';

const live = process.env.ALPACA_LIVE === '1' && !!process.env.ALPACA_API_KEY_ID && !!process.env.ALPACA_API_SECRET_KEY;
const env = { ALPACA_API_KEY_ID: process.env.ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY: process.env.ALPACA_API_SECRET_KEY };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const viaFunction = async (p: string): Promise<{ status: number; data: Json }> => {
  const r = await handleMarket(new URL(`https://quantcore-gk.netlify.app/api${p}`), env, 'live-parity');
  return { status: r.status, data: JSON.parse(r.body) };
};
const viaGoProxy = async (p: string): Promise<{ status: number; data: Json }> => {
  const r = await fetch(`http://localhost:8080${p}`);
  return { status: r.status, data: await r.json() };
};

test.describe('hosted function vs Go proxy (live Alpaca)', () => {
  test.skip(!live, 'set ALPACA_LIVE=1 with Alpaca credentials in the environment and run proxy/dev.sh');
  test.beforeEach(() => resetMarketState());

  for (const sym of ['SPY', 'AMD', 'BRK.B']) {
    test(`${sym}: quote, expirations and the nearest chain match`, async () => {
      test.setTimeout(90_000);
      const [q, gq] = await Promise.all([viaFunction(`/v1/quote?symbol=${sym}`), viaGoProxy(`/v1/quote?symbol=${sym}`)]);
      expect(q.status).toBe(gq.status);
      if (q.status !== 200) return;
      expect(q.data.prevClose).toBe(gq.data.prevClose);
      expect(Math.abs(q.data.last - gq.data.last) / gq.data.last).toBeLessThan(0.01);   // the Go proxy caches quotes for 60 s

      const [e, ge] = await Promise.all([viaFunction(`/v1/expirations?symbol=${sym}`), viaGoProxy(`/v1/expirations?symbol=${sym}`)]);
      expect(e.status).toBe(ge.status);
      if (e.status !== 200) return;
      expect(e.data.expirations).toEqual(ge.data.expirations);

      const exp = e.data.expirations[0];
      const [c, gc] = await Promise.all([viaFunction(`/v1/chain?symbol=${sym}&expiration=${exp}`),
                                         viaGoProxy(`/v1/chain?symbol=${sym}&expiration=${exp}`)]);
      expect(c.status).toBe(gc.status);
      const contracts = (d: Json) => d.options.map((o: Json) => `${o.type} ${o.strike} ${o.openInterest}`);
      expect(contracts(c.data)).toEqual(contracts(gc.data));
      console.log(`  ${sym}: last ${q.data.last} · ${e.data.expirations.length} expirations · ${c.data.options.length} contracts on ${exp} — same as the Go proxy`);
    });
  }
});
