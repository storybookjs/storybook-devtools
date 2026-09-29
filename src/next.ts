/**
 * Next.js Entry Point
 *
 * `next dev` + webpack host (App Router). Turbopack has no unplugin adapter,
 * so instrumentation is skipped there with a warning — never a crash.
 *
 * Two independently-loaded module instances cooperate here: `withStorybookDevtools`
 * runs inside next.config's module graph (build-time, webpack composition),
 * while `createStorybookDevtoolsRoute` runs inside the compiled route handler
 * (request-time). They share `transformedComponents` and the registered
 * diagnostics dispatch through a `globalThis` singleton — the same reason
 * `@devframes/next` itself memoizes the hub instance there.
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { normalizeHubBase } from '@devframes/hub/constants'
import type { DevframeHubContext } from '@devframes/hub'
import { nextDevframeHub } from '@devframes/next/hub'
import { createTerminalsDevframe } from '@devframes/plugin-terminals'
import {
  createComponentHighlighterUnplugin,
  type ChDiagnostics,
  type ComponentHighlighterUnpluginHost,
} from './unplugin'
import type { ComponentHighlighterOptions } from './create-component-highlighter-plugin'
import { createStorybookDevframe, type StorybookDevframeState } from './devframe'
import { registerStorybookHubSurfaces } from './hub-setup'
import { ConsoleNotificationService } from './notifications'
import { reactFramework } from './frameworks/react'
import { getDevToolsHookScript } from './frameworks/react/devtools-hook'
import type { FrameworkConfig } from './frameworks/types'
import {
  resolveStorybookFramework,
  type CreateStorybookDevframeDeps,
} from './context'
import { createStoryIndexService, type StoryIndexService } from './story-index'

/** Next.js framework config: React instrumentation, `@storybook/nextjs` story output. */
export const nextFramework: FrameworkConfig = {
  ...reactFramework,
  storybookFramework: '@storybook/nextjs',
}

const DEFAULT_BASE = '/__devframes/'
const DEFAULT_STORYBOOK_URL = 'http://localhost:6006'
const DEFAULT_DEVTOOLS_DOCK_ID = 'component-highlighter'

/**
 * Next's App Router client bootstrap in dev (webpack, non-Turbopack). These
 * modules run before any app code, so injecting the devtools hook into any
 * one of them installs it before react-dom registers its renderer.
 * Determined empirically against Next 15's compiled `.next/static` output;
 * matching more than one is harmless — the hook module is only ever
 * evaluated once regardless of how many importers request it.
 */
const DEFAULT_NEXT_CLIENT_ENTRY = [
  // The client chunk's actual first-executed module (per webpack's own
  // `__webpack_exec__` entry list) — Next's Fast Refresh runtime installs
  // its own minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` here (a `renderers`-less
  // stub, just enough for HMR) before `app-next-dev.js` below ever runs. Our
  // hook must win that race — installing after Fast Refresh's stub means
  // react-dom's `inject()` call never reaches ours, so
  // `hook.renderers` (and therefore live prop editing) stays empty even
  // though fiber commits still come through fine via the wrapped
  // `onCommitFiberRoot`.
  '**/@next/react-refresh-utils/dist/runtime.js',
  '**/next/dist/client/app-next-dev.js',
  '**/next/dist/client/app-index.js',
  '**/next/dist/client/next-dev.js',
]

const SERVER_EXTERNAL_PACKAGES = [
  '@storybook/experimental-devtools',
  'devframe',
  '@devframes/next',
  '@devframes/hub',
  '@devframes/hub-ui',
  '@devframes/plugin-terminals',
  // unplugin's own top-level code resolves its webpack loader paths via
  // `import.meta.dirname` — a Node-native ESM field webpack's module
  // wrapper doesn't populate when it bundles (rather than externalizes) the
  // module, which throws before any of this package's own code runs.
  'unplugin',
  'unplugin-utils',
  'webpack-virtual-modules',
]

/**
 * Public path the dock's self-contained client bundle is served from — the
 * same convention `src/rsbuild.ts` uses, so a consuming app can `import()`
 * this URL on either host and the browser's module cache keeps one client
 * instance shared with the embedded dock.
 */
const CLIENT_BUNDLE_PUBLIC_PATH = '/__storybook-devtools-client/vite-devtools.mjs'
/** Rejects path-traversal attempts in a bundle request; a bare filename never needs `/`. */
const SAFE_BASENAME = /^[\w.-]+$/

export interface NextComponentHighlighterOptions {
  /** URL of the Storybook instance. */
  storybookUrl?: string
  /** Glob patterns to include for component instrumentation. */
  include?: string[]
  /** Glob patterns to exclude from component instrumentation. */
  exclude?: string[]
  /** Force instrumentation even outside dev. @default false */
  force?: boolean
  /** Enable verbose debug logging (browser + server console). @default false */
  debugMode?: boolean
  /** Automatically write story files when "Create Story" is clicked. @default true */
  writeStoryFiles?: boolean
  /** Custom directory for story files, relative to the component. */
  storiesDir?: string
  /** Custom devtools dock ID. @default 'component-highlighter' */
  devtoolsDockId?: string
  /**
   * React Server Components mode. The App Router ships Server Components by
   * default, so only modules with a `"use client"` directive are
   * instrumented; server components are left untouched.
   * @default true
   */
  rsc?: boolean
  /**
   * Picomatch pattern(s) matching Next's client bootstrap module id(s) —
   * where the devtools hook import is injected. Next has no HTML-transform
   * hook to lean on (unlike Vite), so hook delivery always goes through
   * entry injection.
   * @default DEFAULT_NEXT_CLIENT_ENTRY
   */
  entry?: string | string[]
  /**
   * Mount the hub-ui embedded floating dock by appending a
   * `<script type="module">` pointing at `<base>embedded.js` alongside the
   * devtools hook.
   * @default true
   */
  mountEmbeddedDock?: boolean
  /**
   * Hub mount base. Must match the `base` the catch-all route is mounted at
   * (`createStorybookDevtoolsRoute`'s `base` option) so the embedded-dock
   * script URL resolves.
   * @default '/__devframes/'
   */
  base?: string
}

interface ResolvedNextComponentHighlighterOptions {
  storybookUrl: string
  include: string[] | undefined
  exclude: string[] | undefined
  force: boolean
  debugMode: boolean
  writeStoryFiles: boolean
  storiesDir: string | undefined
  devtoolsDockId: string
  rsc: boolean
  entry: string | string[]
  mountEmbeddedDock: boolean
  base: string
}

/** Applies `NextComponentHighlighterOptions` defaults. Exported for tests. */
export function resolveNextOptions(
  options: NextComponentHighlighterOptions,
): ResolvedNextComponentHighlighterOptions {
  return {
    storybookUrl: options.storybookUrl ?? DEFAULT_STORYBOOK_URL,
    include: options.include,
    exclude: options.exclude,
    force: options.force ?? false,
    debugMode: options.debugMode ?? false,
    writeStoryFiles: options.writeStoryFiles ?? true,
    storiesDir: options.storiesDir,
    devtoolsDockId: options.devtoolsDockId ?? DEFAULT_DEVTOOLS_DOCK_ID,
    rsc: options.rsc ?? true,
    entry: options.entry ?? DEFAULT_NEXT_CLIENT_ENTRY,
    mountEmbeddedDock: options.mountEmbeddedDock ?? true,
    base: normalizeHubBase(options.base ?? DEFAULT_BASE),
  }
}

// ─── Cross-module-instance shared state ───────────────────────────────────

interface StorybookDevtoolsNextGlobalState {
  resolvedOptions: ResolvedNextComponentHighlighterOptions | null
  state: StorybookDevframeState
  diagnostics: ChDiagnostics | null
  /**
   * Lazily built on first access (see `getStoryIndexService` below) — `null`
   * until then. Kept on the `globalThis` singleton because
   * `withStorybookDevtools` and `createStorybookDevtoolsRoute` are separate
   * module instances within a process: sharing through it means one index
   * per process rather than one per module instance. It does not cross
   * process boundaries — see `PersistedComponentMap` below for state that
   * has to.
   */
  storyIndexService: StoryIndexService | null
}

const GLOBAL_STATE_KEY = '__storybookDevtoolsNextGlobalState__'

/**
 * `transformedComponents` is written by the webpack transform in the compiler
 * process but read by the hub route handler, which Next may run in a separate
 * render-worker process — a `globalThis` singleton doesn't cross that
 * boundary. Persist through a manifest under `.next/cache`: the writer
 * flushes debounced on set, readers re-hydrate when the file changes.
 * Exported for tests.
 */
export class PersistedComponentMap extends Map<string, string> {
  private file: string
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private lastLoadedMtime = 0

  constructor(file: string) {
    super()
    this.file = file
  }

  override set(key: string, value: string): this {
    super.set(key, value)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        try {
          // Merge the persisted entries first: on a warm webpack cache only
          // edited modules re-transform, so the in-memory map is a subset of
          // what the manifest already knows — writing it out unmerged would
          // shrink coverage to just the edited components.
          this.hydrate()
          fs.mkdirSync(path.dirname(this.file), { recursive: true })
          fs.writeFileSync(this.file, JSON.stringify([...super.entries()]))
        } catch {
          // best effort — coverage just stays partial
        }
      }, 250)
      this.flushTimer.unref?.()
    }
    return this
  }

  private hydrate(): void {
    try {
      const stat = fs.statSync(this.file)
      if (stat.mtimeMs <= this.lastLoadedMtime) return
      this.lastLoadedMtime = stat.mtimeMs
      const entries = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as [
        string,
        string,
      ][]
      for (const [k, v] of entries) {
        if (!super.has(k)) super.set(k, v)
      }
    } catch {
      // no manifest yet
    }
  }

  override [Symbol.iterator](): MapIterator<[string, string]> {
    this.hydrate()
    return super[Symbol.iterator]()
  }

  override entries(): MapIterator<[string, string]> {
    this.hydrate()
    return super.entries()
  }

  override get size(): number {
    this.hydrate()
    return super.size
  }
}

function getGlobalState(): StorybookDevtoolsNextGlobalState {
  const g = globalThis as unknown as Record<
    string,
    StorybookDevtoolsNextGlobalState | undefined
  >
  let existing = g[GLOBAL_STATE_KEY]
  if (!existing) {
    existing = {
      resolvedOptions: null,
      state: {
        server: undefined,
        notifications: new ConsoleNotificationService(),
        transformedComponents: new PersistedComponentMap(
          path.join(
            process.cwd(),
            '.next',
            'cache',
            'storybook-devtools',
            'coverage-manifest.json',
          ),
        ),
        devtoolsTerminals: null,
        storybookSession: null,
        devtoolsMessages: null,
        storybookStartFailure: null,
      },
      diagnostics: null,
      storyIndexService: null,
    }
    g[GLOBAL_STATE_KEY] = existing
  }
  return existing
}

/**
 * Lazily builds (once per `globalThis` singleton) the story index service
 * for the Next host, memoised on `StorybookDevtoolsNextGlobalState`. Its
 * logger reads `debugMode` off that same global state at call time, so the
 * service behaves the same whichever module instance builds it first.
 */
function getStoryIndexService(
  globalState: StorybookDevtoolsNextGlobalState,
): StoryIndexService {
  if (!globalState.storyIndexService) {
    globalState.storyIndexService = createStoryIndexService({
      cwd: process.cwd(),
      logDebug: (...args) => {
        if (globalState.resolvedOptions?.debugMode) {
          console.log('[component-highlighter]', ...args)
        }
      },
    })
  }
  return globalState.storyIndexService
}

// ─── Devtools-hook script composition ─────────────────────────────────────

/**
 * Body of the `virtual:component-highlighter/devtools-hook` module for
 * Next: the React DevTools global-hook bootstrap, plus (when enabled) a
 * script that mounts the hub-ui embedded dock — Next serves no HTML the way
 * Vite's `transformIndexHtml` does, so the dock has to be mounted from
 * client JS instead. Uses `document.createElement` + `appendChild`, not a
 * dynamic `import()`, so webpack never tries to resolve `<base>embedded.js`
 * as a module at build time.
 */
export function composeNextHookScript(
  opts: Pick<ResolvedNextComponentHighlighterOptions, 'base' | 'mountEmbeddedDock'>,
): string {
  const reactSnippet = getDevToolsHookScript()
  if (!opts.mountEmbeddedDock) return reactSnippet
  const embeddedSrc = `${opts.base}embedded.js`
  // Mount only after the window has loaded: the dock styles the <html>
  // element (hub-ui's safe-area CSS variables), and doing that while React
  // is still hydrating makes React 19 report a server/client attribute
  // mismatch on the root element.
  return `${reactSnippet}\n(function(){\n  if (window.__storybookDevtoolsEmbeddedDockMounted) return;\n  window.__storybookDevtoolsEmbeddedDockMounted = true;\n  var mount = function() {\n    var s = document.createElement('script');\n    s.type = 'module';\n    s.src = ${JSON.stringify(embeddedSrc)};\n    document.head.appendChild(s);\n  };\n  if (document.readyState === 'complete') setTimeout(mount, 0);\n  else window.addEventListener('load', function(){ setTimeout(mount, 0); });\n})();`
}

/**
 * The devtools-hook script text, for manual delivery when entry injection
 * isn't viable — e.g. `<Script strategy="beforeInteractive">` in the root
 * layout.
 */
export function getNextDevToolsHookScript(
  options: Pick<NextComponentHighlighterOptions, 'base' | 'mountEmbeddedDock'> = {},
): string {
  return composeNextHookScript({
    base: normalizeHubBase(options.base ?? DEFAULT_BASE),
    mountEmbeddedDock: options.mountEmbeddedDock ?? true,
  })
}

// ─── next.config.ts: webpack composition ──────────────────────────────────

interface NextWebpackConfig {
  plugins?: unknown[]
}

interface NextWebpackContext {
  dev: boolean
  isServer: boolean
  nextRuntime?: string
}

type NextWebpackFn = (
  config: NextWebpackConfig,
  context: NextWebpackContext,
) => NextWebpackConfig

export interface NextConfigWebpackShape {
  skipTrailingSlashRedirect?: boolean
  webpack?: NextWebpackFn
  serverExternalPackages?: string[]
}

// ─── webpack5 "virtual:" scheme compatibility ─────────────────────────────

/**
 * webpack5 treats any bare import specifier shaped like a URI
 * (`letter+alnum...:` before the first `/`/`?`/`#`) as having a "scheme",
 * and resolves it through `NormalModuleFactory.hooks.resolveForScheme`
 * instead of the normal enhanced-resolve resolver chain — bypassing the
 * `resolver.hooks.resolve` tap unplugin's webpack adapter installs for its
 * `resolveId` hook entirely. The portable core's virtual module ids all use
 * the Vite/Rollup `virtual:...` convention, so under webpack every one of
 * them (`virtual:component-highlighter/devtools-hook`,
 * `.../runtime`, `.../runtime-helpers`, `.../vue-runtime`) is misread as an
 * unhandled URI scheme and fails with `UnhandledSchemeError` before
 * `resolveId` ever runs.
 *
 * This registers a `resolveForScheme.for('virtual')` handler that relays the
 * request through the SAME `resolveId`/`load` hooks the Vite adapter uses
 * (obtained from the same unplugin instance's `.vite()` output — a plain,
 * bundler-agnostic pair of functions), then writes the result into a real,
 * scheme-less file path via `webpack-virtual-modules` so webpack's normal
 * (unhandled-scheme-free) read path takes over. Content is never
 * reimplemented here — only relayed.
 */
interface WebpackResourceData {
  resource: string
  path?: string
  query?: string
  fragment?: string
  context?: string
}

interface WebpackNormalModuleFactoryLike {
  hooks: {
    resolveForScheme: {
      for: (scheme: string) => {
        tapPromise: (
          name: string,
          fn: (resourceData: WebpackResourceData) => Promise<void>,
        ) => void
      }
    }
  }
}

interface WebpackCompilerLike {
  options: { context?: string }
  hooks: {
    compilation: {
      tap: (
        name: string,
        fn: (
          compilation: unknown,
          args: { normalModuleFactory: WebpackNormalModuleFactoryLike },
        ) => void,
      ) => void
    }
  }
}

interface RawResolveLoadPlugin {
  resolveId?: (
    id: string,
    importer: string | undefined,
    opts: { isEntry: boolean },
  ) => unknown
  load?: (id: string) => unknown
}

const VIRTUAL_SCHEME = 'virtual'
const VIRTUAL_SCHEME_DIR = '_component_highlighter_virtual_'

function createVirtualSchemeWebpackPlugin(rawPlugin: RawResolveLoadPlugin): {
  apply: (compiler: WebpackCompilerLike) => void
} {
  return {
    apply(compiler) {
      const require_ = createRequire(import.meta.url)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const VirtualModulesPluginCtor = require_('webpack-virtual-modules') as new () => {
        writeModule: (filePath: string, contents: string) => void
        apply: (compiler: unknown) => void
      }
      const vfs = new VirtualModulesPluginCtor()
      vfs.apply(compiler)

      compiler.hooks.compilation.tap(
        'component-highlighter-virtual-scheme',
        (_compilation, { normalModuleFactory }) => {
          normalModuleFactory.hooks.resolveForScheme
            .for(VIRTUAL_SCHEME)
            .tapPromise(
              'component-highlighter-virtual-scheme',
              async (resourceData) => {
                if (!rawPlugin.resolveId) return
                const resolved = await rawPlugin.resolveId(
                  resourceData.resource,
                  undefined,
                  { isEntry: false },
                )
                const resolvedId =
                  typeof resolved === 'string'
                    ? resolved
                    : ((resolved as { id?: string } | null)?.id ?? null)
                if (!resolvedId || !rawPlugin.load) return

                const loaded = await rawPlugin.load(resolvedId)
                const code =
                  typeof loaded === 'string'
                    ? loaded
                    : ((loaded as { code?: string } | null)?.code ?? '')

                const virtualPath = path.join(
                  compiler.options.context ?? process.cwd(),
                  VIRTUAL_SCHEME_DIR,
                  `${encodeURIComponent(resolvedId)}.js`,
                )
                vfs.writeModule(virtualPath, code)

                resourceData.path = virtualPath
                resourceData.query = ''
                resourceData.fragment = ''
                resourceData.resource = virtualPath
                resourceData.context = path.dirname(virtualPath)
              },
            )
        },
      )
    },
  }
}

/**
 * `next.config.ts` composer. Dev-only instrumentation: pushes the
 * component-highlighter webpack plugin onto the client compilation only
 * (`context.dev && !context.isServer`) — the runtime module uses
 * browser-only APIs and would crash under Node or the edge runtime.
 *
 * Turbopack has no unplugin adapter; when `next dev` runs under Turbopack
 * (`process.env.TURBOPACK`) this prints one warning and otherwise no-ops —
 * it never crashes the build.
 */
export function withStorybookDevtools(
  options: NextComponentHighlighterOptions = {},
) {
  if (process.env['TURBOPACK']) {
    console.warn(
      '[component-highlighter] Turbopack is not supported — there is no unplugin ' +
        'adapter for it. Run `next dev` without `--turbopack` (Next 15), or pass ' +
        '`--webpack` explicitly on majors where Turbopack is the default (Next 16+). ' +
        'The app runs normally; component instrumentation is just skipped.',
    )
  }

  const resolved = resolveNextOptions(options)
  const globalState = getGlobalState()
  globalState.resolvedOptions = resolved

  const framework: FrameworkConfig = {
    ...nextFramework,
    htmlHeadSnippet: () =>
      composeNextHookScript({
        base: resolved.base,
        mountEmbeddedDock: resolved.mountEmbeddedDock,
      }),
  }

  const storyIndexService = getStoryIndexService(globalState)

  const host: ComponentHighlighterUnpluginHost = {
    isServe: () => true,
    transformedComponents: globalState.state.transformedComponents,
    getDiagnostics: () => globalState.diagnostics,
    onStoryFileChange: (filePath, event) =>
      storyIndexService.invalidate(filePath, { removed: event === 'delete' }),
  }

  const unpluginOptions: ComponentHighlighterOptions = {
    storybookUrl: resolved.storybookUrl,
    ...(resolved.include ? { include: resolved.include } : {}),
    ...(resolved.exclude ? { exclude: resolved.exclude } : {}),
    force: resolved.force,
    debugMode: resolved.debugMode,
    rsc: resolved.rsc,
    hookInjection: 'entry',
    entry: resolved.entry,
  }

  const unplugin = createComponentHighlighterUnplugin(
    framework,
    unpluginOptions,
    host,
  )
  const webpackPlugin = unplugin.webpack()
  // Same resolveId/load hooks the Vite adapter drives, called directly (no
  // Vite instance involved) to relay "virtual:" scheme requests — see
  // createVirtualSchemeWebpackPlugin.
  const virtualSchemePlugin = createVirtualSchemeWebpackPlugin(
    unplugin.vite() as RawResolveLoadPlugin,
  )

  return function configureNextConfig<T extends NextConfigWebpackShape>(
    nextConfig: T = {} as T,
  ): T {
    const userWebpack = nextConfig.webpack

    const composedWebpack: NextWebpackFn = (config, context) => {
      let cfg = userWebpack ? (userWebpack(config, context) ?? config) : config
      if (context.dev && !context.isServer && context.nextRuntime !== 'edge') {
        cfg = {
          ...cfg,
          plugins: [...(cfg.plugins ?? []), webpackPlugin, virtualSchemePlugin],
        }
      }
      return cfg
    }

    const existingExternals = nextConfig.serverExternalPackages ?? []
    const serverExternalPackages = Array.from(
      new Set([...existingExternals, ...SERVER_EXTERNAL_PACKAGES]),
    )

    return {
      ...nextConfig,
      webpack: composedWebpack,
      serverExternalPackages,
      // Next's trailing-slash normalization 308s `<base><id>/` to the
      // slashless URL before the hub route handler runs, breaking the panel
      // SPA's base-relative asset resolution. Skip it unless the app pinned
      // a value; route handlers here accept both forms.
      skipTrailingSlashRedirect: nextConfig.skipTrailingSlashRedirect ?? true,
    } as T
  }
}

// ─── app/__devframes/[[...path]]/route.ts ─────────────────────────────────

export interface CreateStorybookDevtoolsRouteOptions {
  /** Gate the hub behind interactive auth. @default true */
  auth?: boolean
  /** Pin the side-car RPC/WS port (Next routes can't accept WS upgrades). */
  port?: number
  /**
   * Bind host for the side-car server. `'localhost'` (the library default)
   * resolves to whichever of `127.0.0.1`/`::1` the OS prefers, which can
   * mismatch the browser's explicit WebSocket target when the Next dev
   * server itself is bound to a specific address (e.g. `next dev -H
   * 127.0.0.1`) — pin the same address here to avoid a connection refused.
   */
  host?: string
  /** Hub mount base — must match `withStorybookDevtools`'s `base`. */
  base?: string
  /** Public origin the Next app is reachable at. */
  origin?: string
  storybookUrl?: string
  writeStoryFiles?: boolean
  storiesDir?: string
  devtoolsDockId?: string
}

/**
 * Builds the `app/__devframes/[[...path]]/route.ts` handler: a devframes hub
 * mounting the `storybook-devtools` devframe, with RPC/docks/commands/
 * diagnostics wired by the same host-neutral `registerStorybookHubSurfaces`
 * the Vite adapter uses. Reads defaults set by `withStorybookDevtools` (a
 * different module instance) off the `globalThis` singleton; explicit
 * `options` here override them.
 *
 * The dock's `importFrom` points at `CLIENT_BUNDLE_PUBLIC_PATH`, served by
 * `createStorybookDevtoolsClientBundleRoute` at a separate catch-all route —
 * Next's file-system routing can't answer two different top-level path
 * prefixes from one route module.
 */
export function createStorybookDevtoolsRoute(
  options: CreateStorybookDevtoolsRouteOptions = {},
) {
  const globalState = getGlobalState()
  const configured = globalState.resolvedOptions ?? resolveNextOptions({})

  const base = normalizeHubBase(options.base ?? configured.base)
  const storybookUrl = options.storybookUrl ?? configured.storybookUrl
  const writeStoryFiles = options.writeStoryFiles ?? configured.writeStoryFiles
  const storiesDir = options.storiesDir ?? configured.storiesDir
  const devtoolsDockId = options.devtoolsDockId ?? configured.devtoolsDockId
  const debugMode = configured.debugMode

  // Kicked off now, awaited later by the handlers that need it (story
  // generation, the docs URL) — not on this synchronous route-setup path.
  const storyIndexService = getStoryIndexService(globalState)

  const deps: CreateStorybookDevframeDeps = {
    framework: nextFramework,
    storybookUrl,
    writeStoryFiles,
    storiesDir,
    logDebug: (...args) => {
      if (debugMode) console.log('[component-highlighter]', ...args)
    },
    state: globalState.state,
    storybookFramework: resolveStorybookFramework(
      storyIndexService,
      nextFramework,
    ),
    storyIndexService,
  }

  const hub = nextDevframeHub({
    base,
    ...(options.port != null ? { port: options.port } : {}),
    ...(options.host != null ? { host: options.host } : {}),
    ...(options.origin != null ? { origin: options.origin } : {}),
    auth: options.auth ?? true,
    // The aggregate MCP endpoint needs the optional `@modelcontextprotocol/server`
    // peer this package doesn't declare; out of scope for the DevTools panel.
    mcp: false,
    // The Terminals dock is a separate devframe; `@vitejs/devtools` mounts
    // it on the Vite host, so the Next hub mounts it too for the same
    // "Open Terminal" → Storybook session experience.
    devframes: [createStorybookDevframe(deps), createTerminalsDevframe()],
    configure: (ctx: DevframeHubContext) => {
      const { diagnostics } = registerStorybookHubSurfaces(ctx, {
        deps,
        devtoolsDockId,
        dockClientScript: {
          importFrom: CLIENT_BUNDLE_PUBLIC_PATH,
          importName: 'default',
        },
      })
      globalState.diagnostics = diagnostics
    },
  })

  return {
    GET: (req: Request) => hub.handler(req),
    POST: (req: Request) => hub.handler(req),
    DELETE: (req: Request) => hub.handler(req),
  }
}

/**
 * Builds a dedicated catch-all route serving the dock's self-contained
 * client bundle (`dist/client-bundled/*`) at `CLIENT_BUNDLE_PUBLIC_PATH` —
 * mount it at `app/__storybook-devtools-client/[[...path]]/route.ts`. A
 * consuming app's own client bootstrap (or a playground's eager-activation
 * shim) imports this same URL by `import()`, so the browser's module cache
 * keeps one client instance shared with the embedded dock.
 */
export function createStorybookDevtoolsClientBundleRoute() {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )
  const bundleDir = path.join(packageRoot, 'dist', 'client-bundled')

  const GET = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    const basename = pathname.split('/').pop() ?? ''
    const filePath = basename ? path.join(bundleDir, basename) : ''
    const isSafe =
      !!basename &&
      SAFE_BASENAME.test(basename) &&
      !!filePath &&
      filePath.startsWith(bundleDir + path.sep)
    if (!isSafe) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const data = await fs.promises.readFile(filePath)
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response(
        `[component-highlighter] ${basename} not found in dist/client-bundled — run \`pnpm build\` first.`,
        { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
      )
    }
  }

  return { GET }
}
