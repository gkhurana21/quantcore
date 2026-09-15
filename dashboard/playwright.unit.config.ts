import { defineConfig } from '@playwright/test';

// Unit tests for the pricing, strategy, risk and import libraries. They run in
// the Playwright test runner (Node) and need no browser or dev server.
export default defineConfig({
  testDir: './tests',
  testMatch: /(quant|properties|marketData|wasm|volSurface|alpaca|alpaca\.live|calibrate|impliedDensity|surface\.live|localVol|exotics)\.spec\.ts$/,
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
});
