import { defineConfig, devices } from '@playwright/test'

// Keep validation isolated from other local projects when default ports are occupied.
const offset = Number(process.env['E2E_PORT_OFFSET'] ?? 0)
const url = (port: number) => `http://127.0.0.1:${port + offset}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
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
        baseURL: url(5173),
      },
    },
    {
      name: 'react18-chromium',
      testMatch: /playground-react18-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: url(5175),
      },
    },
    {
      name: 'rsbuild-chromium',
      testMatch: /playground-rsbuild-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: url(5177),
      },
    },
    {
      name: 'vue-chromium',
      testMatch: /playground-vue-detection\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: url(5174),
      },
    },
    {
      name: 'nuxt-chromium',
      testMatch: /playground-nuxt-detection\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: url(5176),
      },
    },
    {
      name: 'next-chromium',
      testMatch: /playground-next-detection\.spec\.ts/,
      fullyParallel: false,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: url(5178),
      },
    },
  ],

  webServer: [
    {
      command: `pnpm --dir playground/react dev --host 127.0.0.1 --port ${5173 + offset}`,
      url: url(5173),
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command:
        `pnpm --dir playground/react18 dev --host 127.0.0.1 --port ${5175 + offset}`,
      url: url(5175),
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/rsbuild dev --port ${5177 + offset}`,
      url: url(5177),
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/vue dev --host 127.0.0.1 --port ${5174 + offset}`,
      url: url(5174),
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/nuxt dev --host 127.0.0.1 --port ${5176 + offset}`,
      url: url(5176),
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `pnpm --dir playground/next dev -p ${5178 + offset} -H 127.0.0.1`,
      url: url(5178),
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
})
