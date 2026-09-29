/// <reference types="vite/client" />

import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import componentHighlighter from '../../src/frameworks/react/plugin'

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
    react(),
    process.env.STORYBOOK
      ? null
      : componentHighlighter({
          storybookUrl: process.env.STORYBOOK_E2E_URL || 'http://localhost:6006',
          debugMode: true,
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
