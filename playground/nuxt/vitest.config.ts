import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'

// Keep Storybook browser tests separate from the application devtools server.
export default defineConfig({
  plugins: [storybookTest({ configDir: fileURLToPath(new URL('.storybook', import.meta.url)) })],
  test: {
    name: 'storybook',
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    setupFiles: [fileURLToPath(new URL('.storybook/vitest.setup.ts', import.meta.url))],
  },
})
