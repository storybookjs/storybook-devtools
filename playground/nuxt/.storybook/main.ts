import vue from '@vitejs/plugin-vue'
import { mergeConfig } from 'vite'
import type { StorybookConfig } from '@storybook/vue3-vite'

const config: StorybookConfig = {
  stories: ['../components/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@storybook/addon-vitest',
    '@storybook/addon-a11y',
    '@storybook/addon-docs',
  ],
  framework: '@storybook/vue3-vite',
  // Nuxt configures Vue for its app server; standalone Storybook needs it too.
  viteFinal: config => mergeConfig(config, { plugins: [vue()] }),
}

export default config
