// A static server for the exported site (dashboard/out): what CI, the screenshots and the UI scanners load.
//
//   node scripts/serve-out.mjs [port]          (default 3000; PORT also works)
//
// It serves exactly what the Netlify build publishes. No COOP/COEP headers: nothing in the terminal uses
// SharedArrayBuffer, so none are needed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'out');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

/** Starts the server and resolves to { server, port, url }. Port 0 picks a free one. */
export function serveOut(port = 0) {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    throw new Error(`No exported site at ${ROOT}. Build it first: NEXT_PUBLIC_PROXY_URL=disabled npm run build`);
  }
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address();
      resolve({ server, port: bound, url: `http://localhost:${bound}` });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, url } = await serveOut(Number(process.argv[2] ?? process.env.PORT ?? 3000));
  console.log(`serving ${ROOT} at ${url} (port ${port})`);
}
