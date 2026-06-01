import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const PYTHON = '/Library/Developer/CommandLineTools/usr/bin/python3';
const SERVER = path.join(__dirname, '../server/ws_server.py');

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // Start both the C++ WebSocket backend and the Next.js dev server
  webServer: [
    {
      command: `${PYTHON} ${SERVER} 8765`,
      port: 8765,
      reuseExistingServer: true,
      timeout: 10_000,
    },
    {
      command: 'npm run dev',
      cwd: __dirname,
      port: 3000,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
