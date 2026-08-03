// Client for the QuantCore data proxy (proxy/ — Go service fronting Alpaca).
// All data is indicative/IEX — for education and analysis, not execution.
// Every call fails fast (6 s) so the dashboard can fall back to snapshots.

export interface LiveQuote {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  prevClose: number;
  change: number;
  feed: string;
  asOf: string;
}

export interface LiveChainOption {
  symbol: string;
  type: 'call' | 'put';
  strike: number;
  bid: number;
  ask: number;
  last: number;
  openInterest: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export interface LiveChain {
  symbol: string;
  expiration: string;
  feed: string;
  options: LiveChainOption[];
}

const PROXY_URL = process.env.NEXT_PUBLIC_PROXY_URL ?? 'http://localhost:8080';

async function get<T>(path: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${PROXY_URL}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchQuote = (symbol: string) =>
  get<LiveQuote>(`/v1/quote?symbol=${encodeURIComponent(symbol)}`);

export const fetchExpirations = (symbol: string) =>
  get<{ symbol: string; expirations: string[] }>(
    `/v1/expirations?symbol=${encodeURIComponent(symbol)}`);

export const fetchChain = (symbol: string, expiration: string) =>
  get<LiveChain>(
    `/v1/chain?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}`);
