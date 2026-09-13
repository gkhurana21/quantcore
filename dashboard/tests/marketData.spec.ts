/**
 * Market-data proxy client, run in Node with a stubbed fetch. The browser suites
 * build with the proxy disabled for determinism, so this is where the live path
 * is exercised: opt-in gating, the health probe and request/response handling.
 */

import { test, expect } from '@playwright/test';
import { fetchQuote, probeProxy, proxyUrl } from '../lib/market/marketData';

const realFetch = globalThis.fetch;
const realEnv = process.env.NEXT_PUBLIC_PROXY_URL;
let calls: string[] = [];

function stub(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return respond(String(input), init);
  }) as typeof fetch;
}

function setEnv(v: string | undefined) {
  if (v === undefined) delete process.env.NEXT_PUBLIC_PROXY_URL;
  else process.env.NEXT_PUBLIC_PROXY_URL = v;
}

test.describe('market data client', () => {
  test.afterEach(() => {
    globalThis.fetch = realFetch;
    setEnv(realEnv);
  });

  test('without NEXT_PUBLIC_PROXY_URL nothing is requested', async () => {
    for (const v of [undefined, '', 'disabled', 'off']) {
      setEnv(v);
      stub(() => new Response('ok'));
      expect(proxyUrl()).toBeNull();
      expect(await probeProxy()).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test('the health probe accepts the proxy\'s plain-text "ok" and rejects failures', async () => {
    setEnv('http://localhost:8080/');
    stub(() => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
    expect(await probeProxy()).toBe(true);
    expect(calls).toEqual(['http://localhost:8080/healthz']);

    stub(() => new Response('unavailable', { status: 503 }));
    expect(await probeProxy()).toBe(false);

    stub(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await probeProxy()).toBe(false);

    // a proxy that accepts the connection but never answers is abandoned at the timeout
    stub((_url, init) => new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const t0 = Date.now();
    expect(await probeProxy(200)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('quotes are requested with an encoded symbol and parsed', async () => {
    setEnv('http://localhost:8080');
    const quote = { symbol: 'BRK.B', last: 481.2, bid: 481.1, ask: 481.3, prevClose: 479, change: 2.2, feed: 'iex', asOf: '' };
    stub(() => Response.json(quote));
    expect(await fetchQuote('BRK.B')).toEqual(quote);
    expect(calls).toEqual(['http://localhost:8080/v1/quote?symbol=BRK.B']);

    stub(() => new Response('{"error":"unknown symbol"}', { status: 404 }));
    await expect(fetchQuote('ZZZZ')).rejects.toThrow('proxy 404');
  });
});
