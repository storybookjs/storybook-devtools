import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/vite.ts',
      'src/devframe-export.ts',
      'src/rsbuild.ts',
      'src/next.ts',
      'src/frameworks/react/plugin.ts',
      'src/frameworks/vue/plugin.ts',
      'src/frameworks/nuxt/plugin.ts',
      'src/frameworks/react/runtime-module.ts',
      'src/frameworks/vue/runtime-module.ts',
      'src/runtime-helpers.ts',
      'src/client/listeners.ts',
      'src/client/overlay.ts',
      'src/client/vite-devtools.ts',
    ],
    format: ['esm'],
    dts: true,
    external: [
      'vite',
      'unplugin',
      'unplugin-utils',
      'webpack-virtual-modules',
      '@vitejs/devtools-kit',
      '@vitejs/devtools-kit/node',
      '@vitejs/devtools-kit/client',
      '@vitejs/devtools-kit/constants',
      '@devframes/hub',
      '@devframes/hub/initiate',
      '@devframes/hub/constants',
      '@devframes/hub-ui',
      '@devframes/next',
      '@devframes/next/hub',
      'devframe',
      'devframe/client',
      /^storybook(\/.*)?$/,
      '@vue/compiler-sfc',
      'vue',
      'react',
      'virtual:component-highlighter/runtime-helpers',
    ],
  },
  {
    // Self-contained ESM bundle of the dock client script for hosts with no
    // `/@id/{specifier}` module-graph URL to resolve a bare import from —
    // served directly by URL instead.
    entry: ['src/client/vite-devtools.ts'],
    format: ['esm'],
    platform: 'browser',
    dts: false,
    outDir: 'dist/client-bundled',
    fixedExtension: true,
    noExternal: [/.*/],
  },
])
