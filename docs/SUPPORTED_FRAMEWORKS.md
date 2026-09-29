# Supported Frameworks

> React authoring-pattern support matrix (export styles, wrappers, class,
> generics, prop kinds) and documented limitations:
> [docs/REACT_PATTERNS.md](./REACT_PATTERNS.md).

Keep this file up to date whenever framework integrations are added, removed, or significantly changed.

## Bundler hosts

Support is a (framework × host) matrix, not just a framework list:

| | Vite | Rsbuild (rspack) | Next.js (webpack) |
|---|---|---|---|
| React | verified (18 + 19, `playground/react` + `playground/react18`) | verified (19, `playground/rsbuild`) | verified (19, `playground/next`, App Router + RSC) |
| Vue | verified (`playground/vue`) | accepted, not playground/E2E-verified | n/a |
| Nuxt SSR | verified (`playground/nuxt`) — rides the Vue integration on Vite | n/a — Nuxt is a Vite framework | n/a |

Vite: `./react`, `./vue`, or the unified `./vite` entry. Rsbuild: `./rsbuild`
(`storybookDevtoolsRsbuild({ framework })`). Next.js: `./next`
(`withStorybookDevtools()`). See the README's per-host sections for setup
and host-specific options.

The shared browser suite exercises first-click highlighter activation and
repeated close/reopen through the actual dock on all six playgrounds. A separate
serial suite launches Storybook and verifies generated stories and previews on
five hosts; React 18 intentionally tests the missing-config failure path.
The playgrounds pin Storybook `11.0.0-alpha.1`; the full unit, browser and
Storybook suites also pass on `10.6.0` (`node scripts/pin-storybook.mjs
10.6.0` re-pins the workspace). The peer range is `>=10.6.0 || ^11.0.0-0`.
Story format: `playground/vue` uses CSF factories (`definePreview` in
`.storybook/preview.ts`, so new and appended stories are `meta.story(...)`);
every other Storybook playground stays on CSF3, and the Storybook suite
asserts each host's format. `@storybook/nextjs` is
deprecated in Storybook 11 (it logs a deprecation warning on every run; the
Next playground still uses it), and `vue-docgen-api` logs a deprecation warning
for the Vue-based playgrounds.

## React

- Package: `src/frameworks/react`. React 18 and 19 are both required and
  verified via `playground/react` (19) and `playground/react18` (18),
  Playwright projects `react-chromium` / `react18-chromium`. They share
  one source tree — `playground/react18/src` symlinks to
  `playground/react/src`.
- Also verified on Rsbuild (`playground/rsbuild`, React 19,
  `rsbuild-chromium`, same source tree) and Next.js (`playground/next`,
  App Router, `next-chromium`, its own source tree since it exercises the
  RSC gate in `rsc: true` mode).
- Detection reads the live fiber tree through the React DevTools global
  hook; components are never wrapped.
- Caveat: `dedupeReact` (default `'auto'`) adds `react`/`react-dom` to
  `resolve.dedupe` only when a React-major mismatch is detected, fixing
  React 18 prop serialization automatically; `false` opts out with a
  warning.
- See [docs/REACT_PATTERNS.md](./REACT_PATTERNS.md) for the
  authoring-pattern matrix and the `rsc` option.

## Vue

- Package: `src/frameworks/vue`. Vue 3 SFCs, verified on Vite via
  `playground/vue`, `vue-chromium`.
- Rsbuild accepts `framework: 'vue'` but has no playground or E2E
  coverage — treat Vue-on-Rsbuild as unverified.
- Detection installs a minimal `__VUE_DEVTOOLS_GLOBAL_HOOK__` before the
  app's `createApp` runs, then subscribes to Vue's devtools events.
  Components are never wrapped. Only source paths accepted by the transform's
  include/exclude filter are tracked; dependency-owned DevTools components
  are excluded from the app registry.
- Caveat: unmount tracking requires the hook's `cleanupBuffer` method,
  present only because the hook is installed before the app mounts. Live
  prop editing is supported; see docs/ARCHITECTURE.md for the mechanism.

## Nuxt SSR

- The release QA playground uses Nuxt 4.5.2, with Vite's native
  `devtools.enabled` option. Do not add an explicit `DevTools()` plugin to
  this setup; older Nuxt builders required it, but this version mounts it
  automatically.

- Standalone Storybook uses `@storybook/vue3-vite` with an explicit
  `@vitejs/plugin-vue` in `.storybook/main.ts`. It does not inherit
  Nuxt's Vite plugins. The panel-launch smoke suite verifies the preview.

- Verified via `playground/nuxt`, `nuxt-chromium`, as an SSR consumer of
  the Vue integration. Package: `src/frameworks/nuxt/plugin.ts`, exporting
  `getNuxtDevToolsHookScript()` / `getNuxtViteDevToolsInjectionScript()`
  for `nuxt.config.ts` head injection, plus `viteDevToolsBridgeModule`.
- Caveat: Nuxt's Nitro server routes devtools requests around Vite's
  middleware by default, so the consuming app must register
  `viteDevToolsBridgeModule` in `nuxt.config.ts`'s `modules` array for the
  dock to load.
- SSR + hydration integrity is verified by `e2e/common-ssr-suite.ts`
  against the playground's `HydrationInfo` component: markup in the raw
  HTML payload, hydration without mismatch, hydrated instance in the
  highlighter registry.
