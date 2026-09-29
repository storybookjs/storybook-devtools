# Contributing

For installation and usage, see the [README](./README.md).

## Development setup

Use Node 24 and the pnpm version pinned in `package.json`.

```bash
git clone https://github.com/storybookjs/vite-plugin-experimental-storybook-devtools.git
cd vite-plugin-experimental-storybook-devtools
pnpm install
pnpm build
```

Build before running tests or starting a playground: runtime tests and some
hosts load `dist`. For ongoing development, run `pnpm dev` in a separate
terminal to rebuild the library and panel when files change.

### Playgrounds

Start the playground for the integration you are working on:

```bash
pnpm --filter playground-react dev
pnpm --filter playground-react18 dev
pnpm --filter playground-vue dev
pnpm --filter playground-nuxt dev
pnpm --filter playground-rsbuild dev
pnpm --filter playground-next dev
```

Keep equivalent components and behavior aligned across frameworks.
`playground/react18/src` and `playground/rsbuild/src` are symlinks to
`playground/react/src`; edit the shared components there. Next.js has its own
source tree to exercise React Server Components.

See [Supported frameworks](./docs/SUPPORTED_FRAMEWORKS.md) for integration
coverage and [AGENTS.md](./AGENTS.md#verifying-devtools-panel-behavior) for
interactive panel verification.

## Testing

For behavior changes, add or update tests first, confirm they fail before the
fix, then implement the change and rerun them. Reuse the shared E2E suites in
`e2e/` where possible, keeping framework-specific specs focused on differences.

Run these checks in order before submitting a code change:

```bash
pnpm build
pnpm test --run
pnpm typecheck
pnpm exec playwright test
```

Do not build concurrently with tests: the build clears `dist`.
Use `pnpm test` for unit tests in watch mode.

For Storybook peer, indexing, generation, or launcher changes, also run:

```bash
pnpm exec playwright test --config=playwright.storybook.config.ts
```

This suite launches Storybook, creates and appends stories on disk, and checks
the generated previews. Keep port 6006 free and run it separately from unit
tests and other browser suites: it temporarily changes shared story files.

To avoid conflicts with running development servers, use a free port range:

```bash
PLAYWRIGHT_PORT_OFFSET=20 pnpm exec playwright test
PLAYWRIGHT_PORT_OFFSET=20 STORYBOOK_E2E_URL=http://localhost:6007 \
  pnpm exec playwright test --config=playwright.storybook.config.ts
```

Local validation and CI use the Storybook 11 version pinned in the workspace.
Install with `pnpm install --frozen-lockfile` and run the checks above; no
version switching is required.

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

## Generated Story Format

Generated stories use the framework package from your `.storybook/main`
config. Without a config, the defaults are `@storybook/react-vite` for React,
`@storybook/vue3-vite` for Vue, and `@storybook/nextjs` for Next.js.

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

## Pull requests

Describe what changed, why, the exact validation commands and results, and any
remaining caveats. Include screenshots or a recording for visible UI changes.
Update relevant documentation in the same change:

- [README](./README.md): installation, configuration, and user-facing behavior.
- [CONTRIBUTING](./CONTRIBUTING.md): development setup and contributor workflow.
- [Architecture](./docs/ARCHITECTURE.md): module responsibilities and communication.
- [Supported frameworks](./docs/SUPPORTED_FRAMEWORKS.md): integration support.
- [AGENTS.md](./AGENTS.md): agent instructions and detailed validation procedures.
