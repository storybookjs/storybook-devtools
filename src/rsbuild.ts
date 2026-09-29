/**
 * Rsbuild Entry Point
 *
 * Rsbuild adapter: rspack instrumentation via the `unplugin` core
 * (`createComponentHighlighterUnplugin`) plus the devtools hub
 * (`@devframes/hub`) mounted on the dev server, riding its sidecar
 * WebSocket. The devtools-hook script and the hub's embedded-dock bootstrap
 * are delivered as HTML head tags; the highlighter dock's self-contained
 * client bundle is served by URL from a dedicated dev-server middleware.
 */
import type { IncomingMessage, ServerResponse } from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import type { RsbuildPlugin, RsbuildPluginAPI } from '@rsbuild/core'
import { initHub, DEVFRAMES_HUB_BASE } from '@devframes/hub/initiate'
import { createUi } from '@devframes/hub-ui'
import type { ComponentHighlighterOptions } from './create-component-highlighter-plugin'
import { reactFramework } from './frameworks/react'
import { vueFramework } from './frameworks/vue'
import {
  createComponentHighlighterUnplugin,
  type ChDiagnostics,
  type ComponentHighlighterUnpluginHost,
} from './unplugin'
import {
  createStorybookDevframe,
  type StorybookDevframeState,
} from './devframe'
import { registerStorybookHubSurfaces } from './hub-setup'
import { ConsoleNotificationService } from './notifications'
import { resolveReactDedupe } from './react-dedupe'
import {
  resolveStorybookFramework,
  type CreateStorybookDevframeDeps,
} from './context'
import { createStoryIndexService } from './story-index'
import { createTerminalsDevframe } from '@devframes/plugin-terminals'

export interface StorybookDevtoolsRsbuildOptions
  extends ComponentHighlighterOptions {
  framework: 'react' | 'vue'
  /**
   * Gate browser clients behind devframe's interactive OTP auth. `false`
   * trusts every localhost connection (single-user dev / E2E).
   * @default true
   */
  clientAuth?: boolean
}

/** Public path the dock client bundle is served from — see the dev-server middleware below. */
const CLIENT_BUNDLE_PUBLIC_PATH = '/__storybook-devtools-client/vite-devtools.mjs'
const CLIENT_BUNDLE_ROUTE_PREFIX = '/__storybook-devtools-client/'
/** Rejects path-traversal attempts in a bundle request; a bare filename never needs `/`. */
const SAFE_BASENAME = /^[\w.-]+$/

/**
 * Connect middleware serving the self-contained dock client bundle
 * (`dist/client-bundled/*`) by URL — the delivery mechanism for hosts, like
 * Rsbuild, with no bare-specifier module-graph resolution a browser client
 * script import could ride on.
 */
function createClientBundleMiddleware(packageRoot: string) {
  const bundleDir = path.resolve(packageRoot, 'dist', 'client-bundled')
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    const url = req.url ?? ''
    if (!url.startsWith(CLIENT_BUNDLE_ROUTE_PREFIX)) {
      next()
      return
    }
    const basename = url.slice(CLIENT_BUNDLE_ROUTE_PREFIX.length).split('?')[0]
    const filePath = basename && path.join(bundleDir, basename)
    const isSafe =
      !!basename &&
      SAFE_BASENAME.test(basename) &&
      !!filePath &&
      (filePath === bundleDir || filePath.startsWith(bundleDir + path.sep))
    if (!isSafe) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(
          `[component-highlighter] ${basename} not found in dist/client-bundled — run \`pnpm build\` first.`,
        )
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(data)
    })
  }
}

/**
 * Component Highlighter Rsbuild Plugin
 *
 * @example
 * ```ts
 * // rsbuild.config.ts
 * import { defineConfig } from '@rsbuild/core'
 * import { pluginReact } from '@rsbuild/plugin-react'
 * import { storybookDevtoolsRsbuild } from '@storybook/experimental-devtools/rsbuild'
 *
 * export default defineConfig({
 *   plugins: [
 *     pluginReact(),
 *     storybookDevtoolsRsbuild({ framework: 'react' }),
 *   ],
 * })
 * ```
 */
export function storybookDevtoolsRsbuild(
  options: StorybookDevtoolsRsbuildOptions,
): RsbuildPlugin {
  const { framework: frameworkName, clientAuth = true, ...pluginOptions } =
    options
  const framework = frameworkName === 'vue' ? vueFramework : reactFramework

  const logDebug = (...args: unknown[]) => {
    if (pluginOptions.debugMode) {
      console.log('[component-highlighter]', ...args)
    }
  }

  const {
    devtoolsDockId = 'component-highlighter',
    storybookUrl = 'http://localhost:6006',
    force = false,
    writeStoryFiles = true,
    storiesDir,
    dedupeReact = 'auto',
    hookInjection = 'html',
  } = pluginOptions

  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )

  let isServe = false
  // Structured diagnostics (DevTools `ctx.diagnostics`), wired in the hub's
  // `configure` callback below.
  let chDiagnostics: ChDiagnostics | null = null

  // State shared between the unplugin instrumentation, the devframe's RPC
  // handlers (`./devframe.ts`), and `registerStorybookHubSurfaces` below.
  const state: StorybookDevframeState = {
    server: undefined,
    notifications: new ConsoleNotificationService(),
    transformedComponents: new Map<string, string>(),
    devtoolsTerminals: null,
    storybookSession: null,
    devtoolsMessages: null,
    storybookStartFailure: null,
  }

  return {
    name: 'rsbuild-plugin-storybook-devtools',
    setup(api: RsbuildPluginAPI) {
      // Kicked off now, awaited later by the handlers that need it (story
      // generation, the docs URL) — not on this setup path.
      const storyIndexService = createStoryIndexService({
        cwd: api.context.rootPath,
        logDebug,
      })

      // No `loadDevSource`: the rspack host has no equivalent of Vite's
      // `server.transformRequest` — the built dist runtime files are always
      // served instead of dev source.
      const host: ComponentHighlighterUnpluginHost = {
        isServe: () => isServe,
        transformedComponents: state.transformedComponents,
        getDiagnostics: () => chDiagnostics,
        onStoryFileChange: (filePath, event) =>
          storyIndexService.invalidate(filePath, {
            removed: event === 'delete',
          }),
      }

      const unplugin = createComponentHighlighterUnplugin(
        framework,
        pluginOptions,
        host,
      )

      const deps: CreateStorybookDevframeDeps = {
        framework,
        storybookUrl,
        writeStoryFiles,
        storiesDir,
        logDebug,
        state,
        storybookFramework: resolveStorybookFramework(
          storyIndexService,
          framework,
        ),
        storyIndexService,
      }

      api.modifyRspackConfig((config, utils) => {
        isServe = utils.isDev
        config.plugins ??= []
        config.plugins.push(unplugin.rspack())
      })

      api.modifyHTMLTags(({ headTags, bodyTags }) => {
        // The 'entry' hook-injection strategy delivers the devtools hook via
        // a module import instead (handled by the unplugin core) — injecting
        // it here too would run it twice.
        if (hookInjection === 'html' && (isServe || force)) {
          const snippet = framework.htmlHeadSnippet?.()
          if (snippet) {
            // Rsbuild's entry scripts are deferred; an inline head script is
            // not, so this runs before react-dom/createApp regardless of
            // where it lands relative to the other head tags.
            headTags.unshift({
              tag: 'script',
              attrs: { type: 'text/javascript' },
              children: snippet,
            })
          }
        }

        if (isServe) {
          headTags.push({
            tag: 'script',
            attrs: {
              type: 'module',
              src: `${DEVFRAMES_HUB_BASE}embedded.js`,
            },
          })
        }

        return { headTags, bodyTags }
      })

      api.onBeforeStartDevServer(async ({ server }) => {
        const definition = createStorybookDevframe(deps)

        const hub = initHub({
          base: DEVFRAMES_HUB_BASE,
          // Same Terminals dock `@vitejs/devtools` mounts on the Vite host, so
          // "Open Terminal" reaches the Storybook session here as well.
          devframes: [definition, createTerminalsDevframe()],
          ui: createUi(),
          ws: { sidecar: true },
          // Node's 'localhost' can bind IPv6-only ([::1]) while browsers on a
          // 127.0.0.1 page dial the sidecar over IPv4 — pin the v4 loopback
          // (same reason the nuxt playground pins vite.server.host).
          host: '127.0.0.1',
          cwd: api.context.rootPath,
          auth: clientAuth,
          configure(ctx) {
            const { diagnostics } = registerStorybookHubSurfaces(ctx, {
              deps,
              devtoolsDockId,
              dockClientScript: {
                importFrom: CLIENT_BUNDLE_PUBLIC_PATH,
                importName: 'default',
              },
            })
            chDiagnostics = diagnostics
          },
        })

        server.middlewares.use(hub.nodeMiddleware)
        server.middlewares.use(createClientBundleMiddleware(packageRoot))

        // The sidecar WebSocket binds asynchronously — surface bind failures
        // here instead of serving connection meta for a port nothing owns.
        await hub.ready

        // A function returned from this hook is a POST-SETUP callback that
        // Rsbuild invokes right after applying middlewares — not a disposer.
        // Shutdown belongs to onCloseDevServer.
        api.onCloseDevServer(async () => {
          await hub.close()
        })
      })

      if (framework.name === 'react') {
        api.modifyRsbuildConfig((config) => {
          config.resolve ??= {}

          // react-element-to-jsx-string and its dependency react-is are
          // CJS-only packages that live in this plugin's node_modules, not
          // the consumer's — redirect the imports to this package's copies
          // so rspack can resolve them. rspack consumes CJS natively, so no
          // optimizeDeps-equivalent pre-bundling step is needed (unlike the
          // Vite adapter).
          const currentAlias = config.resolve.alias
          if (
            typeof currentAlias !== 'function' &&
            !Array.isArray(currentAlias)
          ) {
            const _require = createRequire(import.meta.url)
            config.resolve.alias = {
              ...currentAlias,
              'react-element-to-jsx-string/dist/esm/index.js': _require.resolve(
                'react-element-to-jsx-string/dist/esm/index.js',
              ),
              'react-is': _require.resolve('react-is'),
            }
          }
          // A function or array alias form is the consumer's own resolution
          // chain — augmenting it safely isn't possible here, so leave it
          // untouched rather than risk breaking it.

          const { shouldDedupe } = resolveReactDedupe({
            appRoot: api.context.rootPath,
            dedupeReact,
            logDebug,
          })
          if (shouldDedupe) {
            config.resolve.dedupe = Array.from(
              new Set([...(config.resolve.dedupe ?? []), 'react', 'react-dom']),
            )
          }
        })
      }
    },
  }
}

export default storybookDevtoolsRsbuild
