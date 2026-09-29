import { defineConfig, devices } from '@playwright/test'

// Isolate QA from developers' already-running playgrounds when requested.
const portOffset = Number(process.env.PLAYWRIGHT_PORT_OFFSET || 0)
const port = (value: number) => value + portOffset

export default defineConfig({
  testDir: './e2e',
  // Each host has server-global RPC/shared state. Keep tests within a host
  // sequential; different playground projects can still run in parallel.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'react-chromium',
      testMatch: /playground-react-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${port(5173)}`,
      },
    },
    {
      name: 'react18-chromium',
      testMatch: /playground-react18-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${port(5175)}`,
      },
    },
    {
      name: 'rsbuild-chromium',
      testMatch: /playground-rsbuild-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${port(5177)}`,
      },
    },
    {
      name: 'vue-chromium',
      testMatch: /playground-vue-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${port(5174)}`,
      },
    },
    {
      name: 'nuxt-chromium',
      testMatch: /playground-nuxt-detection\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${port(5176)}`,
      },
    },
    {
      name: 'next-chromium',
      testMatch: /playground-next-detection\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${port(5178)}`,
      },
    },
  ],

  webServer: [
    {
      command: `pnpm --dir playground/react dev --host 127.0.0.1 --port ${port(5173)}`,
      url: `http://127.0.0.1:${port(5173)}`,
      reuseExistingServer: !process.env.CI && portOffset === 0,
      timeout: 60000,
    },
    {
      command:
        `pnpm --dir playground/react18 dev --host 127.0.0.1 --port ${port(5175)}`,
      url: `http://127.0.0.1:${port(5175)}`,
      reuseExistingServer: !process.env.CI && portOffset === 0,
      timeout: 60000,
    },
    {
      command: 'pnpm --dir playground/rsbuild dev',
      url: `http://127.0.0.1:${port(5177)}`,
      reuseExistingServer: !process.env.CI && portOffset === 0,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/vue dev --host 127.0.0.1 --port ${port(5174)}`,
      url: `http://127.0.0.1:${port(5174)}`,
      reuseExistingServer: !process.env.CI && portOffset === 0,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/nuxt dev --host 127.0.0.1 --port ${port(5176)}`,
      url: `http://127.0.0.1:${port(5176)}`,
      reuseExistingServer: !process.env.CI && portOffset === 0,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/next dev -p ${port(5178)} -H 127.0.0.1`,
      url: `http://127.0.0.1:${port(5178)}`,
      reuseExistingServer: !process.env.CI && portOffset === 0,
      timeout: 120000,
    },
  ],
})
