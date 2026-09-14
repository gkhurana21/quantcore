// Read-only Alpaca market data for the terminal — a TypeScript port of proxy/ (Go) that runs
// as a Netlify Function beside the static site (netlify/functions/market.ts), so the hosted
// terminal can load live quotes, expirations and option chains for any US ticker.
//
// Every upstream call goes through alpacaGet(), which only permits GET requests to the stock
// snapshot, option snapshot and option-contract listing endpoints; nothing here can reach an
// order, position or account endpoint. Credentials come from the function's environment
// (ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY) and never reach the browser. Without them the
// health check answers "not configured" and the terminal stays on labelled snapshot prices.

import type { LiveChain, LiveChainOption, LiveQuote } from './marketData';

export const DATA_BASE = 'https://data.alpaca.markets';
export const TRADING_BASE = 'https://paper-api.alpaca.markets';
const MAX_PAGES = 10;
const UPSTREAM_TIMEOUT_MS = 8000;

/** Cache lifetimes in seconds — the same as proxy/main.go. */
export const TTL = { quote: 60, expirations: 15 * 60, chain: 15 * 60 } as const;
/** Best-effort per-client limit (per function instance), on top of CDN caching. */
export const RATE_LIMIT = { requests: 120, windowMs: 60_000 } as const;

const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ALLOWED_UPSTREAM: { base: string; path: RegExp }[] = [
  { base: DATA_BASE, path: /^\/v2\/stocks\/[A-Z0-9.%-]+\/snapshot$/ },
  { base: DATA_BASE, path: /^\/v1beta1\/options\/snapshots\/[A-Z0-9.%-]+$/ },
  { base: TRADING_BASE, path: /^\/v2\/options\/contracts$/ },
];

/** The only upstream requests this module can make: read-only market data and contract listings. */
export const isAllowedUpstream = (base: string, path: string): boolean =>
  ALLOWED_UPSTREAM.some(a => a.base === base && a.path.test(path));

export interface Credentials { keyId: string; secret: string; }
export type Fetch = typeof fetch;

export class UpstreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const pick = (o: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((v, k) => (v != null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);
/** Alpaca's trading API sometimes returns numbers as strings. */
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

async function alpacaGet(creds: Credentials, doFetch: Fetch, base: string, path: string,
                         params: Record<string, string>): Promise<unknown> {
  if (!isAllowedUpstream(base, path)) throw new Error(`upstream request not allowed: ${base}${path}`);
  let res: Response;
  try {
    res = await doFetch(`${base}${path}?${new URLSearchParams(params)}`, {
      method: 'GET',
      headers: { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secret, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(502, `alpaca unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new UpstreamError(404, 'not found upstream');
  if (res.status !== 200) throw new UpstreamError(502, `alpaca returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(502, 'unexpected upstream payload');
  }
}

export async function getQuote(creds: Credentials, symbol: string, doFetch: Fetch = fetch,
                               now: () => Date = () => new Date()): Promise<LiveQuote> {
  let snap: unknown;
  try {
    snap = await alpacaGet(creds, doFetch, DATA_BASE, `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, {});
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) throw new UpstreamError(404, `symbol not found: ${symbol}`);
    throw err;
  }
  const trade = num(pick(snap, 'latestTrade', 'p')), prevClose = num(pick(snap, 'prevDailyBar', 'c'));
  if (trade === 0 && prevClose === 0) throw new UpstreamError(404, `no data for symbol: ${symbol}`);
  const last = trade || prevClose;
  return {
    symbol, last,
    bid: num(pick(snap, 'latestQuote', 'bp')), ask: num(pick(snap, 'latestQuote', 'ap')),
    prevClose, change: last - prevClose, feed: 'iex',
    asOf: now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

interface ContractFilter { expiration?: string; expGTE?: string; expLTE?: string; strikeGTE?: number; strikeLTE?: number; }
interface Contract { symbol: string; expiration: string; strike: number; type: string; openInterest: number; }

async function contracts(creds: Credentials, doFetch: Fetch, symbol: string, f: ContractFilter): Promise<Contract[]> {
  const out: Contract[] = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { underlying_symbols: symbol, status: 'active', limit: '10000' };
    if (f.expiration) params.expiration_date = f.expiration;
    else {
      // Alpaca otherwise stops at the coming weekend, so the date range is always explicit.
      if (f.expGTE) params.expiration_date_gte = f.expGTE;
      if (f.expLTE) params.expiration_date_lte = f.expLTE;
    }
    if (f.strikeGTE && f.strikeGTE > 0) params.strike_price_gte = String(f.strikeGTE);
    if (f.strikeLTE && f.strikeLTE > 0) params.strike_price_lte = String(f.strikeLTE);
    if (pageToken) params.page_token = pageToken;
    const wire = await alpacaGet(creds, doFetch, TRADING_BASE, '/v2/options/contracts', params);
    const rows = pick(wire, 'option_contracts');
    if (rows != null && !Array.isArray(rows)) throw new UpstreamError(502, 'unexpected contracts payload');
    for (const r of (rows ?? []) as unknown[]) {
      out.push({
        symbol: String(pick(r, 'symbol') ?? ''), expiration: String(pick(r, 'expiration_date') ?? ''),
        strike: num(pick(r, 'strike_price')), type: String(pick(r, 'type') ?? ''),
        openInterest: Math.trunc(num(pick(r, 'open_interest'))),
      });
    }
    const next = pick(wire, 'next_page_token');
    if (typeof next !== 'string' || !next) break;
    pageToken = next;
  }
  return out;
}

export async function getExpirations(creds: Credentials, symbol: string, doFetch: Fetch = fetch,
                                     now: () => Date = () => new Date()): Promise<{ symbol: string; expirations: string[] }> {
  // Listing every contract is O(100k) rows for SPY, so keep strikes within ±5% of spot —
  // that still surfaces every expiry — and retry without the band if it finds nothing.
  const today = now(), later = new Date(today);
  later.setUTCFullYear(later.getUTCFullYear() + 2);
  const f: ContractFilter = { expGTE: isoDate(today), expLTE: isoDate(later) };
  try {
    const q = await getQuote(creds, symbol, doFetch, now);
    if (q.last > 0) { f.strikeGTE = q.last * 0.95; f.strikeLTE = q.last * 1.05; }
  } catch { /* no quote: search without a strike band */ }
  let rows = await contracts(creds, doFetch, symbol, f);
  if (!rows.length && (f.strikeGTE || f.strikeLTE)) rows = await contracts(creds, doFetch, symbol, { expGTE: f.expGTE, expLTE: f.expLTE });
  if (!rows.length) throw new UpstreamError(404, `no options for: ${symbol}`);
  return { symbol, expirations: Array.from(new Set(rows.map(c => c.expiration))).sort() };
}

export async function getChain(creds: Credentials, symbol: string, expiration: string,
                               doFetch: Fetch = fetch): Promise<LiveChain> {
  const rows = await contracts(creds, doFetch, symbol, { expiration });
  if (!rows.length) throw new UpstreamError(404, `no chain for ${symbol} ${expiration}`);

  // Quotes, IV and Greeks come from option snapshots; contracts give strike, type and open interest.
  const snaps = new Map<string, unknown>();
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = { feed: 'indicative', limit: '1000', expiration_date: expiration };
    if (pageToken) params.page_token = pageToken;
    const wire = await alpacaGet(creds, doFetch, DATA_BASE, `/v1beta1/options/snapshots/${encodeURIComponent(symbol)}`, params);
    const s = pick(wire, 'snapshots');
    if (s != null && (typeof s !== 'object' || Array.isArray(s))) throw new UpstreamError(502, 'unexpected option snapshots payload');
    for (const [k, v] of Object.entries((s ?? {}) as Record<string, unknown>)) snaps.set(k, v);
    const next = pick(wire, 'next_page_token');
    if (typeof next !== 'string' || !next) break;
    pageToken = next;
  }

  const options = rows.map(c => {
    const o: LiveChainOption = { symbol: c.symbol, type: c.type as LiveChainOption['type'], strike: c.strike,
                                 bid: 0, ask: 0, last: 0, openInterest: c.openInterest };
    const s = snaps.get(c.symbol);
    if (s) {
      o.bid = num(pick(s, 'latestQuote', 'bp'));
      o.ask = num(pick(s, 'latestQuote', 'ap'));
      o.last = num(pick(s, 'latestTrade', 'p'));
      const iv = optNum(pick(s, 'impliedVolatility'));
      if (iv !== undefined) o.iv = iv;
      for (const k of ['delta', 'gamma', 'theta', 'vega'] as const) {
        const g = optNum(pick(s, 'greeks', k));
        if (g !== undefined) o[k] = g;
      }
    }
    return o;
  });
  options.sort((a, b) => a.strike - b.strike || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return { symbol, expiration, feed: 'indicative', options };
}

// ── HTTP handler (framework-neutral, so the tests call it directly) ─────────

export interface MarketEnv { ALPACA_API_KEY_ID?: string; ALPACA_API_SECRET_KEY?: string; }
export interface MarketResponse { status: number; body: string; contentType: string; cacheSeconds: number; }

const cache = new Map<string, { body: string; expires: number }>();
const clients = new Map<string, { count: number; windowStart: number }>();

/** Clear the per-instance cache and rate-limit windows (tests). */
export function resetMarketState(): void { cache.clear(); clients.clear(); }

const json = (status: number, data: unknown, cacheSeconds = 0): MarketResponse =>
  ({ status, body: JSON.stringify(data), contentType: 'application/json', cacheSeconds });

export async function handleMarket(url: URL, env: MarketEnv, client: string,
                                   deps: { fetch?: Fetch; now?: () => Date } = {}): Promise<MarketResponse> {
  const doFetch = deps.fetch ?? fetch, now = deps.now ?? (() => new Date());
  const route = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '');
  const creds: Credentials | null = env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY
    ? { keyId: env.ALPACA_API_KEY_ID, secret: env.ALPACA_API_SECRET_KEY } : null;

  if (route === '/healthz') {
    return { status: 200, body: creds ? 'ok' : 'not configured', contentType: 'text/plain', cacheSeconds: 0 };
  }
  if (route !== '/v1/quote' && route !== '/v1/expirations' && route !== '/v1/chain') return json(404, { error: 'not found' });

  const t = now().getTime();
  const c = clients.get(client);
  if (!c || t - c.windowStart >= RATE_LIMIT.windowMs) {
    if (clients.size > 10_000) clients.clear();
    clients.set(client, { count: 1, windowStart: t });
  } else if (++c.count > RATE_LIMIT.requests) {
    return json(429, { error: 'too many requests' });
  }

  const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) return json(400, { error: 'invalid or missing symbol' });
  const expiration = url.searchParams.get('expiration') ?? '';
  if (route === '/v1/chain' && !DATE_RE.test(expiration)) return json(400, { error: 'expiration must be YYYY-MM-DD' });
  if (!creds) return json(503, { error: 'market data not configured' });

  const [key, ttl, load] = route === '/v1/quote'
    ? [`quote:${symbol}`, TTL.quote, () => getQuote(creds, symbol, doFetch, now)] as const
    : route === '/v1/expirations'
      ? [`exp:${symbol}`, TTL.expirations, () => getExpirations(creds, symbol, doFetch, now)] as const
      : [`chain:${symbol}:${expiration}`, TTL.chain, () => getChain(creds, symbol, expiration, doFetch)] as const;

  const hit = cache.get(key);
  if (hit && hit.expires > t) {
    return { status: 200, body: hit.body, contentType: 'application/json', cacheSeconds: Math.ceil((hit.expires - t) / 1000) };
  }
  try {
    const body = JSON.stringify(await load());
    if (cache.size > 2000) for (const [k, v] of cache) if (v.expires <= t) cache.delete(k);
    cache.set(key, { body, expires: t + ttl * 1000 });
    return { status: 200, body, contentType: 'application/json', cacheSeconds: ttl };
  } catch (err) {
    return err instanceof UpstreamError ? json(err.status, { error: err.message }) : json(500, { error: 'internal error' });
  }
}
