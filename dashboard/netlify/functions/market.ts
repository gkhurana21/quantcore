// Netlify Function: read-only market data at /api/* on the same origin as the static terminal.
// The logic lives in lib/market/alpaca.ts; build the site with NEXT_PUBLIC_PROXY_URL=/api to use it.
// Credentials are read from the site's environment and never sent to the browser.

import { handleMarket } from '../../lib/market/alpaca';

export default async function market(req: Request, context?: { ip?: string }): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method not allowed' }),
                        { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'GET', 'Cache-Control': 'no-store' } });
  }
  const client = context?.ip ?? req.headers.get('x-nf-client-connection-ip') ?? 'unknown';
  const res = await handleMarket(new URL(req.url), {
    ALPACA_API_KEY_ID: process.env.ALPACA_API_KEY_ID,
    ALPACA_API_SECRET_KEY: process.env.ALPACA_API_SECRET_KEY,
  }, client);

  const headers: Record<string, string> = { 'Content-Type': res.contentType, 'X-Content-Type-Options': 'nosniff' };
  if (res.status === 200 && res.cacheSeconds > 0) {
    // every visitor asking for the same symbol within the TTL is served from Netlify's CDN
    headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
    headers['Netlify-CDN-Cache-Control'] = `public, s-maxage=${res.cacheSeconds}, stale-while-revalidate=30`;
    headers['Netlify-Vary'] = 'query';
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(res.body, { status: res.status, headers });
}

export const config = { path: '/api/*' };
