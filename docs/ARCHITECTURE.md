# Architecture

Reference for contributors and coding agents.

## What this plugin does

`@storybook/experimental-devtools` tracks rendered components in
dev, overlays highlights in the browser, and generates Storybook stories from
runtime props. It supports React, Vue, and Nuxt SSR (via the Vue
integration), on three bundler hosts: Vite (`./react`, `./vue`, `./vite`;
Nuxt rides this), Rsbuild/rspack (`./rsbuild`), and Next.js/webpack
(`./next`, React only).

See `docs/SUPPORTED_FRAMEWORKS.md` for the current framework list.

## Runtime flow

The plugin has seven stages: bundler setup, a build-time transform, a
browser runtime, an overlay + listeners layer, a DevTools panel, server-side
story generation, and server-side story indexing for coverage.

### 1. Plugin setup

`src/unplugin.ts` is the portable instrumentation core, built on `unplugin`.
It owns the transform pipeline (filter → `framework.detect` →
`framework.transform`), coverage tracking, diagnostics dedupe, and virtual
module resolution. Each bundler host (below) wraps it with its own adapter.

`src/hub-setup.ts` registers the hub surfaces shared by all three hosts:
notifications, diagnostics, the terminals reference, the
`component-highlighter` action dock, and the Mod+K commands.

`src/react-dedupe.ts` detects a React-major mismatch between the app and
this plugin's own `react-element-to-jsx-string` dependency, and decides
whether to add `react`/`react-dom` to the bundler's dedupe list.

`src/devframe.ts` defines the `storybook-devtools` devframe: it registers
the RPC surface and shared state, and serves the panel as `clientAssets`.

`src/storybook-project.ts` reads the user's real Storybook config —
framework package, renderer, builder, stories globs, addons — via
`getStorybookInfo` from `storybook/internal/common`, and the repository root
via `getProjectRoot` from the same module. `createStoryIndexService({ cwd,
logDebug })` calls `resolveStorybookProject(cwd)` itself and exposes the
promise as `.project`, so each host (`create-component-highlighter-plugin.ts`,
`rsbuild.ts`, `next.ts`) constructs one object at setup and awaits nothing on
the startup path. It resolves to `null` when no `.storybook/main` config is
found (or `getStorybookInfo` throws for any other reason). The one derived
value handlers need — the framework package for generated stories and the
docs URL — is resolved once per host as `CreateStorybookDevframeDeps.storybookFramework`
(`resolveStorybookFramework` in `src/context.ts`), which falls back to the
framework's static `storybookFramework` default (e.g. `@storybook/react-vite`).
`getProjectRoot` has no `cwd` parameter of its own (always resolves against
the real `process.cwd()`); `resolveProjectRootSync` wraps it behind a lazy
`require()` and exists only for `createStorybookDevframe`'s repository-root
lookup, which has to run synchronously because a Next.js `route.ts`
re-exports `GET`/`POST`/`DELETE` directly from
`createStorybookDevtoolsRoute()`'s return value.

Hub resources and Storybook process state are scoped to each RPC context.
Nuxt installs the same definition in client and SSR hubs; sharing their
terminal reference starts a PTY in the other hub, where the visible
Terminals dock cannot find or stop it. Context state inherits shared
transform state, while hub setup assigns its own terminals, notifications,
messages, and docks.

### 2. Framework transform

`src/frameworks/<fw>/transform.ts` runs at build time. Neither transform
wraps components.

- **React**: a Babel AST transform (Babel re-exported from
  `storybook/internal/babel`, not a direct dependency) that appends one
  idempotent call,
  `__chRegisterMeta(Component, { componentName, filePath,
  relativeFilePath, sourceId, isDefaultExport })`. The fiber tree is
  untouched.
- **Vue**: prepends one side-effect import,
  `import 'virtual:component-highlighter/vue-runtime'`, to the
  `<script setup>`/`<script>` block. Everything else is preserved
  byte-for-byte. Source identity is read at runtime from Vue's own
  `instance.type.__file`/`__name`.

Both report non-fatal detection gaps through `TransformOptions.onIssue`,
surfaced as DevTools diagnostics.

### 3. Browser runtime

`src/frameworks/<fw>/runtime-module.ts` and `src/runtime-helpers.ts` run in
the browser. The devtools hook script must reach the page before the
framework's renderer registers, via one of two `hookInjection` modes:
`'html'` (default, Vite only — `transformIndexHtml` head-prepends it) or
`'entry'` (prepended to the app's entry module, matched by the `entry`
option).

- **React**: `src/frameworks/react/devtools-hook.ts` installs a minimal
  `__REACT_DEVTOOLS_GLOBAL_HOOK__` before react-dom registers. The runtime
  module subscribes via `window.__chInstallCommitHandler` and walks the
  live fiber tree on every commit, reading the `__chRegisterMeta` tag off
  `fiber.type`/`elementType`.
- **Vue**: `src/frameworks/vue/devtools-hook.ts` installs a minimal
  `__VUE_DEVTOOLS_GLOBAL_HOOK__` before `createApp` runs. The runtime
  module subscribes via `window.__chInstallVueHandler` to Vue's
  `component:added`/`updated`/`removed` events, keyed per instance in a
  `WeakMap`. The hook must expose `cleanupBuffer()` (returning `false`), or
  `@vue/runtime-core` never emits `component:removed`.
- **Nuxt SSR**: `src/frameworks/nuxt/plugin.ts` reuses the Vue Vite plugin,
  exposing `getNuxtDevToolsHookScript()` for `nuxt.config.ts` to inject
  before hydration, plus a `viteDevToolsBridgeModule` Nuxt module that
  makes the DevTools HTTP surface reachable through Nuxt's dev server.

The runtime registers instances in a `Map` on `window`, tracks props and DOM
anchors, and emits `component-highlighter:register`/`unregister`/
`update-props` events. Because the listeners module can load after the
first commit, the runtime replays its full registry when
`component-highlighter:listeners-ready` fires.

### 4. Overlay + listeners

`src/client/overlay.ts`, `src/client/listeners.ts`, and
`src/client/context-menu.ts` run in the browser page, connecting to the
host-published client context via `getHostClientContext()` — separate from
the panel, which connects as its own devframe SPA. `listeners.ts` dispatches
`component-highlighter:listeners-ready` once attached, triggering the
runtime replay above. It renders highlight rectangles in
`#component-highlighter-container`, handles hover/click/keyboard shortcuts,
and drives the Shadow DOM context menu. `src/client/interaction-recorder.ts`
captures user actions as play-function steps for "Create with Interactions".

### 5. DevTools panel

`src/panel/panel.ts` is served as the devframe's `clientAssets` SPA at
`/__storybook-devtools/`. Four tabs: Storybook (embedded iframe), Coverage
(dashboard, bulk "Create all"), Terminal (process output), Docs. Story
navigation uses the Storybook channel API
(`__STORYBOOK_ADDONS_CHANNEL__.emit('setCurrentStory')`).

### 6. Story generation (server)

`src/frameworks/<fw>/story-generator.ts` receives a payload over RPC,
generates framework-specific story source (React `.stories.tsx`, Vue
`.stories.ts`), writes or appends the file, and broadcasts
`component-highlighter:story-created` back to the client.

The work splits in two. **Serialisation** — live props to story source —
stays hand-rolled in `src/utils/story-generator.ts` (`generateArgsContent`,
`formatPropValue`, JSX/Vue-slot handling, `toValidStoryName`); Storybook has
no equivalent, since its own `save-story` flow re-serialises args that were
already typed rather than arbitrary runtime values. **File mutation** —
appending the rendered export to a file that already exists — runs through
`src/utils/csf-writer.ts` on the CSF AST:
`loadCsf().parse()`, dedupe the export name against `_storyExports` plus
every other top-level binding, merge the needed imports onto the AST
(extending a matching `ImportDeclaration` where there is one), push the
story's statements (parsed with `babelParse` from
`storybook/internal/babel`) onto `program.body`, and `printCsf()`.
Import merging matches exported symbols, reuses aliases, promotes type-only
bindings when a value is needed, and allocates free names for collisions.
Only references in the appended snippet are rewritten.
Recast reuses each untouched node's original source, so comments, quote
style and formatting elsewhere in the file survive byte-identically.

Generators are `async` because `storybook/internal/csf-tools` is imported
lazily — same `webpackIgnore` reasoning as `src/story-index.ts`.

Concurrent saves to the same output file are queued around the complete
read/generate/format/write operation, preventing lost exports.

Each generator computes the story's required imports
(`collectRequiredImports`) and the rendered `export const … : Story = {…}`
block (`renderStoryExport`) once, then either hands both to
`writeStoryIntoCsf` (the file exists) or prints them into the new-file
template (it doesn't) — the two paths share one definition of both.

**Fallback rule.** `writeStoryIntoCsf` returns `{ code, exportName,
fallbackReason? }`. When `loadCsf` throws — a story file with
no default export, or one that does not parse — the writer falls back to a
regex splice rather than failing story creation, and reports why via
`fallbackReason`, which the generator passes back on `GeneratedStory` and
`create-story.ts` logs through `logDebug`.

Before writing, `create-story.ts` runs the content through
`formatStoryFile`, a wrapper over `formatFileContent` from
`storybook/internal/common`. That applies the user project's prettier when it
has one and returns the content untouched when prettier or a
prettier/editorconfig config is missing.

### 7. Story index and coverage (server)

`src/story-index.ts` serves the index everything server-side matches
against. `createStoryIndexService({ cwd, logDebug })` returns `{ cwd,
project, getIndex(), invalidate(filePath?, { removed? }) }` and picks between two
strategies behind that one `getIndex()`:

1. a real Storybook index built from the user's `stories` globs
   (`storybook/internal/core-server`'s `StoryIndexGenerator`, fed by an
   equivalent of Storybook's own unexported CSF indexer), built lazily on
   the first `getIndex()` call and memoised;
2. a scan for story files under `cwd`, synthesised into entries carrying
   only `id`, `type` and `importPath`, used when there is no generator to
   build (no Storybook config, or a build that threw). A synthesised
   `componentPath` is deliberately absent: it would decide membership
   outright in `findStoryCandidates`, so a same-named file beside the story
   could hide a real match, while `importPath` alone matches by path base
   and by file name.

The build result is memoised, a missing generator included, so a broken or
absent Storybook project costs one build attempt rather than one per
`getIndex()` call; `invalidate()` (with no `filePath`, or when the last build
produced no generator) drops that memo and re-resolves the Storybook project
(`storybook-project.ts`'s `invalidateStorybookProject` plus a fresh
`resolveStorybookProject` call), which is how a project that gains a
`.storybook` config (or fixes its config) picks up the real index.
`getIndex()` always resolves to an index, so callers carry no "no index"
branch.

On each index request, the service uses Storybook's
`findMatchingFilesForSpecifiers` and file timestamps to detect additions,
edits, and deletions. It invalidates only changed entries; concurrent
requests share one refresh. This also works in Next's route process and
for stories outside webpack/rspack's app dependency graph. The static
Storybook glob cache is cleared before each scan. No timer or additional
watcher needs disposal. The fallback scan follows source-directory symlinks
with realpath cycle detection (required by React 18's shared `src`).

`storybook-project.ts`'s `resolveStorybookProject(cwd, logDebug)` only caches
a `null` result when Storybook itself reports no main config found
(`MainFileMissingError` from `storybook/internal/server-errors`); any other
failure (a `.storybook/main` that momentarily fails to parse or evaluate) is
logged but not cached, so the next call re-reads the config from disk instead
of repeating the same failure forever. `resolveProjectRootSync` (used for the
`@devframes/service-open` extra root, not the story index) memoises per
`process.cwd()` rather than once per process, since a process can call it
from more than one cwd.

Consumers match through `findStoryCandidates`
(`src/utils/story-matching.ts`) on `componentPath`/`importPath`/title rather
than a naming convention of their own: `collectCoverage` in
`src/coverage-dashboard.ts` (used by the `get-coverage` RPC and
`hub-setup.ts`'s "Write Stories for Missing Components" command) and the
`check-story` RPC behind the overlay's create/open affordance. The panel's
`storybook-index` RPC is not one of them: it navigates by story id, which
only Storybook's own `index.json` can supply. The one definition of "this
file is a story file" lives in `src/utils/story-files.ts` and is shared with
`src/unplugin.ts`'s instrumentation `exclude` globs and `watchChange`
filter.

`StoryIndexGenerator.getIndex()` throws a `MultipleIndexingError` covering
every file that failed to parse, not a partial index with those entries
dropped, so one bad CSF file takes down the whole generated index for that
cycle. The service then serves the last successful index, which may be
stale, and logs the failure once per
distinct message rather than once per watch event. A fixed file recovers on
the next invalidate+getIndex cycle.

**Invalidation.** `create-story.ts` explicitly invalidates after a write;
`unplugin.ts` forwards story watch events when the bundler supplies them.
Request-time file checks provide correctness when those events are absent.
A full `invalidate()` discards the generator and reloads config through
`getStorybookInfo(..., { skipCache: true })`, bypassing Storybook's own cache
as well as ours. Config changes still require full invalidation or a host
restart. Each host constructs one `storyIndexService` instance at setup (`src/context.ts`
carries it on the devframe deps). On Vite, that construction happens in
`configResolved`, not in the plugin factory: the factory runs before Vite
resolves `root`, so building the service there would anchor `.storybook`
lookup and every importPath-relative path to `process.cwd()` instead of the
app root — wrong for a monorepo with `root` set, or for Nuxt's own Vite
context. `create-component-highlighter-plugin.ts` exposes
`storyIndexService`/`storybookFramework` on `CreateStorybookDevframeDeps` as
getters over module-scoped variables assigned in `configResolved`, so the
devframe/RPC setup that runs after it (and reads `deps` by reference) sees
the resolved-root service. Next's is memoised on the `globalThis`
singleton that also carries `state`, which shares it between
`withStorybookDevtools` and `createStorybookDevtoolsRoute` as separate
module instances — but only within one process. Next may run the webpack
compiler and the route handler in separate processes, and a `globalThis`
singleton does not cross that boundary: `watchChange` then invalidates the
compiler process's instance while the route handler serves coverage from its
own, so on Next only `create-story`'s explicit `invalidate(outputPath)` —
which runs in the route-handler process — is reliable.

**Note on Next/webpack.** `storybook/internal/csf-tools` (and, transitively,
`storybook/internal/common`) pull in `oxc-resolver`'s native `.node` binding
for tsconfig-paths resolution. A string-literal dynamic `import()` is still
*statically bundled* by webpack even though it only *runs* lazily, so
without care Next's server build fails trying to parse that binary as a
module. `src/story-index.ts`, `src/storybook-project.ts`,
`src/storybook-launch.ts` and `src/utils/csf-writer.ts` mark every such
import with a `/* webpackIgnore: true */` magic comment — inert on
Vite/Rollup, which don't recognize it — so webpack leaves them as real
runtime `import()`s instead of bundling them. `csf-writer.ts` loads
`storybook/internal/babel` the same way, and for a second reason: the AST it
assembles is printed by csf-tools' recast, which only reprints nodes it
recognises as unchanged, so a Babel copy bundled by webpack mixed with the
natively loaded csf-tools makes every append fall back to the text splice.

**Peer dependency loading.** `storybook` is a required peer. Node-side
code reaches `storybook/internal/*` through `src/storybook-peer.ts`
(`loadStorybookInternal`, a memoised `createRequire` load behind a version
check against the `peerDependencies` floor) or through a lazy `import()`,
never through a static import in a host entry: ES module linking resolves
every static import before any body runs, so a missing or too-old
`storybook` would otherwise surface as a bare resolution error naming an
internal subpath. `createComponentHighlighterUnplugin` calls
`assertStorybookPeer()` so every host reports the requirement once at
config load. Modules shared with the browser bundles
(`src/utils/story-matching.ts`) keep a static import of the browser-safe
`storybook/internal/csf/csf-utils` chunk, which `createRequire` cannot
replace there.

## Bundler hosts

| Host | Entry file | Instrumentation mount | Hook delivery | Dock/panel serving |
|------|-----------|------------------------|---------------|---------------------|
| Vite | `src/create-component-highlighter-plugin.ts` | `unplugin.vite()`, plus Vite-only hooks (`config`, `configResolved`, `configureServer`, `transformIndexHtml`, `handleHotUpdate`) | `'html'` via `transformIndexHtml`, or `'entry'` | devframe mounted through Vite's own dev server; dock client resolved via Vite's `/@id/{specifier}` |
| Rsbuild | `src/rsbuild.ts` (`storybookDevtoolsRsbuild`) | `unplugin.rspack()` in `modifyRspackConfig` | Devtools-hook script and dock bootstrap injected via `modifyHTMLTags` | `@devframes/hub` mounted on the dev server's Connect middlewares in `onBeforeStartDevServer`, over a sidecar WebSocket; dock client bundle served from `dist/client-bundled/` at `/__storybook-devtools-client/vite-devtools.mjs` |
| Next.js | `src/next.ts` (`withStorybookDevtools`) | `unplugin.webpack()` in `next.config.ts`'s `webpack()`, restricted to the dev client compilation | `'entry'` only, targeting Next's client bootstrap modules | Two route handlers a consuming app mounts: `createStorybookDevtoolsRoute()` (hub over a sidecar WebSocket) and `createStorybookDevtoolsClientBundleRoute()` (same client-bundle URL convention as Rsbuild); both exposed via `next.config.ts` `rewrites()` since App Router treats leading-underscore paths as private |

Notes:

- Rsbuild has no equivalent of Vite's `server.transformRequest`, so its
  runtime-helpers and framework virtual modules always read from built
  `dist/` — run `pnpm build` before using it.
- Next has no unplugin adapter for Turbopack: `withStorybookDevtools` warns
  and no-ops under `process.env.TURBOPACK` instead of crashing.
- Next's RSC gate (see Invariants) defaults to `true`; it targets
  `@storybook/nextjs` only.

## Server RPC surface

There is no HTTP middleware. Every server routine is a `devframe` RPC
function, one file per function under `src/rpc/functions/`, collected by
`src/rpc/index.ts` into `serverFunctions`. Functions declare bare names; the
`component-highlighter` scope namespaces them on the wire (e.g. `create-story`
→ `component-highlighter:create-story`).

| RPC function | Type | Purpose |
|---------------|------|---------|
| `get-config` | query | Panel bootstrap: `{ storybookUrl, cwd }` |
| `storybook-status` | query | Whether the Storybook dev server is responding; carries `startFailure` if the last start died |
| `storybook-index` | query | Proxy of Storybook's `index.json`; returns an empty index when Storybook isn't reachable, since the panel navigates by story id and only Storybook's own index supplies those |
| `start-storybook` | action | Start Storybook as an interactive PTY session via `ctx.terminals` |
| `check-story` | query | Whether a story file exists for a given component path |
| `create-story` | action | Generate and write a story file; broadcasts `story-created` |
| `get-coverage` | query | Compute and return coverage data from the story index (see Story index and coverage above) |
| `push-registry-diff` | action | Client syncs registry changes to shared state |
| `scroll-to-component` | action | Panel asks the client to scroll to a component instance (by `id`, else first by name) and pulse it |
| `toggle-highlight-visibility` | action | Panel shows/hides the selected component's persistent highlight; hover and select keep working |
| `highlight-coverage-instances` | action | Panel asks the client to show/clear coverage highlights |
| `highlight-coverage-batch` | action | Panel asks the client to batch-highlight coverage instances |
| `set-highlight-mode` | action | Toggle highlight mode on the client |
| `set-prop` | action | Panel live-edits a prop on the client |
| `reset-prop` | action | Panel resets a prop to its original value |
| `select-component` | action | Client/overlay selects a component in the panel |
| `visit-story` | action | Tell the panel to navigate to a story |
| `notify` | action | Show a toast notification via DevTools logs |
| `highlight-target` | action | Debug-log the current highlight target |
| `toggle-overlay` | action | Debug-log an overlay toggle |

`start-storybook` spawns Storybook as an interactive PTY session
(`storybook-dev`) in devframe's Terminals dock, so prompts like a
port-conflict question can be answered. That dock is a separate devframe,
`@devframes/plugin-terminals`: `@vitejs/devtools` mounts it on the Vite
host, and `src/next.ts` / `src/rsbuild.ts` mount it on their hubs so every
host has the same dock. `storybook-status` reports
`terminalDockAvailable` from the hub's registered docks, and the panel's
"Open Terminal" buttons and the failure toast's action are omitted when it
is false (a custom hub without the dock). The launch command is built by
`storybook-launch.ts`, which detects the project's package manager via
`storybook/internal/common`'s `JsPackageManagerFactory` and falls back to
`npx` when detection fails. The child inherits the host dev server's env
with `STORYBOOK=true` set and `PORT` pinned to Storybook's port: Storybook's
CLI lets `PORT` override `-p`, and Next's dev server exports its own port
under that name, so an inherited value would bind Storybook to the app's
port while the panel polls `storybookUrl` forever. The panel's "Open Terminal" buttons
and the failure toast deep-link to it via `hub:docks:activate`. A dead
session stays registered for its scrollback; the next start respawns it.

Open-in-editor goes through the `@devframes/service-open` wire service,
registered on every host as `devframes:service:open:open-in-editor`. The
panel and overlay feature-detect it and fall back to Vite's
`/__open-in-editor` endpoint when unavailable.

## Key modules (where to edit)

| Module | Responsibility |
|--------|---------------|
| `src/unplugin.ts` | Portable instrumentation core: transform pipeline, coverage tracking, diagnostics, virtual-module resolution |
| `src/create-component-highlighter-plugin.ts` | Vite adapter and devframe mount |
| `src/rsbuild.ts` | Rsbuild/rspack adapter |
| `src/next.ts` | Next.js/webpack adapter and route-handler factories |
| `src/hub-setup.ts` | Host-neutral hub surfaces: docks, commands, terminals, diagnostics |
| `src/react-dedupe.ts` | React-major-mismatch detection driving `resolve.dedupe` |
| `src/vite.ts` | `./vite` entry: resolves the framework config and delegates to the Vite adapter |
| `src/devframe.ts` | The `storybook-devtools` devframe definition |
| `src/storybook-project.ts` | Reads the user's real Storybook framework/renderer/builder/stories/addons and repository root from their `.storybook/main` config, via `storybook/internal/common` |
| `src/storybook-process.ts` | Storybook process lifecycle: session slot, start-failure tracking, terminal/session id constants |
| `src/rpc/functions/` | One file per RPC function |
| `src/rpc/index.ts` | `serverFunctions` barrel and RPC/shared-state type augmentation |
| `src/context.ts` | Maps a devframe context to the deps it was created with |
| `src/devframe-export.ts` | `./devframe` entry for mounting the definition in a custom DevTools host |
| `src/frameworks/<fw>/transform.ts` | Build-time tagging (React metadata call; Vue runtime import) |
| `src/frameworks/react/devtools-hook.ts` | Inline script installing the React DevTools global hook |
| `src/frameworks/vue/devtools-hook.ts` | Inline script installing the Vue DevTools global hook |
| `src/frameworks/nuxt/plugin.ts` | Nuxt entry: SSR head-script helpers and the dev-server bridge module |
| `src/frameworks/<fw>/runtime-module.ts` | Runtime instance registration and prop serialization |
| `src/frameworks/<fw>/story-generator.ts` | Framework-specific story code output |
| `src/runtime-helpers.ts` | Shared runtime tracking: DOM anchoring, serialization coalescer, live prop-edit machinery |
| `src/client/listeners.ts` | Event wiring, highlight mode state, keyboard shortcuts |
| `src/client/overlay.ts` | Highlight rendering, story file cache, save actions |
| `src/client/context-menu.ts` | Context menu UI (Shadow DOM) |
| `src/client/highlight-machine.ts` | Highlight/selection state machine |
| `src/client/highlight-label.ts` | Highlight label rendering |
| `src/client/interaction-recorder.ts` | User interaction recording for play functions |
| `src/client/coverage-actions.ts` | Client-side coverage actions (scroll, highlight) triggered by the panel |
| `src/client/vite-devtools.ts` | DevTools dock lifecycle, client RPC handler registration |
| `src/client/logger.ts` | Debug logging (`window.__componentHighlighterDebug`) |
| `src/client/utils/host-context.ts` | Resolves the app-page client context across embedded/standalone hosts |
| `src/client/utils/format-utils.ts` | Value formatting for the context menu |
| `src/client/utils/html-preview.ts` | HTML preview rendering for prop values |
| `src/client/utils/prop-utils.ts` | Prop classification, editability, badge utilities |
| `src/client/utils/prop-editor.ts` | Shared inline prop editor form builder |
| `src/panel/panel.ts` | DevTools panel tabs |
| `src/utils/story-matching.ts` | Story-to-component matching against Storybook's `index.json`, and visit-target selection |
| `src/utils/instance-selection.ts` | Props fingerprinting and picking one live instance per variant for story creation, preferring an instance with live edits || `src/utils/story-generator.ts` | Shared story generation utilities (naming, args formatting) |
| `src/utils/csf-writer.ts` | CSF-AST append/dedupe/import-merge for existing story files, with a regex-splice fallback, plus prettier formatting |
| `src/utils/normalize-runtime-imports.ts` | Normalizes runtime import specifiers across hosts |
| `src/utils/storybook-docs-url.ts` | Resolves the Storybook docs URL for the "Open Docs" command |
| `src/codegen/interactions-to-code.ts` | Converts recorded interactions to play-function code |
| `src/codegen/generate-query.ts` | Generates Testing Library queries from recorded targets |
| `src/codegen/args-to-string.ts` | Serializes args objects to source strings |
| `src/codegen/combine-interactions.ts` | Combines/deduplicates sequential interaction steps |
| `src/codegen/get-interaction-event.ts` | Maps DOM events to interaction event types |
| `src/coverage-dashboard.ts` | Server-side coverage computation: `hasStory` from story index entries |
| `src/story-index.ts` | Builds/serves the story index (real Storybook index, else synthesised from a story-file scan), with invalidation |
| `src/utils/story-files.ts` | The one definition of "this file is a story file": exclude globs, watch filter, indexer test, scan names |
| `src/notifications.ts` | Notification abstraction (DevTools Logs API + console fallback) |
| `src/shared-types.ts` | Shared server/client types |

## Window globals (automation / testing hooks)

| Global | Purpose |
|--------|---------|
| `__componentHighlighterRegistry` | Live component instance `Map` |
| `__componentHighlighterEnable()` | Enable highlight mode (bypass dock) |
| `__componentHighlighterDisable()` | Disable highlight mode |
| `__componentHighlighterIsActive()` | Check if highlight mode is on |
| `__componentHighlighterDeactivateDock()` | Programmatically toggle the dock off |
| `__componentHighlighterSelectById(id)` | Select a component instance by registry ID |
| `__componentHighlighterGetRegistry()` | Return the live name→filePath registry Map |
| `__componentHighlighterDebug` | Set `true` for verbose debug logging |
| `__componentHighlighterActivateTracking()` | Turn on prop serialization (called automatically when a DevTools client connects) |
| `__componentHighlighterCanEditProps()` | True when live prop editing is available |
| `__componentHighlighterSetProp(id, path, {kind,text})` | Live-edit a prop; returns `{ok, error?}` |
| `__componentHighlighterResetProp(id, path)` | Revert a previously-edited prop; returns `{ok, error?}` |
| `__componentHighlighterGetEditedProps(id)` | Top-level prop keys currently edited, for the reset affordance |

## Panel-client communication (RPC-based)

The panel is a standalone HTML app that can pop out into its own window.
Panel-to-client communication is a server relay: panel calls a server RPC
function, the server broadcasts, a client-registered handler acts on the DOM.

| Server RPC (panel calls) | Client broadcast handler | Purpose |
|--------------------------|-------------------------|---------|
| `push-registry-diff` | — (client pushes to server) | Client syncs registry changes to shared state |
| `scroll-to-component` | `do-scroll-to-component` | Scroll the app page to a component instance and pulse it |
| `toggle-highlight-visibility` | `do-toggle-highlight-visibility` | Show/hide the selected component's persistent highlight |
| `highlight-coverage-instances` | `do-highlight-coverage` | Show/clear coverage highlights |
| `highlight-coverage-batch` | `do-highlight-coverage-batch` | Batch-highlight coverage instances (Preview button) |
| `set-highlight-mode` | `do-set-highlight-mode` | Toggle highlight mode |
| `set-prop` | `do-set-prop` | Panel live-edits a prop via `__componentHighlighterSetProp` |
| `reset-prop` | `do-reset-prop` | Panel resets a prop via `__componentHighlighterResetProp` |
| `select-component` | `do-select-component` | Client/overlay selects a component in the panel |
| `visit-story` | `do-visit-story` | Tell the panel to navigate to a story |
| `notify` | — (server-side only) | Show a toast notification |
| — (create-story handler) | `story-created` | Server broadcasts the story creation result; client relays it to `visit-story` when Storybook is running |
| — (command handler) | `do-open-url` | Open a URL in a new tab (e.g. Storybook docs) |
| — (command handler) | `do-open-panel-tab` | Switch the dock to the Storybook panel entry |
| — (command handler) | `do-switch-tab` | Switch to a specific panel tab |

## Shared state (auto-synced between server and clients)

| Key | Type | Purpose |
|-----|------|---------|
| `registry` | `SerializedRegistryInstance[]` | Component instances synced from client to panel |
| `pending-visit` | `{ relativeFilePath, preferredStoryName } \| null` | Story navigation request, consumed by the panel |
| `pending-tab` | `string \| null` | Tab switch request, consumed by the panel |
| `highlight-active` | `boolean` | Whether highlight mode is on |
| `highlights-visible` | `boolean` | Whether the selected component's persistent highlight is shown; the client owns it, the panel mirrors it for the Show/Hide highlights label |
| `selected-component` | `SerializedRegistryInstance \| null` | Currently selected component |
| `highlighter-tab-active` | `boolean` | Whether the panel's highlighter tab is active; drives whether client clicks open the panel or the context menu |

## DevTools commands (Mod+K palette)

| Command ID | Title | Shortcut | Description |
|------------|-------|----------|-------------|
| `storybook:toggle-highlight-mode` | Toggle Component Highlighter | `Mod+Shift+H` | Start/stop inspecting components |
| `storybook:create-missing-stories` | Write Stories for Missing Components | — | Generate stories for all visible uncovered components |
| `storybook:see-coverage` | See Component Coverage | — | Open the coverage dashboard |
| `storybook:open-docs` | Open Storybook Docs | — | Open the Storybook documentation site |

## Keyboard shortcuts

| Key | Action | Context |
|-----|--------|---------|
| `Mod+K` | Open command palette | Any time DevTools is active |
| `Mod+Shift+H` | Toggle highlight mode | Any time DevTools is active |
| `Alt` (press) | Toggle click-through mode | While highlight mode is on |
| `Escape` | Clear selection | While a component is selected |
| `Escape` x2 | Exit highlight mode | While highlight mode is on |

## Invariants

1. **Cross-framework parity.** User-visible behavior stays aligned across
   supported frameworks unless intentionally documented otherwise.

2. **Stable metadata pathing.** Story save actions depend on correct
   component path/name metadata. Regressions here surface as unknown paths
   or wrong story targets.

3. **CI-safe automation path.** E2E must not require manual Vite DevTools
   authorization. Activation hooks/config must stay deterministic.

4. **Shared e2e reuse first.** Common behavior belongs in shared e2e
   helpers/suites. Framework-specific specs cover true deltas only.

5. **Lazy prop serialization.** Components register cheaply (id/meta/element)
   at all times; prop serialization is gated by `isTrackingActive()` and
   only turns on once a DevTools RPC client connects. Per-render updates are
   coalesced to one serialization per animation frame. Always route
   serialization through `scheduleSerialization`, never call `serializeProps`
   directly on the hot path.

6. **Only `serializedProps` crosses RPC.** Raw live props hold unclonable
   values (functions, DOM nodes, circular structures). Every server/panel
   consumer reads `serializedProps`, never raw props. The serializer reduces
   non-story-safe values to a marker (`__isJSX`, `__isFunction`, `__isDate`,
   `__isObject`) so the wire payload is always structured-clone-safe.

7. **React detection is non-intrusive.** No HOC/boundary wrapper. Detection
   runs off the React DevTools fiber tree; the build-time transform only
   appends the `__chRegisterMeta` tag.

8. **RSC gate is opt-in.** The `rsc` option is off by default — every
   component is treated as a client component. When `rsc: true`, the
   transform tags only modules with a leading `"use client"` directive,
   leaving server-component modules untouched so the client runtime never
   enters the server graph. Owned by
   `src/frameworks/react/transform.ts` (`hasUseClientDirective`), covered by
   the "RSC mode" unit tests.

9. **Hook script loads before module scripts.** The inline DevTools hook
   must be injected into `<head>` before any module script, so it exists
   before react-dom (or Vue) registers its renderer.

10. **React 18 and 19 fiber-field constraints.** Both versions are required
    and both are E2E-gated (`playground/react` + `playground/react18`). The
    runtime must not depend on `_debugSource` (removed in 19) or
    React-internal tag-number constants — only the typeof-guarded reconciler
    hook contract and fiber fields stable since React 16. Source identity
    comes from the `__chRegisterMeta` tag, not React internals.

11. **React dedupe only on a detected mismatch.** `dedupeReact` (default
    `'auto'`) adds `react`/`react-dom` to the bundler's dedupe list only when
    `resolveReactDedupe` detects a React-major mismatch between the app and
    this plugin's own `react-element-to-jsx-string` dependency. Single-
    version React 19 apps get no config mutation. `false` opts out but logs
    a warning on a detected mismatch.

12. **Fiber walk is synchronous on commit.** React batches a render pass
    into one commit, so the walk runs once per render pass, not per
    `setState`. This keeps register/update event ordering deterministic for
    the overlay/panel state machine. Do not move it to
    `requestAnimationFrame` (throttled in background tabs) or a microtask
    (reorders events relative to the commit).

13. **Multi-renderer `overrideProps` capture.** More than one renderer can
    register on the devtools hook — for example Next's App Router registers
    a react-dom instance without `overrideProps` alongside the real client
    renderer, plus the RSC flight renderer. `handleCommit`
    (`runtime-module.ts`) re-checks each commit's renderer until one exposes
    `overrideProps`, rather than latching onto whichever renderer committed
    first.

14. **Shadow DOM context menu.** Rendered inside Shadow DOM to isolate
    styles. Key interactive elements have stable IDs for E2E:
    `#open-component-btn`, `#story-name-input`, `#save-story-btn`,
    `#save-story-with-interactions-btn`.

## Tests that protect this architecture

Baseline commands:

```bash
pnpm build
pnpm test --run
pnpm typecheck
pnpm exec playwright test
pnpm exec playwright test --config=playwright.storybook.config.ts
```

Focused e2e entrypoints:

```bash
# Framework-specific detection
pnpm exec playwright test e2e/playground-react-detection.spec.ts     # React 19
pnpm exec playwright test e2e/playground-react18-detection.spec.ts    # React 18 + serialization fidelity
pnpm exec playwright test e2e/playground-vue-detection.spec.ts
pnpm exec playwright test e2e/playground-nuxt-detection.spec.ts       # Nuxt SSR

# Rsbuild host detection (React 19, playground/react/src via symlink) + shared suites
pnpm exec playwright test e2e/playground-rsbuild-detection.spec.ts   # port 5177 — run `pnpm build` first

# Next.js host detection (React 19, App Router, RSC boundary) + shared suites
pnpm exec playwright test e2e/playground-next-detection.spec.ts      # port 5178

# Highlighter interaction tests (context menu, story creation)
pnpm exec playwright test e2e/component-highlighter.spec.ts

# Common highlighter features (runs for both frameworks)
pnpm exec playwright test e2e/common-highlighter-suite.ts

# Listeners-ready registry replay (late-loading listeners recovery, all playgrounds)
pnpm exec playwright test -g "listeners-ready registry replay"
```

The playgrounds import `client/listeners` eagerly for deterministic E2E
activation; real consuming apps don't, so their listeners module loads late
(via the async DevTools client) and misses the initial register events.
`e2e/common-listeners-replay-suite.ts` covers the recovery path: it clears
the client registry, re-dispatches `component-highlighter:listeners-ready`,
and asserts the runtime replays the full registry with working highlighting.

## Known caveats

- **Intermittent E2E flake**: `e2e/common-highlight-panel-state-suite.ts` →
  "panel close then dock activate clears stale selection and shows context
  menu" can intermittently show the context menu when it expects it
  suppressed. It is a race between `PANEL_HIGHLIGHTER_ACTIVATE` propagation
  and `SELECT_COMPONENT` in the highlight state machine.
- **RSC**: server components never run the devtools hook, so they are
  invisible to detection. This is by design.
- **Detection scope**: only exported, statically-named, PascalCase
  components are tagged, since only exported components can have stories.

## Maintenance rule

When you change any of the following, update this file in the same PR:

- module responsibilities
- story creation flow
- server RPC surface
- runtime registration model
- context menu structure or IDs
- panel tabs or features
- keyboard shortcuts
- window globals
- test architecture assumptions
- framework parity expectations
