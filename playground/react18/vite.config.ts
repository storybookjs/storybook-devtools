/// <reference types="vite/client" />

import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import componentHighlighter from '../../src/frameworks/react/plugin'

const r = (filepath: string) =>
  fileURLToPath(new URL(filepath, import.meta.url))

// Minimal React 18 app used to assert cross-version parity of the
// non-intrusive fiber detection + prop serialization. Mirrors playground/react
// (same components/App) but pinned to React 18.
export default defineConfig({
  devtools: {
    // Unconditional is safe here: this playground has no `.storybook`
    // config, so Storybook's Vite builder never loads this file and can
    // never double-mount the DevTools hub the way it can for the other
    // playgrounds.
    enabled: true,
    clientAuth: false,
  },
  // `devtools.enabled` above is enough — Vite mounts `@vitejs/devtools`
  // itself for the dev server; a manual `DevTools()` plugin here would
  // register it twice (DTK0034).
  plugins: [
    react(),
    componentHighlighter({
      debugMode: true,
    }),
  ],
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
