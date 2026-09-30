# Storybook DevTools

Dev-server devtools for visual component highlighting and automatic Storybook story generation. It instruments React, Vue, and Nuxt SSR components on top of Vite, Rsbuild, or Next.js. Hover over components in your running app to see their details and create stories with a single click.

## Features

- Give agents live component context, a React component tree, and story gaps through [runtime MCP](./docs/AGENT_MVP.md).
- Highlight components and inspect or edit their live props.
- Create stories from current props, including JSX children and Vue slots.
- Record interactions and generate Storybook play functions.
- Preview stories and docs in the DevTools panel.
- Find components without stories and generate stories in bulk.

## Installation

```bash
npm install @storybook/experimental-devtools
# or
pnpm add @storybook/experimental-devtools
# or
yarn add @storybook/experimental-devtools
```

### Peer Dependencies

- `storybook` 10.6 or newer.
- One bundler host: `vite` >= 5.0.0 with `@vitejs/devtools` >= 0.7.6, `@rsbuild/core` >= 1.1.7, or `next` (App Router, webpack dev)
- One of: `react` >= 18.0.0 or `vue` >= 3.0.0

## Quick Start

### React

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { DevTools } from '@vitejs/devtools'
import componentHighlighter from '@storybook/experimental-devtools/react'

export default defineConfig({
  plugins: [
    react(),
    DevTools(),
    componentHighlighter(),
  ],
})
```

### Vue

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { DevTools } from '@vitejs/devtools'
import componentHighlighter from '@storybook/experimental-devtools/vue'

export default defineConfig({
  plugins: [
    vue(),
    DevTools(),
    componentHighlighter(),
  ],
})
```

> On Vite >= 8.3, setting `devtools: { enabled: true }` in the Vite config
> makes Vite mount `@vitejs/devtools` itself. Use either that option or the
> `DevTools()` plugin, not both — registering both fails with `DTK0034`.
>
> Storybook's own Vite builder loads this same config file when it runs, so
> both the `DevTools()` plugin above and `devtools: { enabled: true }` need
> disabling in that process (e.g. `process.env.STORYBOOK ? null : DevTools()`,
> or `enabled: !process.env.STORYBOOK`) to avoid loading DevTools inside Storybook.

### Nuxt SSR

For Nuxt 4.5:

```typescript
// nuxt.config.ts
import { defineNuxtConfig } from 'nuxt/config'
import componentHighlighter, {
  getNuxtDevToolsHookScript,
  getNuxtViteDevToolsInjectionScript,
  viteDevToolsBridgeModule,
} from '@storybook/experimental-devtools/nuxt'

export default defineNuxtConfig({
  ssr: true,
  modules: [viteDevToolsBridgeModule],
  app: {
    head: {
      script: [
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
      enabled: true,
      clientAuth: false,
    },
    plugins: [componentHighlighter()],
  },
})
```

Nuxt SSR uses the Vue component runtime. Register `viteDevToolsBridgeModule` so
the DevTools dock and its assets are reachable through Nuxt's dev server, and
add both head scripts so the highlighter is wired up before and after
hydration. Pin `vite.server.host` if the page and the DevTools websocket need
to agree on a host (for example `127.0.0.1`). When running Storybook for Nuxt
components, disable `vite.devtools.enabled` and omit the module, the component
highlighter plugin, and the head scripts from the Storybook process.

Older Nuxt builders may require `DevTools()` instead of `vite.devtools.enabled`.
Do not use both options together.

### Vite (unified entry)

Alternatively, import `storybookDevtools` from
`@storybook/experimental-devtools/vite` and use
`storybookDevtools({ framework: 'react' })` or
`storybookDevtools({ framework: 'vue' })` in your Vite plugins.

### Rsbuild (rspack)

`./rsbuild` mounts the same instrumentation and dock on an Rsbuild project.
No `@vitejs/devtools` plugin is needed here.

```typescript
// rsbuild.config.ts
import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { storybookDevtoolsRsbuild } from '@storybook/experimental-devtools/rsbuild'

export default defineConfig({
  plugins: [
    pluginReact(),
    storybookDevtoolsRsbuild({ framework: 'react' }),
  ],
})
```

Options:

- **`clientAuth`** *(default `true`)* — set `clientAuth: false` to skip the interactive auth gate for single-user localhost or E2E setups.
- **`framework: 'vue'`** is accepted but not yet verified on Rsbuild.
- **`dedupeReact`** works the same as on Vite — see [Configuration](#configuration).

### Next.js (webpack)

`./next` mounts the same instrumentation on Next's App Router dev server
(`next dev`, webpack). Turbopack is unsupported — see below.

```typescript
// next.config.ts
import type { NextConfig } from 'next'
import { withStorybookDevtools } from '@storybook/experimental-devtools/next'

const nextConfig: NextConfig = {
  // Next's App Router treats a leading-underscore path segment as private
  // and unroutable, so the routes below are rewritten from public paths.
  async rewrites() {
    return [
      { source: '/__devframes/:path*', destination: '/internal-devframes-hub/:path*' },
      {
        source: '/__storybook-devtools-client/:path*',
        destination: '/internal-devframes-client/:path*',
      },
    ]
  },
}

export default withStorybookDevtools()(nextConfig)
```

```typescript
// app/internal-devframes-hub/[[...path]]/route.ts
import { createStorybookDevtoolsRoute } from '@storybook/experimental-devtools/next'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST, DELETE } = createStorybookDevtoolsRoute()
```

```typescript
// app/internal-devframes-client/[[...path]]/route.ts
import { createStorybookDevtoolsClientBundleRoute } from '@storybook/experimental-devtools/next'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET } = createStorybookDevtoolsClientBundleRoute()
```

Options and caveats:

- **`auth`** *(default `true`)* — `createStorybookDevtoolsRoute({ auth: false })` disables the interactive auth gate for single-user localhost or E2E setups.
- **`host`** — pin the sidecar server's bind address (e.g. `host: '127.0.0.1'`) to match `next dev -H 127.0.0.1`; the default (`'localhost'`) can resolve to an address the browser's websocket can't reach.
- **Turbopack is unsupported.** Running `next dev` under Turbopack prints a warning and the app runs normally, without instrumentation. Run `next dev` without `--turbopack` on Next 15, or pass `--webpack` explicitly on majors where Turbopack is the default (Next 16+).
- **`rsc`** *(default `true`)* — only modules with their own `"use client"` directive are instrumented, including when imported by another client component. Server components are not highlighted.
- **Story generation** imports from the framework package read out of your `.storybook/main` config (e.g. `@storybook/nextjs-vite`); falls back to `@storybook/nextjs` when no Storybook config is found.
- **Manual hook fallback** — if entry injection isn't viable in your setup, `getNextDevToolsHookScript()` returns the same hook script for manual delivery, e.g. via `<Script strategy="beforeInteractive">` in the root layout.

### Open the highlighter

Start your app with `npm run dev`, open the DevTools dock, and activate
**Component Highlighter**. Complete the authorization prompt if shown.

## Usage

### Highlight Modes

| Mode | Trigger | Description |
|------|---------|-------------|
| **Hover** | Mouse over | Highlights the component under the cursor |
| **Click-through** | Press `Alt/Option` | Toggles click-through mode so you can interact with the app underneath highlights |
| **Clear Selection** | `Escape` | Clears the current component selection |
| **Exit Highlighting** | `Escape` x2 (within 600ms) | Turns off highlight mode entirely |

### Highlight Colors

- **Blue solid border** - hovered component without stories
- **Pink solid border** - hovered component with stories
- **Dashed border** - other instances of the same component type
- **Tinted background** - selected component

### Context Menu and Story Creation

Click a highlighted component to open its context menu:

- **Open Code** / **Open Story** - open the source or story file in your editor (Open Story is omitted if no story exists yet)
- **Copy Prompt** - copies an LLM-friendly prompt with component name, path, props, and story status
- **View Story** - navigates to the story in the embedded Storybook panel
- **Properties** - all current props with type-colored badges, expandable objects, and copy buttons

To create a story: enter a name (auto-suggested from meaningful props like
variant, size, type), then click **Create** for a story with the current
props, or **Create with Interactions** to record clicks, typing, and selections
first and generate a story with a play function.

Use the inspector's **Stories** tab for previews and **Docs** for available
component documentation.

Stories are saved alongside the component as `<ComponentName>.stories.ts`
for Vue or `<ComponentName>.stories.tsx` for React. New files use CSF3, or
[CSF factories](https://storybook.js.org/docs/api/csf/csf-next) when your
`.storybook/preview` uses `definePreview`. Existing files receive a new story
in their current format. Your project's Prettier formats the file when
installed, which may also reformat existing stories.

### Find missing stories

The **Coverage** tab groups rendered components under **Needs stories** and
**Has stories**. Search by name or path, inspect a component, or open its
stories. **Highlight missing** highlights uncovered components;
**Generate all** creates a story for each unique set of component props.

Coverage uses your Storybook index, including custom titles and stories outside
the component's directory. If the index is unavailable, it looks for
`<ComponentName>.stories.*` files.

## Configuration

Pass options to `componentHighlighter()` (or your host's integration):

| Option | Default | Purpose |
|--------|---------|---------|
| `include` | React: `**/*.{tsx,jsx}`; Vue/Nuxt: `**/*.vue` | File patterns to instrument |
| `exclude` | Dependencies, build output, declarations, and story files | File patterns to skip |
| `storiesDir` | Alongside the component | Subdirectory for generated stories |
| `debugMode` | `false` | Enable debug logging |
| `force` | `false` | Enable instrumentation in production builds |
| `dedupeReact` | `'auto'` | Prevent conflicting React versions; `true` always deduplicates, `false` disables it |
| `rsc` | `false` (`true` on Next.js) | Instrument only modules with their own `"use client"` directive |
| `hookInjection` | `'html'` on Vite | Use `'entry'` for setups without an HTML transform |
| `entry` | Unset | Entry-module patterns; required with `hookInjection: 'entry'` |

React 18 and 19 are supported. See [React patterns](./docs/REACT_PATTERNS.md)
for supported component patterns and detection limitations.

## Keyboard Shortcuts Reference

| Shortcut | Action |
|----------|--------|
| `Mod+Shift+H` | Toggle component highlighter (via command palette) |
| `Alt/Option` (press) | Toggle click-through mode (interact with app underneath highlights) |
| `Escape` | Clear selection / close context menu |
| `Escape` x2 (within 600ms) | Exit highlight mode entirely |
| `Enter` (in story name input) | Create story |

## Limitations

- **Framework scope** - Currently supports React, Vue, and Nuxt SSR through the Vue integration
- **Bundler hosts** - Vite, Rsbuild, and Next.js (webpack) are supported. Vue support on Rsbuild is not yet verified. Next.js only instruments modules with their own `"use client"` directive.
- **Development only** - Disabled in production builds by default
- **DevTools required** - Vite hosts need `@vitejs/devtools` for the dock panel and RPC; Rsbuild and Next.js hosts get the dock through a bundled devframe hub instead
- **Provider dependencies** - Components requiring context providers may need Storybook decorators

## Troubleshooting

### Stories aren't being created

1. Ensure the DevTools dock is open and the Component Highlighter entry is active
2. Check the browser console for errors
3. Verify the output path is writable

### Components not being highlighted

1. Activate **Component Highlighter** in the dock and complete the host's authorization prompt if shown
2. Ensure the file matches `include` and does not match `exclude`
3. For React, use exported, named PascalCase components; in RSC mode the file must have its own `"use client"` directive
4. For Vue, ensure the component has a `<script setup>` or `<script>` block

### Story generation produces wrong imports

1. Check that component references are in the live registry (rendered on screen)
2. Vue components need the `.vue` extension in the import path

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how the tool works, local
development, and testing.

## License

MIT
