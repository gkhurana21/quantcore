/**
 * Hosted market-data function (lib/market/alpaca.ts, served by netlify/functions/market.ts),
 * run in Node against a fake Alpaca: the Go proxy's response shapes, validation, errors,
 * caching and rate limiting — and that every upstream request is a read-only GET to an
 * allowlisted endpoint. The credentials here are fake.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import path from 'path';
import {
  DATA_BASE, handleMarket, isAllowedUpstream, RATE_LIMIT, resetMarketState, TRADING_BASE, TTL,
} from '../lib/market/alpaca';

const ENV = { ALPACA_API_KEY_ID: 'fake-key-id', ALPACA_API_SECRET_KEY: 'fake-secret' };
const NOW = new Date('2026-09-14T15:00:00Z');
const SNAPSHOT = { latestTrade: { p: 756.5 }, latestQuote: { bp: 756.4, ap: 756.62 }, prevDailyBar: { c: 750.25 } };

interface Call { url: URL; method: string; headers: Record<string, string>; }
type Reply = { status?: number; body?: unknown; raw?: string; throws?: boolean };

function alpaca(route: (url: URL) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const r = route(url);
    if (r.throws) throw new TypeError('network down');
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const request = (p: string, fetch: typeof globalThis.fetch,
                 o: { env?: Record<string, string>; client?: string; now?: Date } = {}) =>
  handleMarket(new URL(`https://quantcore-gk.netlify.app/api${p}`), o.env ?? ENV, o.client ?? '203.0.113.7',
               { fetch, now: () => o.now ?? NOW });

const contract = (expiration: string, strike: string, type = 'call', symbol = `SPY-${expiration}-${type}-${strike}`) =>
  ({ symbol, expiration_date: expiration, strike_price: strike, type, open_interest: '42' });

test.describe('hosted market-data function', () => {
  test.beforeEach(() => resetMarketState());

  test('quote: normalised exactly like the Go proxy, from one authenticated GET', async () => {
    const { calls, fetch } = alpaca(u => (u.pathname === '/v2/stocks/SPY/snapshot' ? { body: SNAPSHOT } : { status: 500 }));
    const res = await request('/v1/quote?symbol=spy', fetch);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      symbol: 'SPY', last: 756.5, bid: 756.4, ask: 756.62, prevClose: 750.25, change: 756.5 - 750.25,
      feed: 'iex', asOf: '2026-09-14T15:00:00Z',
    });
    expect(res.cacheSeconds).toBe(TTL.quote);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin).toBe(DATA_BASE);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers['apca-api-key-id']).toBe('fake-key-id');
    expect(calls[0].headers['apca-api-secret-key']).toBe('fake-secret');
  });

  test('quote: previous close fallback, unknown symbols and upstream failures', async () => {
    let reply: Reply = { body: { latestTrade: { p: 0 }, prevDailyBar: { c: 12.5 } } };
    const { fetch } = alpaca(() => reply);
    expect(JSON.parse((await request('/v1/quote?symbol=BRK.B', fetch)).body)).toMatchObject({ symbol: 'BRK.B', last: 12.5, change: 0 });

    const cases: [Reply, number, string][] = [
      [{ body: { latestTrade: { p: 0 }, prevDailyBar: { c: 0 } } }, 404, 'no data for symbol: ZZZ'],
      [{ status: 404 }, 404, 'symbol not found: ZZZ'],
      [{ status: 500 }, 502, 'alpaca returned 500'],
      [{ throws: true }, 502, 'alpaca unreachable: network down'],
      [{ raw: '<html>' }, 502, 'unexpected upstream payload'],
    ];
    for (const [r, status, error] of cases) {
      resetMarketState();
      reply = r;
      const res = await request('/v1/quote?symbol=ZZZ', fetch);
      expect(res.status, error).toBe(status);
      expect(JSON.parse(res.body)).toEqual({ error });
      expect(res.cacheSeconds).toBe(0);
    }
  });

  test('expirations: explicit two-year range, ±5% strike band, paging, dedupe and sort', async () => {
    const { calls, fetch } = alpaca(u => {
      if (u.pathname === '/v2/stocks/SPY/snapshot') return { body: SNAPSHOT };
      if (u.pathname === '/v2/options/contracts') {
        return u.searchParams.get('page_token') === 'p2'
          ? { body: { option_contracts: [contract('2026-10-16', '755'), contract('2026-09-18', '760')], next_page_token: null } }
          : { body: { option_contracts: [contract('2026-12-18', '750'), contract('2026-09-18', '755')], next_page_token: 'p2' } };
      }
      return { status: 500 };
    });
    const res = await request('/v1/expirations?symbol=SPY', fetch);
    expect(JSON.parse(res.body)).toEqual({ symbol: 'SPY', expirations: ['2026-09-18', '2026-10-16', '2026-12-18'] });
    expect(res.cacheSeconds).toBe(TTL.expirations);
    const pages = calls.filter(c => c.url.pathname === '/v2/options/contracts');
    expect(pages).toHaveLength(2);
    expect(Object.fromEntries(pages[0].url.searchParams)).toEqual({
      underlying_symbols: 'SPY', status: 'active', limit: '10000',
      expiration_date_gte: '2026-09-14', expiration_date_lte: '2028-09-14',
      strike_price_gte: String(756.5 * 0.95), strike_price_lte: String(756.5 * 1.05),
    });
    expect(pages[1].url.searchParams.get('page_token')).toBe('p2');
  });

  test('expirations: retries without the strike band, then reports no options', async () => {
    let listed = true;
    const { calls, fetch } = alpaca(u => {
      if (u.pathname.endsWith('/snapshot')) return { body: SNAPSHOT };
      const banded = u.searchParams.has('strike_price_gte');
      return { body: { option_contracts: !banded && listed ? [contract('2027-01-15', '900')] : [], next_page_token: null } };
    });
    expect(JSON.parse((await request('/v1/expirations?symbol=SPY', fetch)).body).expirations).toEqual(['2027-01-15']);
    expect(calls.filter(c => c.url.pathname === '/v2/options/contracts')).toHaveLength(2);

    resetMarketState();
    listed = false;
    const none = await request('/v1/expirations?symbol=SPY', fetch);
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body)).toEqual({ error: 'no options for: SPY' });
  });

  test('chain: contracts joined with paged option snapshots, sorted, IV and Greeks only when quoted', async () => {
    const exp = '2026-10-16';
    const { calls, fetch } = alpaca(u => {
      if (u.pathname === '/v2/options/contracts') {
        return { body: { option_contracts: [contract(exp, '750', 'put', 'P750'), contract(exp, '750', 'call', 'C750'),
                                            contract(exp, '740', 'call', 'C740')], next_page_token: null } };
      }
      if (u.pathname === '/v1beta1/options/snapshots/SPY') {
        return u.searchParams.get('page_token') === 's2'
          ? { body: { snapshots: { P750: { latestQuote: { bp: 9, ap: 9.4 }, latestTrade: { p: 9.2 }, impliedVolatility: null } }, next_page_token: null } }
          : { body: { snapshots: { C750: { latestQuote: { bp: 18, ap: 18.3 }, latestTrade: { p: 18.1 }, impliedVolatility: 0.141,
                                           greeks: { delta: 0.55, gamma: 0.011, theta: -0.21, vega: 1.06 } } }, next_page_token: 's2' } };
      }
      return { status: 500 };
    });
    const res = await request(`/v1/chain?symbol=SPY&expiration=${exp}`, fetch);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      symbol: 'SPY', expiration: exp, feed: 'indicative',
      options: [
        { symbol: 'C740', type: 'call', strike: 740, bid: 0, ask: 0, last: 0, openInterest: 42 },
        { symbol: 'C750', type: 'call', strike: 750, bid: 18, ask: 18.3, last: 18.1, openInterest: 42,
          iv: 0.141, delta: 0.55, gamma: 0.011, theta: -0.21, vega: 1.06 },
        { symbol: 'P750', type: 'put', strike: 750, bid: 9, ask: 9.4, last: 9.2, openInterest: 42 },
      ],
    });
    const snapCalls = calls.filter(c => c.url.pathname.startsWith('/v1beta1/'));
    expect(snapCalls).toHaveLength(2);
    expect(Object.fromEntries(snapCalls[0].url.searchParams)).toEqual({ feed: 'indicative', limit: '1000', expiration_date: exp });
    expect(calls.find(c => c.url.pathname === '/v2/options/contracts')!.url.searchParams.get('expiration_date')).toBe(exp);
  });

  test('health, validation and missing credentials never call Alpaca', async () => {
    const { calls, fetch } = alpaca(() => ({ status: 500 }));
    expect(await request('/healthz', fetch)).toMatchObject({ status: 200, body: 'ok', cacheSeconds: 0 });
    expect(await request('/healthz', fetch, { env: {} })).toMatchObject({ status: 200, body: 'not configured' });
    expect((await request('/v1/quote?symbol=SPY', fetch, { env: {} })).status).toBe(503);
    expect((await request('/v1/quote?symbol=', fetch)).status).toBe(400);
    expect((await request('/v1/quote?symbol=1ABC', fetch)).status).toBe(400);
    expect((await request('/v1/quote?symbol=TOOLONGSYMB', fetch)).status).toBe(400);
    expect((await request('/v1/chain?symbol=SPY&expiration=next-friday', fetch)).status).toBe(400);
    expect((await request('/v2/orders', fetch)).status).toBe(404);
    expect((await request('/v1/search?q=nvda', fetch)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('responses are cached for the Go proxy TTLs; failures are not cached', async () => {
    let fail = true;
    const { calls, fetch } = alpaca(() => (fail ? { status: 500 } : { body: SNAPSHOT }));
    expect((await request('/v1/quote?symbol=SPY', fetch)).status).toBe(502);
    fail = false;
    expect((await request('/v1/quote?symbol=SPY', fetch)).status).toBe(200);
    const again = await request('/v1/quote?symbol=SPY', fetch, { now: new Date(NOW.getTime() + 20_000) });
    expect(again.status).toBe(200);
    expect(again.cacheSeconds).toBe(TTL.quote - 20);
    expect(calls).toHaveLength(2);
    await request('/v1/quote?symbol=SPY', fetch, { now: new Date(NOW.getTime() + (TTL.quote + 1) * 1000) });
    expect(calls).toHaveLength(3);
  });

  test('each client is rate-limited per window; other clients are unaffected', async () => {
    const { fetch } = alpaca(() => ({ body: SNAPSHOT }));
    for (let i = 0; i < RATE_LIMIT.requests; i++) expect((await request('/v1/quote?symbol=SPY', fetch)).status).toBe(200);
    expect((await request('/v1/quote?symbol=SPY', fetch)).status).toBe(429);
    expect((await request('/v1/quote?symbol=SPY', fetch, { client: '198.51.100.9' })).status).toBe(200);
    expect((await request('/v1/quote?symbol=SPY', fetch, { now: new Date(NOW.getTime() + RATE_LIMIT.windowMs) })).status).toBe(200);
  });

  test('only read-only market-data and contract-listing endpoints are reachable upstream', () => {
    expect(isAllowedUpstream(DATA_BASE, '/v2/stocks/SPY/snapshot')).toBe(true);
    expect(isAllowedUpstream(DATA_BASE, '/v2/stocks/BRK.B/snapshot')).toBe(true);
    expect(isAllowedUpstream(DATA_BASE, '/v1beta1/options/snapshots/SPY')).toBe(true);
    expect(isAllowedUpstream(TRADING_BASE, '/v2/options/contracts')).toBe(true);
    for (const [base, p] of [
      [TRADING_BASE, '/v2/orders'], [TRADING_BASE, '/v2/positions'], [TRADING_BASE, '/v2/account'],
      [TRADING_BASE, '/v2/assets'], ['https://api.alpaca.markets', '/v2/options/contracts'],
      [DATA_BASE, '/v2/stocks/SPY/snapshot/../../orders'], [TRADING_BASE, '/v2/options/contracts/exercise'],
    ]) expect(isAllowedUpstream(base, p), `${base}${p}`).toBe(false);
    const source = readFileSync(path.join(__dirname, '..', 'lib', 'market', 'alpaca.ts'), 'utf8');
    expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    expect(source).not.toMatch(/\/v2\/(orders|positions|account)/);
  });
});
