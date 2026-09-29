import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineNuxtConfig } from 'nuxt/config'

import componentHighlighter, {
  getNuxtDevToolsHookScript,
  getNuxtViteDevToolsInjectionScript,
  viteDevToolsBridgeModule,
} from '../../src/frameworks/nuxt/plugin'

const r = (filepath: string) =>
  fileURLToPath(new URL(filepath, import.meta.url))

const isStorybook = process.env.STORYBOOK === 'true'

if (!isStorybook) {
  process.env.VITE_DEVTOOLS_DISABLE_CLIENT_AUTH ??= 'true'
}

export default defineNuxtConfig({
  ssr: true,
  modules: isStorybook ? [] : [viteDevToolsBridgeModule],
  css: ['~/assets/style.css'],
  app: {
    head: {
      script: isStorybook
        ? []
        : [
            {
              innerHTML: getNuxtDevToolsHookScript(),
              tagPosition: 'head',
            },
            {
              type: 'module',
              innerHTML: getNuxtViteDevToolsInjectionScript(),
              tagPosition: 'bodyClose',
            },
          ],
    },
  },
  vite: {
    server: {
      host: '127.0.0.1',
    },
    devtools: {
      enabled: !isStorybook,
      clientAuth: false,
    },
    // Nuxt 4.5 forwards Vite's native devtools option. Adding DevTools()
    // here as well would register the host twice.
    plugins: [
      isStorybook
        ? null
        : componentHighlighter({
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
  },
  nitro: {
    preset: 'node-server',
  },
  typescript: {
    strict: true,
    typeCheck: false,
    tsConfig: {
      compilerOptions: {
        types: ['node'],
      },
    },
  },
  alias: {
    '@playground': path.resolve(fileURLToPath(new URL('.', import.meta.url))),
  },
})
