import type { Plugin } from 'vite'
import type { FrameworkConfig } from './frameworks'
import { createPluginFromDevframe } from '@vitejs/devtools-kit/node'
import type { KitNodeContext } from '@vitejs/devtools-kit'
import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { ConsoleNotificationService } from './notifications'
import { resolveReactDedupe } from './react-dedupe'
import { createStorybookDevframe } from './devframe'
import {
  resolveStorybookFramework,
  type CreateStorybookDevframeDeps,
  type StorybookDevframeState,
} from './context'
import { createStoryIndexService, type StoryIndexService } from './story-index'
import {
  createComponentHighlighterUnplugin,
  getComponentHighlighterRuntimePaths,
  type ChDiagnostics,
  type ComponentHighlighterUnpluginHost,
} from './unplugin'
import { registerStorybookHubSurfaces } from './hub-setup'

import type { SerializedRegistryInstance, RegistryDiff } from './shared-types'
export type { SerializedRegistryInstance, RegistryDiff }

export interface ComponentHighlighterOptions {
  /** URL of the Storybook instance */
  storybookUrl?: string
  /**
   * Glob patterns to include for component instrumentation
   * @default ["**\/*.{tsx,jsx}"] for React, varies by framework
   */
  include?: string[]
  /**
   * Glob patterns to exclude from component instrumentation
   * @default ["**\/node_modules/**", "**\/dist/**", "**\/*.d.ts"]
   */
  exclude?: string[]
  /**
   * Event name for the "create story" event
   * @default 'component-highlighter:create-story'
   */
  eventName?: string
  /**
   * Whether to enable the overlay in development
   * @default true
   */
  enableOverlay?: boolean
  /**
   * Custom devtools dock ID
   * @default 'component-highlighter'
   */
  devtoolsDockId?: string
  /**
   * Force instrumentation even in production builds
   * @default false
   */
  force?: boolean
  /**
   * Enable verbose debug logging (browser console)
   * @default false
   */
  debugMode?: boolean
  /**
   * Automatically write story files when "Create Story" is clicked
   * @default true
   */
  writeStoryFiles?: boolean
  /**
   * Custom directory for story files (relative to component)
   * If not set, stories are created next to the component
   */
  storiesDir?: string
  /**
   * Whether to add `react`/`react-dom` to Vite's `resolve.dedupe`.
   *
   * The plugin's bundled `react-element-to-jsx-string` resolves *its own*
   * React (this plugin's copy), which can differ from your app's. When they
   * differ (e.g. your app is on React 18 but the plugin's copy is 19), the
   * library's internal `React.isValidElement` rejects your elements and prop
   * serialization silently degrades to a "Failed to serialize" placeholder.
   * Deduping forces a single React instance and fixes it.
   *
   * - `'auto'` (default): apply the dedupe **only** when a React major
   *   mismatch is detected. Single-version apps (the common React 19 case)
   *   get no config mutation at all.
   * - `true`: always apply.
   * - `false`: never apply. Use this only if you intentionally run multiple
   *   React copies (module federation / micro-frontends). If a mismatch is
   *   detected while disabled, a warning is logged (it never fails silently).
   *
   * @default 'auto'
   */
  dedupeReact?: boolean | 'auto'
  /**
   * React Server Components mode (React only).
   *
   * When `true`, only modules declaring a `"use client"` directive are
   * instrumented. Server components (no directive) are left untouched — they
   * never mount a client fiber, so tagging is useless and would pull the
   * client runtime into the server module graph. Use this for RSC frameworks
   * such as TanStack Start.
   *
   * When `false` (default), every matching module is instrumented — correct
   * for a plain SPA, where there is no `"use client"` directive but every
   * component runs on the client.
   *
   * @default false
   */
  rsc?: boolean
  /**
   * How the runtime devtools-hook script is delivered to the browser.
   *
   * - `'html'` (default): prepend an inline `<script>` to the served HTML
   *   via Vite's `transformIndexHtml`.
   * - `'entry'`: inject a side-effect import of the hook into the app's
   *   entry module(s) (matched by the `entry` option) instead, so it runs
   *   before the app bundle without an HTML transform.
   *
   * @default 'html'
   */
  hookInjection?: 'html' | 'entry'
  /**
   * Picomatch pattern(s) identifying the app's entry module id(s). Required
   * when `hookInjection` is `'entry'`.
   */
  entry?: string | string[]
}

/**
 * Create the component highlighter plugin for a specific framework. Returns
 * an array — Vite flattens plugin arrays — of the transform plugin and the
 * devframe mount plugin.
 */
export function createComponentHighlighterPlugin(
  framework: FrameworkConfig,
  options: ComponentHighlighterOptions = {},
): Plugin[] {
  const logDebug = (...args: unknown[]) => {
    if (options.debugMode) {
      console.log('[component-highlighter]', ...args)
    }
  }

  const runtimePaths = getComponentHighlighterRuntimePaths(framework)

  // The plugin factory runs before Vite resolves `root` (a monorepo with
  // `root` set, or a Nuxt-driven Vite context, means `process.cwd()` is not
  // the app root). Built in `configResolved` below, once `config.root` is
  // known, instead of here — `.storybook` lookup, the scan fallback, and
  // every importPath-relative path the service produces depend on it.
  let storyIndexService: StoryIndexService | undefined
  let storybookFrameworkPromise: Promise<string> | undefined

  const {
    devtoolsDockId = 'component-highlighter',
    storybookUrl = 'http://localhost:6006',
    force = false,
    writeStoryFiles = true,
    storiesDir,
    dedupeReact = 'auto',
    hookInjection = 'html',
  } = options

  let isServe = false
  let resolvedBase = '/'
  // Vite's standard CSP integration: when the app sets `html.cspNonce`, Vite
  // stamps its injected tags with this nonce. We mirror it onto the inline
  // DevTools-hook <script> so it survives a strict Content-Security-Policy.
  let cspNonce: string | undefined
  // Structured diagnostics (DevTools `ctx.diagnostics`), wired in `kitSetup`.
  // Handles surface non-fatal instrumentation issues — parse failures and
  // unsupported authoring patterns — to the DevTools UI.
  let chDiagnostics: ChDiagnostics | null = null

  // Shared mutable state for the transform hooks, the RPC handlers
  // (`src/rpc/functions/`), and `kitSetup` below. Fields unknown until
  // `kitSetup` runs are filled in there; handlers read them lazily at call time.
  const state: StorybookDevframeState = {
    server: undefined,
    notifications: new ConsoleNotificationService(),
    transformedComponents: new Map<string, string>(),
    devtoolsTerminals: null,
    storybookSession: null,
    devtoolsMessages: null,
    storybookStartFailure: null,
  }

  const host: ComponentHighlighterUnpluginHost = {
    isServe: () => isServe,
    loadDevSource: async (absPath) => {
      if (!state.server) return null
      const transformed = await state.server.transformRequest(absPath)
      return transformed?.code ?? null
    },
    transformedComponents: state.transformedComponents,
    getDiagnostics: () => chDiagnostics,
    getBase: () => resolvedBase,
    onStoryFileChange: (filePath, event) =>
      storyIndexService?.invalidate(filePath, {
        removed: event === 'delete',
      }),
  }

  // The unplugin-produced Vite plugin carries the portable hooks: transform
  // (with the Vite-specific `{ ssr }` gate composed in via unplugin's `vite`
  // extension field), resolveId, and load. Extended below with the
  // Vite-only hooks unplugin has no equivalent for.
  const unpluginVitePlugin = createComponentHighlighterUnplugin(
    framework,
    options,
    host,
  ).vite() as Plugin

  const transformPlugin: Plugin = {
    ...unpluginVitePlugin,
    configResolved(config) {
      isServe = config.command === 'serve'
      resolvedBase = config.base || '/'
      cspNonce = (config as { html?: { cspNonce?: string } }).html?.cspNonce
      storyIndexService = createStoryIndexService({
        cwd: path.resolve(config.root),
        logDebug,
      })
      storybookFrameworkPromise = resolveStorybookFramework(
        storyIndexService,
        framework,
      )
    },
    config: (viteConfig) => {
      viteConfig.optimizeDeps ??= {}
      // Exclude our client modules from dep optimization – they are ESM and
      // don't need pre-bundling. Including them causes unnecessary dep
      // re-optimization on first load.
      viteConfig.optimizeDeps.exclude ??= []
      viteConfig.optimizeDeps.exclude.push(
        '@storybook/experimental-devtools/client/vite-devtools',
        '@storybook/experimental-devtools/client/listeners',
        '@storybook/experimental-devtools/client/overlay',
      )

      // @testing-library/dom and aria-query are CJS-only packages. Pre-bundle
      // them so Vite handles the CJS→ESM conversion and named imports work.
      // Use the `@storybook/experimental-devtools > @testing-library/dom`
      // form so Vite resolves these deps from THIS plugin's node_modules. With
      // pnpm's isolated store the packages are not hoisted into the consumer's
      // node_modules, so a bare `@testing-library/dom` specifier fails to resolve.
      viteConfig.optimizeDeps.include ??= []
      viteConfig.optimizeDeps.include.push(
        '@storybook/experimental-devtools > @testing-library/dom',
        '@storybook/experimental-devtools > @testing-library/dom > aria-query',
      )

      // The client modules above are excluded from optimization, so Vite never
      // crawls them at startup and never discovers their third-party imports.
      // Without this, those deps are found lazily when DevTools connects,
      // triggering a mid-session re-optimization + full page reload in every
      // consuming app. Pre-declare them so they are bundled at server startup.
      viteConfig.optimizeDeps.include.push(
        'xstate',
        'nanoevents',
        '@medv/finder',
        'dom-accessibility-api',
      )

      if (framework.name === 'react') {
        // react-element-to-jsx-string and its dependency react-is are CJS-only
        // packages that live in this plugin's node_modules, not the consumer's.
        // We use resolve.alias to redirect the imports to our copies so Vite's
        // dep optimizer can find them. optimizeDeps.include triggers pre-bundling
        // (CJS→ESM conversion) so named imports work in the browser.
        // IMPORTANT: alias must be used instead of a resolveId hook here — aliases
        // are applied before the dep optimization lookup, so Vite pre-bundles the
        // result. A resolveId hook returning an absolute path bypasses the cache
        // and serves the raw CJS file, which breaks named ESM imports.
        const _require = createRequire(import.meta.url)
        viteConfig.resolve ??= {}
        // alias can be an array or a plain object; normalise to a mutable array
        type AliasEntry = { find: string | RegExp; replacement: string }
        const existingAliases: AliasEntry[] = Array.isArray(viteConfig.resolve.alias)
          ? [...viteConfig.resolve.alias]
          : Object.entries(viteConfig.resolve.alias ?? {}).map(
              ([find, replacement]) => ({ find, replacement }),
            )
        viteConfig.resolve.alias = [
          ...existingAliases,
          {
            find: 'react-element-to-jsx-string/dist/esm/index.js',
            replacement: _require.resolve(
              'react-element-to-jsx-string/dist/esm/index.js',
            ),
          },
          {
            find: 'react-is',
            replacement: _require.resolve('react-is'),
          },
        ]
        viteConfig.optimizeDeps.include.push(
          'react-element-to-jsx-string/dist/esm/index.js',
          'react-is',
        )

        // react-element-to-jsx-string is resolved from THIS plugin's
        // node_modules (it is not the consumer's dependency). Its own
        // `import React from 'react'` therefore binds the plugin's pinned
        // React copy. If that differs from the app's React (e.g. the app is
        // on React 18 but the plugin's copy is 19), the library's internal
        // `React.isValidElement` rejects the app's elements and prop
        // serialization silently degrades to `{/* Failed to serialize */}`.
        // Adding react/react-dom to resolve.dedupe forces a single React
        // instance across the client graph (app + runtime + serializer).
        //
        // This is only *needed* when the majors mismatch. By default
        // (`dedupeReact: 'auto'`) we detect that and apply the dedupe only
        // then — so a single-version app (the common React 19 case today)
        // gets no config mutation at all.
        const appRoot =
          (viteConfig.root && path.resolve(viteConfig.root)) || process.cwd()
        const { shouldDedupe } = resolveReactDedupe({
          appRoot,
          dedupeReact,
          logDebug,
        })
        if (shouldDedupe) {
          viteConfig.resolve.dedupe ??= []
          for (const dep of ['react', 'react-dom']) {
            if (!viteConfig.resolve.dedupe.includes(dep)) {
              viteConfig.resolve.dedupe.push(dep)
            }
          }
        }
      }
    },
    configureServer(srv) {
      state.server = srv

      if (fs.existsSync(runtimePaths.runtimeHelperSourcePath)) {
        srv.watcher.add(runtimePaths.runtimeHelperSourcePath)
      }
      if (fs.existsSync(runtimePaths.runtimeModuleSourcePath)) {
        srv.watcher.add(runtimePaths.runtimeModuleSourcePath)
      }
    },
    transformIndexHtml() {
      // The 'entry' hook-injection strategy delivers the devtools hook via
      // a module import instead — injecting it here too would run it twice.
      if (hookInjection === 'entry') return
      if (!isServe && !force) return
      const snippet = framework.htmlHeadSnippet?.()
      if (!snippet) return
      return [
        {
          tag: 'script',
          attrs: {
            type: 'text/javascript',
            ...(cspNonce ? { nonce: cspNonce } : {}),
          },
          children: snippet,
          injectTo: 'head-prepend',
        },
      ]
    },
    handleHotUpdate(ctx) {
      if (ctx.file === runtimePaths.runtimeHelperSourcePath) {
        const mod = ctx.server.moduleGraph.getModuleById(
          runtimePaths.resolvedRuntimeHelperVirtualId,
        )
        return mod ? [mod] : []
      }
      if (ctx.file === runtimePaths.runtimeModuleSourcePath) {
        const mod = ctx.server.moduleGraph.getModuleById(
          runtimePaths.resolvedFrameworkVirtualModuleId,
        )
        return mod ? [mod] : []
      }
      return
    },
  }

  // Constructed before configResolved; these getters are first read during
  // devframe setup, after the resolved Vite root initializes both services.
  const deps: CreateStorybookDevframeDeps = {
    framework,
    storybookUrl,
    writeStoryFiles,
    storiesDir,
    logDebug,
    state,
    get storybookFramework() {
      return (
        storybookFrameworkPromise ??
        Promise.resolve(framework.storybookFramework)
      )
    },
    get storyIndexService() {
      if (!storyIndexService) {
        throw new Error(
          '[component-highlighter] storyIndexService accessed before configResolved ran',
        )
      }
      return storyIndexService
    },
  }

  const definition = createStorybookDevframe(deps)

  // Kit-only setup: docks, commands, terminals, messages, diagnostics — none
  // of these are part of the portable `DevframeNodeContext`, so they're wired
  // here (against the kit-augmented `KitNodeContext`) rather than in the
  // devframe's own `setup(ctx)`. Runs after the devframe-level setup above.
  const kitSetup = (ctx: KitNodeContext) => {
    // The kit advertises Vite's `/@id/{specifier}` client-module-resolution
    // template only when it creates the devtools hub, after every plugin's
    // devtools setup — too late for the registration-time check on a
    // bare-specifier action dock (DF8111). Pre-seed the same value; the hub
    // later overwrite-assigns it identically.
    if (ctx.viteServer) {
      ctx.staticConfig.dock ??= { clientModuleResolution: '/@id/{specifier}' }
    }

    // A `KitNodeContext` is a `DevframeHubContext` (from `@devframes/hub`)
    // with `viteConfig`/`viteServer`/`createJsonRenderer` added — everything
    // below this point works against that shared, bundler-neutral shape.
    const { diagnostics } = registerStorybookHubSurfaces(ctx, {
      deps,
      devtoolsDockId,
      dockClientScript: {
        importFrom:
          '@storybook/experimental-devtools/client/vite-devtools',
        importName: 'default',
      },
    })
    chDiagnostics = diagnostics
  }

  return [
    transformPlugin,
    createPluginFromDevframe(definition, { setup: kitSetup }),
  ]
}
