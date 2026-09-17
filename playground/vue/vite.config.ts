
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { DevTools } from '@vitejs/devtools'

import componentHighlighter from '../../src/frameworks/vue/plugin'

const r = (filepath: string) =>
  fileURLToPath(new URL(filepath, import.meta.url))

export default defineConfig({
  devtools: {
    enabled: true,
    clientAuth: false,
  },
  plugins: [
    vue(),
    process.env.STORYBOOK ? null : DevTools(),
    process.env.STORYBOOK
      ? null
      : componentHighlighter({
          agent: { token: process.env['STORYBOOK_DEVTOOLS_MCP_TOKEN'] ?? 'playground-only' },
          storybookUrl: `http://localhost:${process.env['E2E_STORYBOOK_PORT'] ?? 6006}`,
          debugMode: false,
        }),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@storybook/experimental-devtools/client/listeners': r(
        '../../src/client/listeners.ts',
      ),
      '@storybook/experimental-devtools/client/overlay': r(
        '../../src/client/overlay.ts',
      ),
      '@storybook/experimental-devtools/client/vite-devtools': r(
        '../../src/client/vite-devtools.ts',
      ),
    },
  },
})
