import net from 'net';

const PORT = 8765;

const listening = (host: string): Promise<boolean> => new Promise(resolve => {
  const s = net.connect({ port: PORT, host });
  const done = (ok: boolean) => { s.destroy(); resolve(ok); };
  s.setTimeout(1500, () => done(false));
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
});

const up = async () => (await listening('127.0.0.1')) || (await listening('::1'));

/**
 * Probes the engine port once, before any test. QC_ENGINE=1 requires it (and waits up to 20 s for the server
 * Playwright just started); otherwise engine specs skip when it is absent and say so here.
 */
export default async function globalSetup() {
  const required = process.env.QC_ENGINE === '1';
  let ok = await up();
  for (let i = 0; required && !ok && i < 20; i++) { await new Promise(r => setTimeout(r, 1000)); ok = await up(); }
  process.env.QC_ENGINE_UP = ok ? '1' : '0';
  if (required && !ok) {
    throw new Error('QC_ENGINE=1 but nothing answers at ws://localhost:8765. Build the engine (see README, "Try it") and re-run; ' +
                    'PYTHON=/path/to/python3 selects the interpreter that can import quantcore.');
  }
  console.log(ok
    ? '\n[e2e] native engine answering at ws://localhost:8765: engine specs will run\n'
    : '\n[e2e] no native engine at ws://localhost:8765: engine specs are SKIPPED (they need the C++ module; run `npm run test:e2e:engine`)\n');
}
