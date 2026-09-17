import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import storybookDevtoolsRsbuild from '../../src/rsbuild'

const r = (filepath: string) => fileURLToPath(new URL(filepath, import.meta.url))

export default defineConfig({
  plugins: [
    pluginReact(),
    storybookDevtoolsRsbuild({
      framework: 'react',
      agent: { token: process.env['STORYBOOK_DEVTOOLS_MCP_TOKEN'] ?? 'playground-only' },
      storybookUrl: `http://localhost:${process.env['E2E_STORYBOOK_PORT'] ?? 6006}`,
      debugMode: true,
      clientAuth: false,
    }),
  ],
  source: { entry: { index: './src/index.tsx' } },
  html: { mountId: 'app' },
  server: { host: '127.0.0.1', port: 5177 },
  resolve: {
    alias: {
      '@storybook/experimental-devtools/client/listeners': r(
        './shims/devtools-client.ts',
      ),
      '@storybook/experimental-devtools/client/overlay': r(
        './shims/empty.ts',
      ),
    },
  },
})
