import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// The native engine (C++ over WebSocket) exists only on a machine that has built it. The default run therefore
// does not start it, and the specs that need it skip with a printed reason (tests/support/engine.ts). Run
// `npm run test:e2e:engine` (QC_ENGINE=1) to start the engine server and require it: in that mode an
// unreachable engine fails the run.
const ENGINE = process.env.QC_ENGINE === '1';
const PYTHON = process.env.PYTHON ?? 'python3';
const SERVER = path.join(__dirname, '../server/ws_server.py');
const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://localhost:${PORT}`;
// QC_STATIC=1 serves the exported site (out/, from `npm run build`) instead of `next dev`: faster to start and
// the build users get. It is what CI uses.
const STATIC = process.env.QC_STATIC === '1';

export default defineConfig({
  testDir: './tests',
  // the browser specs; the pricing, risk and import libraries run in the unit config (playwright.unit.config.ts)
  testMatch: /(a11y|dashboard|engine|robustness|smile|terminal|hotkeys|intro)\.spec\.ts$/,
  globalSetup: './tests/support/global-setup.ts',
  timeout: 30_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE,
    headless: true,
    screenshot: 'only-on-failure',
    // every spec but intro.spec.ts starts with the first-visit intro band already dismissed
    storageState: { cookies: [], origins: [{ origin: BASE, localStorage: [{ name: 'qc-intro-dismissed', value: '1' }] }] },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: [
    ...(ENGINE ? [{
      command: `${PYTHON} ${SERVER} 8765`,
      port: 8765,
      reuseExistingServer: true,
      timeout: 15_000,
    }] : []),
    STATIC
      ? { command: `node scripts/serve-out.mjs ${PORT}`, cwd: __dirname, port: PORT, reuseExistingServer: true, timeout: 20_000 }
      : {
          command: `npm run dev -- --port ${PORT}`,
          cwd: __dirname,
          port: PORT,
          reuseExistingServer: true,
          timeout: 90_000,
          // deterministic tests: never call the optional live market-data proxy
          env: { NEXT_PUBLIC_PROXY_URL: 'disabled' },
        },
  ],
});
