# Devframe Migration — Feasibility Report & Phased Plan

> Historical design notes. Version references and proposed work describe the
> original investigation; see [Architecture](../ARCHITECTURE.md) and
> [Supported frameworks](../SUPPORTED_FRAMEWORKS.md) for current behavior.

Status: **Phases 1–4 implemented** (Vite family: React 19 / React 18 / Vue
green on devframe 0.9 / devtools-kit 0.6; core re-platformed onto `unplugin`
with zero behavior change; Rsbuild and Next.js hosts mounted on that core —
see `docs/ARCHITECTURE.md` and the README's host sections for the as-built
shapes). This document records
the investigation into migrating this plugin onto [devframe](https://devfra.me/)
(the extracted core of Vite DevTools) and extending it to non-Vite hosts, the
agreed phased plan, and the as-built Phase 1 outcome (see
[Phase 1 — as built](#phase-1--as-built)).

## TL;DR

The plugin splits cleanly into two layers with very different migration costs:

| Layer | Coupled to | Migration verdict |
| --- | --- | --- |
| Devtools plumbing (RPC, dock, panel, shared state, terminals, diagnostics, commands) | `@vitejs/devtools-kit` 0.3.3 `devtools.setup(ctx)` | **Near 1:1 mapping** onto `defineDevframe()` — highly migratable |
| Code instrumentation (Babel/SFC transforms, virtual modules, HTML injection, HMR events) | Vite's transform pipeline | **Not abstracted by devframe** — needs an unplugin port for non-Vite hosts |

The in-browser runtime (component registry, overlay, context menu, prop
editor, interaction recorder) is already bundler-agnostic: it hooks the
framework devtools globals (`__REACT_DEVTOOLS_GLOBAL_HOOK__`,
`__VUE_DEVTOOLS_GLOBAL_HOOK__`), not the bundler.

## What devframe is

- The framework-neutral devtools foundation extracted from Vite DevTools, by
  Anthony Fu, MIT — "unplugin for devtools". Vite DevTools is its first
  flagship host; `@vitejs/devtools-kit` 0.6.0 depends on `devframe@^0.9.5`.
- One `defineDevframe({ id, name, version, packageName, homepage, description,
  icon, clientAssets, setup(ctx) })` definition mounts as: a Web-standard
  `Request → Response` handler, connect middleware, a CLI, a standalone dev
  server, a static report, an MCP server, or a Vite DevTools dock (via
  `createPluginFromDevframe` from `@vitejs/devtools-kit/node`).
- RPC: type-safe bidirectional birpc, function types
  `query`/`static`/`action`/`event`, optional Standard Schema validation.
- Shared state: observable, patch-synced server↔browser, survives reconnects.
- Transport: **its own WebSocket at `<base>__ws` + SSE fallback** — not the
  Vite HMR channel. Discovery via `__connection.json`.
- Hub (`@devframes/hub`): headless composition layer providing docks,
  commands, terminals, and messages behind one handler; `@devframes/hub-ui`
  is the reference floating-dock UI. Hub mounts in any host with adapters or
  examples for Vite, Nuxt, Next.js, Rsbuild, Hono, Nitro, Fastify, SvelteKit,
  Deno, Bun.
- Security: localhost + trust handshake (`requestTrustWithToken`,
  `__DEVFRAME_CONNECTION_AUTH_TOKEN__` — the rename we already track in
  `AGENTS.md`).
- Maturity caveat: **pre-1.0 with breaking changes each minor** (published
  migration guides for 0.6 → 0.9 at <https://devfra.me/migrations>).

Key references: <https://devfra.me/guide> · <https://devfra.me/adapters> ·
<https://devfra.me/guide/hub> · <https://devfra.me/guide/transports> ·
<https://devtools.vite.dev/kit/> · <https://github.com/devframes/devframe>

## Current coupling inventory

### Devtools-kit surface (migrates to devframe)

All in `src/create-component-highlighter-plugin.ts` unless noted:

| Today (`@vitejs/devtools-kit` 0.3.3) | Devframe 0.9 equivalent |
| --- | --- |
| `devtools.setup(ctx)` Vite-plugin hook | `defineDevframe({ setup(ctx) })` + `createPluginFromDevframe` |
| `defineRpcFunction`, `ctx.rpc.register/broadcast/invokeLocal` | `defineRpcFunction` (birpc; `query`/`action`/`event` types) |
| `ctx.rpc.sharedState` (`registry`, `pending-visit`, `pending-tab`, `highlight-active`, `selected-component`, `highlighter-tab-active`) | devframe shared state (patch-synced) |
| `ctx.docks.register` (action dock + iframe dock) | derived from definition metadata by `createPluginFromDevframe`; hub docks elsewhere |
| `ctx.views.hostStatic('/.storybook-devtools/', distPanel)` | `clientAssets` / `view: { type: 'spa', distDir }` |
| `ctx.terminals.startChildProcess` (Storybook process) | hub terminals (available wherever hub is mounted) |
| `ctx.messages` (notifications, `src/notifications.ts`) | hub messages / `@devframes/plugin-messages` |
| `ctx.diagnostics` (`CH_TRANSFORM_FAILED`, `CH_UNSUPPORTED_PATTERN`) | `nostics` structured diagnostics |
| `ctx.commands.register` (Mod+K palette) | hub commands |
| `@vitejs/devtools-kit/client` `getDevToolsClientContext`, `ensureTrusted`, `rpc.client.register` (`src/client/listeners.ts`, `overlay.ts`, `vite-devtools.ts`) | `connectDevframe` from `devframe/client` (auto-auth) |
| `getDevToolsRpcClient` in the panel (`src/panel/panel.ts`) | `connectDevframe` |
| `declare module '@vitejs/devtools-kit'` RPC/state augmentations | devframe definition-level typing |

### Vite-pipeline surface (needs unplugin / per-host work)

| Today | Portability |
| --- | --- |
| `transform` hook running Babel (React) / SFC prepend (Vue) instrumentation | unplugin `transform` — same code, portable to webpack/rspack |
| `resolveId`/`load` virtual modules (`virtual:component-highlighter/*`) | unplugin virtual-module support |
| `transformIndexHtml` head-prepend devtools-hook bootstrap (CSP-nonced) | **not portable** — replaced by entry-module injection on non-Vite hosts |
| `handleHotUpdate` remap + `server.ws.send('component-highlighter:story-created')` + `import.meta.hot.on` | replaced by devframe events/shared state (transport unification) |
| 6 connect middleware endpoints `/__component-highlighter/*` | replaced by devframe RPC functions (transport unification) |
| `config` mutations: `optimizeDeps`, `resolve.alias`, `resolve.dedupe` (`dedupeReact`) | Vite-only concern; webpack/rspack need host-config equivalents (Next dedupes React itself; Rsbuild via `resolve.alias`) |
| `server.transformRequest` to serve TS runtime in dev | Vite-only convenience; unplugin path bundles the runtime normally |

## Decisions (settled)

1. **Deliverable**: this report + the phased plan below. No tracker tickets.
2. **Motivation**: (a) catch up to the current Vite DevTools (kit 0.6 /
   devframe 0.9) — we are four breaking minors behind; (b) reach non-Vite
   hosts.
3. **Target hosts**: Vite family (plain Vite, Nuxt, Astro, SvelteKit), then
   **Rsbuild**, then **Next.js (webpack, App Router)**. Turbopack is out of
   scope (unplugin does not support it) and will be documented as unsupported.
4. **Back-compat**: clean cut. Drop `@vitejs/devtools` 0.3.x support entirely.
5. **Version policy**: pin `devframe` 0.9.x and use its APIs **directly** (no
   internal adapter layer). Absorb future 0.x migration work as it comes.
6. **Transform delivery**: port instrumentation to **unplugin** — one
   implementation mounted via unplugin adapters for Vite, webpack (Next), and
   rspack (Rsbuild).
7. **Next.js scope**: `next dev` with webpack + App Router. RSC handled by the
   existing `"use client"` transform gate (`rsc` option); the Next playground
   doubles as the currently-missing runtime RSC playground (see `AGENTS.md`).
8. **Packaging**: single npm package with subpath exports (`./vite`,
   `./rsbuild`, `./next`, `./devframe`) — the standard `unplugin-*` layout.
   **The package name stays as-is** (no rename).
9. **Panel UI**: keep the vanilla TS SPA (`src/panel`), shipped as devframe
   `clientAssets`. No JSON-Render rewrite. Only the RPC client wiring changes
   (`getDevToolsRpcClient` → `connectDevframe`).
10. **Transport unification**: full. The 6 middleware endpoints become
    devframe RPC functions; the Vite HMR events (`import.meta.hot`,
    `server.ws.send`) become devframe events/shared state. One transport,
    identical in every host.
11. **Terminals**: keep riding hub terminals. Since every target host mounts
    hub (or Vite DevTools, which embeds it), the Storybook Terminal tab works
    everywhere.
12. **Vite mounting**: **requires `@vitejs/devtools`** (dock via
    `createPluginFromDevframe`, kit ≥ 0.6). No standalone-Vite fallback path.
13. **Non-Vite mounting**: `@devframes/hub` + `@devframes/hub-ui` floating
    dock in-page, mirroring the Vite DevTools experience.
14. **Head-script injection on non-Vite hosts**: the devtools-hook bootstrap
    (must run before React/Vue loads) is prepended as the **first import of
    the app entry** via unplugin (plus Rsbuild's HTML hooks where available),
    with a documented manual `<Script>`/import fallback.
15. **Playgrounds/E2E**: add `playground/rsbuild` (React) and
    `playground/next` (App Router), both wired into the shared E2E suites and
    CI-gated, per repo rules.
16. **MCP**: omitted entirely from this plan.

## Phased plan

Each phase is independently shippable and lands as its own PR (or small PR
series), tests first, with existing playgrounds green throughout.

### Phase 1 — Devframe core migration (Vite-only, feature parity)

Goal: replace the kit-0.3.3 surface with devframe 0.9 / kit 0.6; no new
hosts. Everything in the coupling table's left column moves to the right
column.

- Bump to `@vitejs/devtools` / `@vitejs/devtools-kit` 0.6.x and add
  `devframe@0.9.x`. Walk the published migration guides (0.6 → 0.9):
  required definition metadata, `anonymous:` auth prefix, crossws, schema
  validation changes, 0.9 API trims.
- Introduce `defineDevframe()` with the full RPC table from
  `docs/ARCHITECTURE.md` (server RPCs + client broadcast handlers + shared
  states) and mount in Vite via `createPluginFromDevframe`.
- Ship `dist/panel` as `clientAssets`; rewire `src/panel/panel.ts` and
  `src/client/*` from `@vitejs/devtools-kit/client` to `devframe/client`
  (`connectDevframe`, auto-auth replaces the manual `ensureTrusted` dance).
- **Transport unification**: convert the `/__component-highlighter/*`
  middleware endpoints to devframe RPC functions; replace
  `component-highlighter:story-created` HMR event and `import.meta.hot`
  listeners with devframe events/shared state.
- Terminals (Storybook process), messages, diagnostics, and commands move to
  their hub/devframe equivalents.
- Update `AGENTS.md` (interactive-QA instructions: dock element, auth
  snippet), `docs/ARCHITECTURE.md` (RPC table, endpoints, globals), and
  `README.md` (peer requirements: `@vitejs/devtools >= 0.6`).
- Exit criteria: `pnpm test` + full Playwright suite green on all existing
  playgrounds (React 18/19, Vue); manual panel QA per `AGENTS.md` passes.

Risks: auth/trust flow differences; shared-state semantics under reconnect;
CSP-nonce handling for injected scripts under the new host.

#### Phase 1 — as built

The migration was **materially smaller than planned**, because
`@vitejs/devtools-kit` 0.6 kept the `devtools.setup(ctx)` plugin surface
(RPC, docks, `views.hostStatic`, terminals, messages, diagnostics, commands)
API-compatible with 0.3. So the plan's more invasive items were **not needed**
for the kit-hosted Vite path and are deferred to the host-adapter phases:

- **Not done (unnecessary for kit-hosted Vite):** re-expressing the tool as a
  standalone `defineDevframe()` definition, `createPluginFromDevframe`,
  transport unification (the `/__component-highlighter/*` middleware and the
  `component-highlighter:story-created` HMR event still work unchanged), and
  migrating terminals/messages/commands to raw hub APIs. These become relevant
  only when mounting outside `@vitejs/devtools` (Phases 3–4 + the Nuxt adapter
  below).

What actually changed:

- Bumped `@vitejs/devtools` + `@vitejs/devtools-kit` to `^0.6.0` in the root
  and in **all four playgrounds** (clean cut from 0.3.x).
- **Shared-state object envelopes** — the only real API break. devframe 0.9
  shared state is immer-backed and typed `get<T extends object>`, so primitive
  and `null` top-level states are rejected at compile time *and* runtime.
  Every scalar/nullable state moved to a `{ value }` envelope
  (`highlight-active`, `highlighter-tab-active`, `pending-visit`,
  `pending-tab`, `selected-component`); `registry` stays flat (arrays are
  objects). Updated both the server (`create-component-highlighter-plugin.ts`)
  and every client reader/writer (`panel.ts`, `client/listeners.ts`,
  `client/overlay.ts`).
- **Nuxt injection helper** updated for 0.6: the old
  `virtual:vite-devtools-injection` module is gone; 0.6 serves the embedded
  dock from `<mountPath>embedded.js`, so `getNuxtViteDevToolsInjectionScript()`
  now emits the runtime `<script src="/__devtools/embedded.js">` bootstrap
  (mirroring `@vitejs/devtools`' own injection plugin).

Verification: `pnpm typecheck` clean, `pnpm test` 254 passing, `pnpm exec
playwright test` 76/76 on React 19 / React 18 / Vue.

##### Nuxt SSR dock — restored via a bridge module

0.6 stopped serving the dock through Vite's module graph and now serves it from
a connect-middleware route at `/__devtools/embedded.js`. Under Nuxt SSR, Nuxt
does pipe requests through the client Vite middleware stack, but marks
non-build-asset requests with `_skip_transform` and rewrites their URL onto
`/__skip_vite/*` before the devtools middlewares match — so the dock UI (and
every other devtools HTTP route) fell through to Nitro's SSR catch-all.

`viteDevToolsBridgeModule` (exported from the `/nuxt` entry, registered under
`modules` in `nuxt.config.ts`) clears that flag for devtools-owned paths and
re-bases `/@id/*` and dock-imports URLs onto Vite's build-assets base, making
the full DevTools surface reachable through Nuxt's dev server. The RPC
WebSocket needs no bridging: with Vite in middleware mode the devtools hub
starts a sidecar WebSocket and advertises it through `__connection.json`. The
`injects the Vite DevTools dock` E2E test runs (un-skipped) against this.

A devframe-level fix could eventually replace the bridge — tracked upstream as
[devframes/devframe#289](https://github.com/devframes/devframe/issues/289).
The previously-noted non-fatal `DF8111` warning at startup is resolved by
pre-seeding the host's client-module-resolution template before dock
registration.

### Phase 2 — unplugin refactor (Vite still the sole consumer)

Goal: re-platform instrumentation delivery without changing behavior.

- Move `transform`/`resolveId`/`load` logic into an unplugin factory; keep
  Vite-specific niceties (e.g. `server.transformRequest` dev-source serving,
  `optimizeDeps`/`resolve` mutations) in the Vite adapter only.
- Replace `transformIndexHtml` with a dual strategy: keep HTML injection on
  Vite; implement entry-module injection as the portable path (behind a
  flag, exercised by unit tests now, by new hosts in Phases 3–4).
- Restructure exports: `./vite` (existing entry, now unplugin-backed),
  `./devframe` (the raw definition), placeholders for `./rsbuild`, `./next`.
- Exit criteria: zero behavior change on Vite playgrounds; transform unit
  tests (`src/frameworks/*/transform.test.ts`) unchanged and green.

Risks: virtual-module id conventions differ across bundlers (`\0` prefix
handling); HMR-adjacent behavior (`handleHotUpdate`) must stay Vite-side.

#### Phase 2 — as built

`create-component-highlighter-plugin.ts` now builds an **`unplugin` factory**
instead of a raw Vite `Plugin`:

- **Portable hooks at the top level** — `resolveId`, `load`, `transform` — so
  Phase 3+ bundlers (Rsbuild/webpack) pick them up unchanged. The `transform`
  keeps an optional 3rd `options` param for Vite's `ssr` flag: unplugin
  forwards it at runtime under Vite (via `handler.apply(this, args)`) but
  doesn't type it, and it's simply `undefined` on non-Vite bundlers.
- **Everything Vite-specific under `vite: {}`** — `config`, `configResolved`,
  `configureServer`, `transformIndexHtml`, `handleHotUpdate`, and the entire
  `@vitejs/devtools-kit` `devtools.setup` hook. unplugin merges these onto the
  Vite plugin via `Object.assign`, so the Vite plugin is functionally the same
  object as before.
- `createComponentHighlighterPlugin(framework, options)` **keeps its exact
  public signature** — it returns `createUnplugin(factory).vite()`, which for a
  single-plugin factory yields a single Vite `Plugin` (unchanged shape for the
  `./react`, `./vue`, `./nuxt` entries and their consumers).

Deliberately **deferred to Phase 3** (to avoid shipping unused code):

- No `server.transformRequest`/`optimizeDeps`/`\0`-id portability adaptations
  yet — they still work under Vite and only need per-bundler handling when a
  non-Vite host actually consumes the portable hooks.
- No entry-module injection path yet (that's the non-Vite HTML-injection
  substitute — added with the first non-Vite host).
- No new subpath exports (`./rsbuild`, `./next`) or per-framework unplugin
  instances yet — those land with their consuming host so the package never
  ships placeholder entry points.

Verification: `pnpm typecheck` clean, `pnpm test` 254 passing, `pnpm exec
playwright test` **101 passing / 1 skipped** — identical to Phase 1 (zero
behavior change under Vite).

### Phase 3 — Rsbuild host

Goal: first non-Vite host, chosen because rspack's transform surface is
closest to Vite's and there is no RSC axis.

- `./rsbuild` subpath: unplugin rspack adapter + `@devframes/hub` mounted on
  Rsbuild's dev-server middleware + `@devframes/hub-ui` floating dock.
- Devtools-hook bootstrap via Rsbuild HTML hooks (preferred) with
  entry-injection fallback.
- React dedupe/alias equivalents via Rsbuild `resolve` config guidance.
- Add `playground/rsbuild` (React, mirroring `playground/react` component
  structure) and wire it into `e2e/common-highlighter-suite.ts`; CI-gated.
- Update `docs/SUPPORTED_FRAMEWORKS.md` with a hosts dimension.
- Exit criteria: shared E2E suite green on Rsbuild; both save flows
  (`Create`, `Create with Interactions`) verified.

Risks: rspack loader ordering vs unplugin transform stage; no
`server.transformRequest` equivalent (bundle the runtime instead).

#### Phase 3 — as built

- **`./rsbuild` entry** — `storybookDevtoolsRsbuild({ framework, clientAuth,
  ...options })` (`src/rsbuild.ts`): instrumentation mounts via
  `unplugin.rspack()` in `modifyRspackConfig` (the core's `\0` virtual ids
  round-trip unchanged through rspack's virtual-filesystem encoding); the
  devtools-hook script and the hub's embedded-dock bootstrap are injected via
  `modifyHTMLTags`; a `@devframes/hub` (+ `@devframes/hub-ui` dock) mounts on
  the dev server's Connect middlewares in `onBeforeStartDevServer`, riding a
  sidecar WebSocket (`ws: { sidecar: true }` — Rsbuild's request handlers
  never see socket upgrades). `clientAuth: false` disables devframe's OTP
  gate for single-user localhost / E2E.
- **Host-neutral extractions** — the hub surfaces (notifications,
  diagnostics, terminals, action dock, Mod+K commands) moved to
  `src/hub-setup.ts` (`registerStorybookHubSurfaces`), shared verbatim by the
  Vite `kitSetup` and the hub's `configure` callback; React-major-mismatch
  detection moved to `src/react-dedupe.ts`, each adapter applying the result
  to its own bundler's `resolve.dedupe` (Rsbuild also aliases
  `react-element-to-jsx-string`/`react-is` to this package's copies).
- **No dev-source path** — rspack has no `server.transformRequest`
  equivalent, so the runtime virtual modules always serve built `dist/`
  output (`host.loadDevSource` absent, gated in `src/unplugin.ts` and
  unit-covered). The dock's client script ships as a self-contained browser
  bundle (`dist/client-bundled/`, `tsdown.config.ts`'s second entry) served
  from a dedicated middleware, because rspack has no `/@id/{specifier}` URL
  for bare-specifier client imports.
- **Playground + E2E** — `playground/rsbuild` (React 19) is a third symlink
  consumer of `playground/react/src`, wired into the shared detection and
  highlighter suites as Playwright project `rsbuild-chromium` (port 5177;
  `pnpm build` must run first). Vue is accepted by the adapter but not
  playground-verified.

Verification: `pnpm typecheck` clean, `pnpm test` 261 passing,
`pnpm exec playwright test` green including `rsbuild-chromium`.

### Phase 4 — Next.js host (webpack, App Router)

Goal: highest-value, highest-risk host; also closes the runtime-RSC coverage
gap called out in `AGENTS.md`.

- `./next` subpath: `next.config.js` wrapper applying the unplugin webpack
  adapter to client compilations only (skip the server/RSC compilation),
  mounting hub via a route handler (`@devframes/next` pattern), and injecting
  the hook bootstrap as the first client-entry import (documented manual
  `<Script>` fallback).
- RSC: run the transform with `rsc: true` — instrument only modules behind
  the `"use client"` gate; server components appear in coverage as
  non-instrumentable (documented).
- Story generation targets Storybook's Next framework
  (`@storybook/nextjs`) in the generator's `storybookFramework` mapping.
- Add `playground/next` (App Router, mix of server + client components —
  this becomes the missing `rsc: true` runtime playground) and wire it into
  the shared E2E suite; CI-gated.
- Document turbopack as unsupported (unplugin has no turbopack adapter).
- Exit criteria: shared E2E suite green on Next; RSC boundary behavior
  covered by both unit tests and the playground.

Risks: webpack HMR interplay with the registry runtime; React version/dedupe
inside Next; `next dev` default-turbopack drift in future Next majors (must
document `--webpack`-style opt-outs as Next evolves).

## Out of scope

- Turbopack, browser-extension viewers, standalone CLI/dev-server mode.
- MCP/agent exposure of RPC functions.
- Package rename.
- Supporting `@vitejs/devtools` < 0.6 after Phase 1 lands.
