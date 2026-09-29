
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import componentHighlighter from '../../src/frameworks/vue/plugin'

const r = (filepath: string) =>
  fileURLToPath(new URL(filepath, import.meta.url))

export default defineConfig({
  devtools: {
    // Storybook's own Vite builder loads this same config with
    // `STORYBOOK=true` set; mounting Vite's native DevTools hub there too
    // would put a second, unrelated devframe hub on a `977x` sidecar port.
    enabled: !process.env.STORYBOOK,
    clientAuth: false,
  },
  // `devtools.enabled` above is enough when not under Storybook — Vite
  // mounts `@vitejs/devtools` itself for the dev server; a manual
  // `DevTools()` plugin here would register it twice (DTK0034).
  plugins: [
    vue(),
    process.env.STORYBOOK
      ? null
      : componentHighlighter({
          agent: { token: process.env['STORYBOOK_DEVTOOLS_MCP_TOKEN'] ?? 'playground-only' },
          storybookUrl: process.env.STORYBOOK_E2E_URL || 'http://localhost:6006',
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
