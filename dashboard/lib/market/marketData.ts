// Client for the QuantCore data proxy (proxy/ — Go service fronting Alpaca).
// All data is indicative / IEX — for education and analysis, never execution.
//
// The proxy is only contacted when it can actually be reached: an explicit
// NEXT_PUBLIC_PROXY_URL, or a page served from localhost (where the dev proxy
// runs). A hosted https build without a configured proxy makes no requests,
// so it never probes a visitor's localhost or triggers mixed-content errors.

export interface LiveQuote {
  symbol: string; last: number; bid: number; ask: number;
  prevClose: number; change: number; feed: string; asOf: string;
}

export interface LiveChainOption {
  symbol: string; type: 'call' | 'put'; strike: number;
  bid: number; ask: number; last: number; openInterest: number;
  iv?: number; delta?: number; gamma?: number; theta?: number; vega?: number;
}

export interface LiveChain { symbol: string; expiration: string; feed: string; options: LiveChainOption[]; }

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/;

export function proxyUrl(): string | null {
  const env = process.env.NEXT_PUBLIC_PROXY_URL;
  if (env === 'disabled' || env === 'off') return null;
  if (env) return env.replace(/\/$/, '');
  if (typeof window !== 'undefined' && LOCAL_HOST.test(window.location.hostname)) return 'http://localhost:8080';
  return null;
}

async function get<T>(path: string, timeoutMs = 6000): Promise<T> {
  const base = proxyUrl();
  if (!base) throw new Error('proxy not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** One cheap health probe gates every other request. */
export async function probeProxy(): Promise<boolean> {
  if (!proxyUrl()) return false;
  try {
    await get<unknown>('/healthz', 1500);
    return true;
  } catch {
    return false;
  }
}

export const fetchQuote = (symbol: string) =>
  get<LiveQuote>(`/v1/quote?symbol=${encodeURIComponent(symbol)}`);

export const fetchExpirations = (symbol: string) =>
  get<{ symbol: string; expirations: string[] }>(`/v1/expirations?symbol=${encodeURIComponent(symbol)}`);

export const fetchChain = (symbol: string, expiration: string) =>
  get<LiveChain>(`/v1/chain?symbol=${encodeURIComponent(symbol)}&expiration=${encodeURIComponent(expiration)}`);
