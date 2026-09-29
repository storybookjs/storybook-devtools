import type { StorybookConfig } from 'storybook-react-rsbuild'

// The Rsbuild Storybook framework (storybook.rsbuild.rs). Stories live in
// the shared (symlinked) src tree. @storybook/react is a direct
// devDependency: the rspack builder resolves the renderer's preview
// annotations from the project root, and pnpm's strict layout doesn't
// expose the framework's transitive copy — without it the preview boots
// without renderToCanvas and every story errors.
const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-mcp'],
  framework: {
    name: 'storybook-react-rsbuild',
    options: {
      builder: {
        // Storybook-only config — the app's mounts the devtools plugin,
        // which must not run inside Storybook's dev server.
        rsbuildConfigPath: '.storybook/rsbuild.config.ts',
      },
    },
  },
}
export default config
