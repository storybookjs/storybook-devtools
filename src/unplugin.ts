/**
 * Portable instrumentation core, built on `unplugin`: the transform pipeline
 * (filter → framework.detect → framework.transform), the virtual modules
 * (runtime helpers, framework runtime, devtools hook), and the entry-injection
 * strategy for delivering the devtools hook without an HTML transform.
 * Bundler-only concerns — reading a file through a running dev server,
 * config/HTML mutation, HMR wiring — are supplied by the caller through
 * {@link ComponentHighlighterUnpluginHost} or layered on afterwards (see
 * `src/create-component-highlighter-plugin.ts`, the Vite adapter).
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { createFilter } from 'unplugin-utils'
import { createUnplugin } from 'unplugin'
import type { UnpluginOptions } from 'unplugin'
import type { FrameworkConfig } from './frameworks'
import type { TransformIssue } from './frameworks/types'
import type { ComponentHighlighterOptions } from './create-component-highlighter-plugin'
import { normalizeRuntimeImports } from './utils/normalize-runtime-imports'
import { STORY_EXCLUDE_GLOBS, STORY_FILE_PATTERN } from './utils/story-files'
import { assertStorybookPeer } from './storybook-peer'

/** Structured diagnostics dispatch, registered by the DevTools kit (see `kitSetup` in the Vite adapter). Not part of unplugin's or devframe's portable context. */
export type ChDiagnostics = {
  CH_TRANSFORM_FAILED: (p: {
    file: string
    detail: string
    sources?: string[]
  }) => unknown
  CH_UNSUPPORTED_PATTERN: (p: {
    name: string
    file: string
    detail: string
    sources?: string[]
  }) => unknown
}

/**
 * Bundler-supplied dependencies the portable core cannot provide itself.
 * The Vite adapter is currently the only implementer.
 */
export interface ComponentHighlighterUnpluginHost {
  /** Whether the dev server is running (Vite: `config.command === 'serve'`). */
  isServe: () => boolean
  /**
   * Read a file's transformed dev-source through a running dev server.
   * Returns `null` to fall back to reading the file straight off disk.
   * Vite-only: backed by `server.transformRequest`. When absent, the
   * built dist files are served instead of dev source, regardless of
   * `isServe()` — a host without a transforming dev server has no way to
   * turn raw TypeScript/JSX source into something the browser can run.
   */
  loadDevSource?: (absPath: string) => Promise<string | null>
  /** Component name → file path, shared with the coverage dashboard. */
  transformedComponents: Map<string, string>
  /** Current diagnostics dispatch, or `null` before the kit registers it. */
  getDiagnostics: () => ChDiagnostics | null
  /**
   * Resolved public base the dev server rewrites module URLs under (Vite:
   * `config.base`, `/_nuxt/` on Nuxt). Used to normalize the runtime-helpers
   * import back to its bare virtual id. Hosts without Vite-style import
   * rewriting omit it; `/` is assumed.
   */
  getBase?: () => string
  /**
   * Called on every watched file change whose path looks like a story file
   * (`*.stories.*` or `*.story.*`), across every bundler unplugin targets —
   * this is the one cross-host wiring point for story-index invalidation
   * (`src/story-index.ts`), so hosts don't each need their own watcher.
   * Wired via unplugin's `watchChange` hook, which fires in dev/watch mode
   * on Vite, Rsbuild/rspack, and Next/webpack alike.
   */
  onStoryFileChange?: (filePath: string, event: 'create' | 'update' | 'delete') => void
}

/** Virtual module whose body is the framework's inline devtools-hook script, for the `entry` hook-injection strategy. */
export const DEVTOOLS_HOOK_VIRTUAL_ID = 'virtual:component-highlighter/devtools-hook'
const RESOLVED_DEVTOOLS_HOOK_VIRTUAL_ID = `\0${DEVTOOLS_HOOK_VIRTUAL_ID}`
const DEVTOOLS_HOOK_IMPORT_STATEMENT = `import '${DEVTOOLS_HOOK_VIRTUAL_ID}'\n`

export interface ComponentHighlighterRuntimePaths {
  packageRoot: string
  runtimeHelperVirtualId: string
  resolvedRuntimeHelperVirtualId: string
  runtimeHelperFilePath: string
  runtimeHelperSourcePath: string
  runtimeModuleSourcePath: string
  runtimeModuleFilePath: string
  resolvedFrameworkVirtualModuleId: string
}

/**
 * Computes the runtime-helper and framework-runtime-module paths for a
 * framework. Shared by the portable core's `resolveId`/`load` and by the
 * Vite adapter's `configureServer` (watcher registration) and
 * `handleHotUpdate` (module-graph invalidation), which have no unplugin
 * equivalent and stay Vite-only.
 */
export function getComponentHighlighterRuntimePaths(
  framework: FrameworkConfig,
): ComponentHighlighterRuntimePaths {
  const runtimeHelperVirtualId = 'virtual:component-highlighter/runtime-helpers'
  const resolvedRuntimeHelperVirtualId = `\0${runtimeHelperVirtualId}`
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )
  const runtimeHelperFilePath = path.join(
    packageRoot,
    'dist',
    'runtime-helpers.mjs',
  )
  const runtimeHelperSourcePath = path.join(
    packageRoot,
    'src',
    'runtime-helpers.ts',
  )
  const runtimeModuleSourcePath = path.join(
    packageRoot,
    'src',
    `${framework.runtimeModuleFile}.ts`,
  )
  const runtimeModuleFilePath = path.join(
    packageRoot,
    'dist',
    `${framework.runtimeModuleFile}.mjs`,
  )
  return {
    packageRoot,
    runtimeHelperVirtualId,
    resolvedRuntimeHelperVirtualId,
    runtimeHelperFilePath,
    runtimeHelperSourcePath,
    runtimeModuleSourcePath,
    runtimeModuleFilePath,
    resolvedFrameworkVirtualModuleId: '\0' + framework.virtualModuleId,
  }
}

function buildComponentHighlighterUnpluginOptions(
  framework: FrameworkConfig,
  options: ComponentHighlighterOptions,
  host: ComponentHighlighterUnpluginHost,
): UnpluginOptions {
  const {
    include = framework.extensions.map((ext) => `**/*${ext}`),
    exclude = [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      ...STORY_EXCLUDE_GLOBS,
    ],
    force = false,
    debugMode = false,
    rsc = false,
    hookInjection = 'html',
    entry,
  } = options

  if (hookInjection === 'entry' && !entry) {
    throw new Error(
      "[component-highlighter] hookInjection: 'entry' requires an `entry` option " +
        '(picomatch pattern(s) matching the app entry module id).',
    )
  }

  const filter = createFilter(include, exclude)
  const entryFilter = entry ? createFilter(entry) : undefined
  // A file re-transforms on every edit; report each distinct diagnostic once.
  const reportedDiagnostics = new Set<string>()

  const paths = getComponentHighlighterRuntimePaths(framework)

  const logDebug = (...args: unknown[]) => {
    if (debugMode) {
      console.log('[component-highlighter]', ...args)
    }
  }

  function runTransform(
    code: string,
    id: string,
    viteOptions?: { ssr?: boolean | undefined },
  ): string | undefined {
    // Only transform in dev/serve mode unless force is enabled.
    if (!host.isServe() && !force) {
      return
    }

    // Never instrument components for SSR builds — the runtime module uses
    // browser-only APIs (CustomEvent, window) and would crash in Node.js.
    if (viteOptions?.ssr) {
      return
    }

    let workingCode = code
    let mutated = false

    if (hookInjection === 'entry' && entryFilter?.(id)) {
      // Vite re-runs `transform` from the on-disk source on every HMR update,
      // so the per-call content check is the only dedupe that cannot go stale
      // — and it also respects an import the author already wrote by hand.
      if (!workingCode.includes(DEVTOOLS_HOOK_VIRTUAL_ID)) {
        // ES import hoisting runs the hook before the module body regardless
        // of where the statement lands.
        workingCode = DEVTOOLS_HOOK_IMPORT_STATEMENT + workingCode
        mutated = true
      }
    }

    // Skip non-matching files.
    if (!filter(id)) {
      return mutated ? workingCode : undefined
    }

    // Check if this framework handles this file.
    if (!framework.detect(workingCode, id)) {
      return mutated ? workingCode : undefined
    }

    logDebug(`Transforming ${id}`)

    const result = framework.transform(workingCode, id, {
      rsc,
      onIssue: (issue: TransformIssue) => {
        const diagnostics = host.getDiagnostics()
        if (!diagnostics) return
        const key = `${issue.code}:${issue.file}:${issue.name ?? ''}`
        if (reportedDiagnostics.has(key)) return
        reportedDiagnostics.add(key)
        const sources = issue.loc ? [issue.loc] : undefined
        if (issue.code === 'transform-failed') {
          diagnostics.CH_TRANSFORM_FAILED({
            file: issue.file,
            detail: issue.detail,
            ...(sources ? { sources } : {}),
          })
        } else {
          diagnostics.CH_UNSUPPORTED_PATTERN({
            name: issue.name ?? 'component',
            file: issue.file,
            detail: issue.detail,
            ...(sources ? { sources } : {}),
          })
        }
      },
    })

    // Track transformed components for coverage.
    if (result) {
      const componentName = path.basename(id, path.extname(id))
      host.transformedComponents.set(componentName, id)
    }

    return result ?? (mutated ? workingCode : undefined)
  }

  return {
    name: '@storybook/experimental-devtools',
    enforce: 'pre',
    resolveId(id: string) {
      // HMR invalidation appends ?t=<timestamp> to re-fetched imports —
      // strip any query before matching our virtual ids.
      const bareId = id.split('?', 1)[0]!
      if (bareId === paths.runtimeHelperVirtualId) {
        return paths.resolvedRuntimeHelperVirtualId
      }
      if (bareId === paths.resolvedRuntimeHelperVirtualId) {
        return paths.resolvedRuntimeHelperVirtualId
      }
      if (bareId === framework.virtualModuleId) {
        return '\0' + bareId
      }
      if (bareId === DEVTOOLS_HOOK_VIRTUAL_ID) {
        return RESOLVED_DEVTOOLS_HOOK_VIRTUAL_ID
      }
      return null
    },
    async load(id: string) {
      if (id === paths.resolvedRuntimeHelperVirtualId) {
        const { loadDevSource } = host
        const shouldUseSource =
          loadDevSource != null &&
          host.isServe() &&
          fs.existsSync(paths.runtimeHelperSourcePath)

        if (shouldUseSource) {
          const devSource = await loadDevSource(paths.runtimeHelperSourcePath)
          if (devSource != null) {
            return devSource
          }
          return fs.readFileSync(paths.runtimeHelperSourcePath, 'utf-8')
        }

        if (!fs.existsSync(paths.runtimeHelperFilePath)) {
          throw new Error(
            '[component-highlighter] runtime helpers not built. Run `pnpm build` first.',
          )
        }
        return fs.readFileSync(paths.runtimeHelperFilePath, 'utf-8')
      }
      if (id === paths.resolvedFrameworkVirtualModuleId) {
        const { loadDevSource } = host
        const shouldUseSource =
          loadDevSource != null &&
          host.isServe() &&
          fs.existsSync(paths.runtimeModuleSourcePath)

        // Replace the loader-injected build constants declared by the runtime
        // modules (`declare const __COMPONENT_HIGHLIGHTER_*__`). The project
        // root lets the Vue runtime derive exact cwd-relative paths at runtime
        // (React gets them from its build-time transform instead).
        const injectBuildConstants = (code: string) =>
          code
            .replace(
              /__COMPONENT_HIGHLIGHTER_DEBUG__/g,
              debugMode ? 'true' : 'false',
            )
            .replace(/__COMPONENT_HIGHLIGHTER_ROOT__/g, () =>
              JSON.stringify(process.cwd().replace(/\\/g, '/')),
            )

        // Vite's import-analysis rewrites the helpers import to its
        // <base>/@id/ form (base is '/_nuxt/' under Nuxt) and, after an HMR
        // invalidation, appends a `?t=<timestamp>` query. Normalize both back
        // to the bare virtual id so resolveId matches when the browser
        // re-imports this module.
        const normalizeImports = (code: string) =>
          normalizeRuntimeImports(code, host.getBase?.() ?? '/')

        if (shouldUseSource) {
          const devSource = await loadDevSource(paths.runtimeModuleSourcePath)
          if (devSource != null) {
            return injectBuildConstants(normalizeImports(devSource))
          }
          return injectBuildConstants(
            normalizeImports(
              fs.readFileSync(paths.runtimeModuleSourcePath, 'utf-8'),
            ),
          )
        }

        if (!fs.existsSync(paths.runtimeModuleFilePath)) {
          throw new Error(
            '[component-highlighter] runtime module not built. Run `pnpm build` first.',
          )
        }

        return injectBuildConstants(
          normalizeImports(
            fs.readFileSync(paths.runtimeModuleFilePath, 'utf-8'),
          ),
        )
      }
      if (id === RESOLVED_DEVTOOLS_HOOK_VIRTUAL_ID) {
        return framework.htmlHeadSnippet?.() ?? ''
      }
      return null
    },
    transform(code: string, id: string) {
      return runTransform(code, id)
    },
    watchChange(id, change) {
      if (!host.onStoryFileChange) return
      const bareId = id.split('?', 1)[0]!
      if (STORY_FILE_PATTERN.test(bareId)) {
        host.onStoryFileChange(bareId, change.event)
      }
    },
    // unplugin's generic `transform` type has no third parameter and cannot
    // see Vite's `{ ssr }` option; this per-bundler override replaces it for
    // the Vite target with the same core logic plus the SSR gate. The
    // parameters stay unannotated so Vite's contextual types flow in.
    vite: {
      transform(code, id, viteOptions) {
        return runTransform(code, id, viteOptions)
      },
    },
  }
}

/**
 * Builds the `unplugin` instance for one framework + options combination.
 * `.vite()` produces the Vite plugin, composed further with Vite-only hooks
 * by `create-component-highlighter-plugin.ts`.
 */
export function createComponentHighlighterUnplugin(
  framework: FrameworkConfig,
  options: ComponentHighlighterOptions,
  host: ComponentHighlighterUnpluginHost,
) {
  // Every host builds its plugin through here at config-load time, so a
  // missing or too-old `storybook` peer is reported once, up front, rather
  // than at the first transform or RPC that needs one of its internals.
  assertStorybookPeer()
  return createUnplugin(() =>
    buildComponentHighlighterUnpluginOptions(framework, options, host),
  )
}
