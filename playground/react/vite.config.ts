/// <reference types="vite/client" />

import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DevTools } from '@vitejs/devtools'

import componentHighlighter from '../../src/frameworks/react/plugin'

const r = (filepath: string) =>
  fileURLToPath(new URL(filepath, import.meta.url))

export default defineConfig({
  devtools: {
    enabled: true,
    clientAuth: false,
  },
  plugins: [
    react(),
    process.env.STORYBOOK ? null : DevTools(),
    process.env.STORYBOOK
      ? null
      : componentHighlighter({
          agent: { token: process.env['STORYBOOK_DEVTOOLS_MCP_TOKEN'] ?? 'playground-only' },
          storybookUrl: `http://localhost:${process.env['E2E_STORYBOOK_PORT'] ?? 6006}`,
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
