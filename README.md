# Storybook DevTools

Dev-server devtools for visual component highlighting and automatic Storybook story generation. It instruments React, Vue, and Nuxt SSR components on top of Vite, Rsbuild, or Next.js. Hover over components in your running app to see their details and create stories with a single click.

## Features

- **Component Highlighting** - Visual overlay on React, Vue, and Nuxt SSR components
- **One-Click Story Generation** - Create Storybook stories directly from your running app
- **Interaction Recording** - Record user interactions and generate stories with play functions
- **Props Serialization** - Serializes JSX children, Vue slots, nested components, and reactive objects
- **Append to Existing Stories** - Add new story variants to existing story files
- **Smart Imports** - Automatically resolves and adds component imports
- **DevTools Integration** - Dock panel with Storybook, Coverage, Terminal, and Docs tabs
- **Coverage Dashboard** - Track story coverage across all detected components using the Storybook index, refreshed after story-file edits on every host
- **Copy Prompt** - Copy LLM-friendly component context to clipboard for AI-assisted development
- **Development Only** - Never runs in production builds
- **Keyboard Shortcuts** - Quick toggles and navigation

## Installation

```bash
npm install @storybook/experimental-devtools
# or
pnpm add @storybook/experimental-devtools
# or
yarn add @storybook/experimental-devtools
```

### Peer Dependencies

- `storybook` >= 10.6.0
- One bundler host: `vite` >= 5.0.0 with `@vitejs/devtools` >= 0.6.0, `@rsbuild/core` >= 1.1.7, or `next` (App Router, webpack dev)
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

### Nuxt SSR

```typescript
// nuxt.config.ts
import { DevTools } from '@vitejs/devtools'
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
    plugins: [DevTools(), componentHighlighter()],
  },
})
```

Nuxt SSR uses the Vue component runtime. Register `viteDevToolsBridgeModule` so
the DevTools dock and its assets are reachable through Nuxt's dev server, and
add both head scripts so the highlighter is wired up before and after
hydration. Pin `vite.server.host` if the page and the DevTools websocket need
to agree on a host (for example `127.0.0.1`). When running Storybook for Nuxt
components, omit the module, the DevTools plugin, the component highlighter
plugin, and the head scripts from the Storybook process.

### Vite (unified entry)

`./react` and `./vue` are thin wrappers over a single `./vite` entry that
picks the framework via an option instead of the import path:

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { DevTools } from '@vitejs/devtools'
import { storybookDevtools } from '@storybook/experimental-devtools/vite'

export default defineConfig({
  plugins: [
    react(),
    DevTools(),
    storybookDevtools({ framework: 'react' }),
  ],
})
```

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
- **`framework: 'vue'`** is accepted, but only `framework: 'react'` is playground/E2E-verified on Rsbuild today.
- **`dedupeReact`** works the same as on Vite — see "React version support" below.

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
- **`rsc`** *(default `true`)* — only modules with a `"use client"` directive are instrumented; server components are never registered or highlighted. A module that is client-only transitively (imported by a `"use client"` module but carrying no directive of its own) is not instrumented either — only modules with their own directive are tagged.
- **Story generation** imports from the framework package read out of your `.storybook/main` config (e.g. `@storybook/nextjs-vite`); falls back to `@storybook/nextjs` when no Storybook config is found.
- **Manual hook fallback** — if entry injection isn't viable in your setup, `getNextDevToolsHookScript()` returns the same hook script for manual delivery, e.g. via `<Script strategy="beforeInteractive">` in the root layout.

### Start developing

```bash
npm run dev
```

Open Vite DevTools (floating button, usually bottom-right) and activate the **Component Highlighter** dock entry.

Once the dock is active:
- **Hover** over any component to see its highlight and tooltip
- **Click** on a component to open the context menu
- **Press Alt/Option** to toggle click-through mode (interact with the app underneath highlights)
- **Create stories** with a single click

## Usage

### Highlight Modes

| Mode | Trigger | Description |
|------|---------|-------------|
| **Hover** | Mouse over | Highlights single component under cursor |
| **Click-through** | Press `Alt/Option` | Toggles click-through mode so you can interact with the app underneath highlights |
| **Clear Selection** | `Escape` | Clears current component selection |
| **Exit Highlighting** | `Escape` x2 (within 600ms) | Turns off highlight mode entirely |

### Highlight Colors

- **Pink solid border** - currently hovered component
- **Pink dashed border** - other instances of the same component type
- **Pink background (20%)** - selected component (context menu open)

### Context Menu and Story Creation

Click a highlighted component to open its context menu:

- **Open Code** / **Open Story** - open the source or story file in your editor (Open Story is omitted if no story exists yet)
- **Copy Prompt** - copies an LLM-friendly prompt with component name, path, props, and story status
- **View Story** - navigates to the story in the embedded Storybook panel
- **Properties** - all current props with type-colored badges, expandable objects, copy buttons

To create a story: enter a name (auto-suggested from meaningful props like
variant, size, type), then click **Create** for a story with the current
props, or **Create with Interactions** to record clicks/typing/selections
first and generate a story with a play function.

The story file is created at `<component-dir>/<ComponentName>.stories.{ts,tsx}` (`.ts` for Vue, `.tsx` for React). If the file already exists, a new named export is appended to it on the CSF syntax tree via Storybook's own `csf-tools`, so the rest of the file — comments, quote style, formatting — is left byte-identical, the export name is deduplicated against everything the file already declares, and imports the new story needs are merged into matching existing import statements. A story file that Storybook cannot parse as CSF still gets the new export, appended as text.

Generated files are formatted with your project's prettier when you have one installed.

### Coverage Dashboard

The **Coverage** tab shows a progress bar, a table of all detected
components with their story status, and visibility indicators for what's
currently rendered. **Create all** generates stories for every visible
component instance, deduplicating by props fingerprint; per-component
buttons create one story at a time. When several instances share a
fingerprint, the one with live prop edits is used, and the creation toast
names which instance the story came from.

Whether a component "has a story" is decided from a real Storybook story
index built from your `stories` globs — the same matching Storybook itself
uses, so it respects custom titles and stories living outside a component's
own directory. If no Storybook project is found (or indexing fails), the
index is instead synthesised from a scan for `<ComponentName>.stories.*`
files, and coverage matches against that.

### DevTools Panel Tabs

| Tab | Description |
|-----|-------------|
| **Storybook** | Embedded Storybook iframe with start/status controls |
| **Coverage** | Component story coverage dashboard with bulk creation |
| **Terminal** | Live Storybook process output with error highlighting |
| **Docs** | Embedded Storybook documentation |

## Configuration

```typescript
componentHighlighter({
  // Glob patterns for files to instrument.
  // Default differs per framework: '**/*.{tsx,jsx}' for React, '**/*.vue' for Vue/Nuxt.
  include: ['**/*.{tsx,jsx}'],

  // Glob patterns to exclude
  exclude: ['**/node_modules/**', '**/dist/**'],

  // Subdirectory for generated story files (relative to component)
  storiesDir: undefined,

  // Enable debug logging
  debugMode: false,

  // Force instrumentation in production (default: false)
  force: false,

  // Single-React enforcement for the prop serializer (React only).
  // 'auto' (default) | true | false  — see "React version support" below.
  dedupeReact: 'auto',

  // React Server Components mode (React only, default: false).
  // When true, only modules with a "use client" directive are instrumented
  // (for Vite-based RSC frameworks like TanStack Start). Leave false for SPAs.
  // See "React Server Components" in docs/REACT_PATTERNS.md.
  rsc: false,

  // How the devtools-hook script is delivered to the browser.
  // 'html' (default): prepend an inline <script> to the served HTML.
  // 'entry': inject a side-effect import into the app's entry module(s)
  // instead — no HTML transform involved.
  hookInjection: 'html',

  // Picomatch pattern(s) identifying the app's entry module id(s).
  // Required when hookInjection is 'entry'.
  entry: undefined,
})
```

### React version support (18 and 19)

React detection reads the live React fiber tree via the DevTools global hook
and never wraps your components, so the rendered tree stays clean and RSC
keeps working. React 18 and 19 are both supported and covered by E2E.

Which authoring patterns are detected, and the documented limitations, are in
**[docs/REACT_PATTERNS.md](./docs/REACT_PATTERNS.md)**.

The `dedupeReact` option matters when the plugin's bundled
`react-element-to-jsx-string` resolves a different React major than your
app's (for example your app is on React 18 but the plugin's copy is 19) —
in that case prop serialization silently degrades to a "Failed to
serialize" placeholder unless a single React instance is enforced.

| Value | Behavior |
|-------|----------|
| `'auto'` *(default)* | Detects a React major mismatch and adds `react`/`react-dom` to `resolve.dedupe` **only when needed**. Single-version apps (the common React 19 case) get **no config mutation at all**. |
| `true` | Always dedupe. |
| `false` | Never dedupe. For advanced setups that intentionally run multiple React copies (module federation / micro-frontends). If a mismatch is detected while disabled, a one-line warning is logged. |

If you set `dedupeReact: false` and need the fix manually, add this to your
Vite config:

```ts
// vite.config.ts
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
})
```

### Default Exclusions

The following patterns are excluded by default:
- `**/node_modules/**`
- `**/dist/**`
- `**/*.d.ts`
- `**/*.stories.*`
- `**/stories.*`
- `**/*.story.*`
- `**/story.*`

## Generated Story Format

The `Meta`/`StoryObj` import below comes from the framework package read out
of your project's `.storybook/main` config (`@storybook/react-webpack5`,
`@storybook/nextjs-vite`, etc.) — `@storybook/react-vite` and
`@storybook/vue3-vite` shown here are just the defaults each playground
uses. When no Storybook config is found, generation falls back to the
framework's own default (`@storybook/react-vite` for React, `@storybook/vue3-vite`
for Vue, `@storybook/nextjs` for the Next.js host).

### React

```typescript
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import MyButton from './MyButton';
import Icon from './Icon';

const meta: Meta<typeof MyButton> = {
  component: MyButton,
};

export default meta;
type Story = StoryObj<typeof MyButton>;

export const Primary: Story = {
  args: {
    variant: 'primary',
    label: 'Click me',
    icon: <Icon name="star" />,
    onClick: fn(),
  },
};
```

### Vue

```typescript
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import Button from './Button.vue';

const meta: Meta<typeof Button> = {
  component: Button,
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Secondary: Story = {
  render: (args) => ({
    components: { Button },
    setup() {
      const componentArgs = Object.fromEntries(
        Object.entries(args).filter(([key]) => !key.startsWith('slot:')),
      );
      return { componentArgs };
    },
    template: `<Button v-bind="componentArgs">Click me</Button>`,
  }),
  args: {
    variant: 'secondary',
    size: 'default',
  },
};
```

### Supported Prop Types

| Type | React | Vue | Generated Code |
|------|-------|-----|----------------|
| Primitives | `"hello"`, `42`, `true` | Same | Direct values |
| Objects | `{ nested: { value: 1 } }` | Reactive objects auto-unwrapped | `{ nested: { value: 1 } }` |
| Arrays | `[1, 2, 3]` | Same | `[1, 2, 3]` |
| JSX Elements | `<Icon />` | N/A | `<Icon />` (with import) |
| Vue Slots | N/A | `<slot />` | Template syntax in render function |
| Functions | `onClick={handler}` | `@click="handler"` | `fn()` (with import) |
| Children | `<>Hello <Button /></>` | Default slot content | Framework-specific syntax |

## How it works

Build-time transforms tag your components without wrapping or reconstructing
them, so the rendered tree stays untouched. At runtime, each framework's
DevTools hook reports component instances as they mount, and the plugin
registers them with their metadata, props, and DOM elements. A client-side
overlay renders highlights and the context menu on top of your running app.
When you create a story, the serialized props are sent to the dev-server
plugin, which writes the story file to disk. Interaction recording captures
your clicks, typing, and selections as an ordered list of steps and formats
them into a Storybook play function.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module-level
breakdown.

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
- **Bundler hosts** - Vite, Rsbuild, and Next.js (webpack) are supported; on Rsbuild, only `framework: 'react'` is playground/E2E-verified (Vue is accepted but unverified); Next.js is React-only (`@storybook/nextjs`) and only instruments `"use client"` modules
- **Development only** - Disabled in production builds by default
- **DevTools required** - Vite hosts need `@vitejs/devtools` for the dock panel and RPC; Rsbuild and Next.js hosts get the dock through a bundled devframe hub instead
- **Provider dependencies** - Components requiring context providers may need Storybook decorators

## Troubleshooting

### Stories aren't being created

1. Ensure the DevTools dock is open and the Component Highlighter entry is active
2. Check the browser console for errors
3. Verify the output path is writable

### Components not being highlighted

1. Ensure the file matches the `include` patterns
2. Check that it's not matching an `exclude` pattern
3. For Vue, ensure the component has a `<script setup>` or `<script>` block

### Story generation produces wrong imports

1. Check that component references are in the live registry (rendered on screen)
2. Vue components need the `.vue` extension in the import path

## Development

### Setup

```bash
git clone https://github.com/storybookjs/vite-plugin-experimental-storybook-devtools.git
cd vite-plugin-experimental-storybook-devtools

pnpm install
```

### Available Scripts

```bash
# Run React playground
pnpm --filter playground-react dev

# Run Vue playground
pnpm --filter playground-vue dev

# Run Rsbuild playground (build first — its dev-time runtime is served from dist/)
pnpm build
pnpm --filter playground-rsbuild dev

# Run Next.js playground (App Router, webpack — not Turbopack)
pnpm --filter playground-next dev

# Run unit tests
pnpm test

# Run E2E tests (starts playgrounds automatically)
pnpm exec playwright test

# Build the library
pnpm build

# Type check
pnpm typecheck
```

## License

MIT
