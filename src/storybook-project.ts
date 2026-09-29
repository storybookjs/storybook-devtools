/**
 * Reads the user's actual Storybook configuration (framework package,
 * renderer, builder, stories globs, addons, project root) instead of
 * hardcoding it. Backed by `storybook/internal/common`: `getStorybookInfo`
 * needs an absolute `configDir` to resolve independently of `process.cwd()`;
 * `getProjectRoot` takes no `cwd` argument at all and always reads
 * `process.cwd()` directly. Both are loaded lazily (dynamic `import()`, or a
 * lazy `require()` where a caller has no async entry point), never at
 * module top level of a host plugin entry.
 */
import { createRequire } from 'module'
import * as path from 'path'
import type { StoriesEntry } from 'storybook/internal/types'

export interface StorybookProjectInfo {
  /** Absolute path to the config directory, e.g. `<project>/.storybook`. */
  configDir: string
  /** Absolute path to the resolved main config file. */
  mainConfigPath: string
  /** Storybook framework package, e.g. `@storybook/react-vite`. */
  frameworkPackage: string | undefined
  /** Storybook renderer, e.g. `react`, `vue3`. */
  renderer: string | undefined
  /** Storybook builder, e.g. `vite`, `webpack5`. */
  builder: string | undefined
  /** Raw `stories` entries from the main config (strings or specifier objects, unnormalised). */
  storiesGlobs: StoriesEntry[]
  /** Addon package names from the main config. */
  addons: string[]
}

const projectCache = new Map<string, Promise<StorybookProjectInfo | null>>()

/** Marks a `loadStorybookProject` failure that isn't a missing config — see `resolveStorybookProject`. */
const TRANSIENT_FAILURE = Symbol('storybook-project-transient-failure')

/**
 * Resolves the user's Storybook project info for `cwd`, memoised per cwd.
 * Returns `null` when no Storybook main config is found — absence of a
 * config is not an error, callers fall back to their own defaults.
 *
 * Only that "no config" case is cached as `null`. Any other failure (a
 * `.storybook/main` that exists but momentarily fails to parse or evaluate,
 * for instance) is not cached — the next call re-reads the config from
 * disk instead of repeating the same failure forever.
 */
export function resolveStorybookProject(
  cwd: string,
  logDebug?: (...args: unknown[]) => void,
): Promise<StorybookProjectInfo | null> {
  const cached = projectCache.get(cwd)
  if (cached) return cached

  const promise: Promise<StorybookProjectInfo | null> = loadStorybookProject(
    cwd,
    logDebug,
  ).then((result) => {
    if (result === TRANSIENT_FAILURE) {
      projectCache.delete(cwd)
      return null
    }
    return result
  })
  projectCache.set(cwd, promise)
  return promise
}

/**
 * Drops the memoised project for `cwd`, so the next `resolveStorybookProject`
 * call re-reads the config from disk instead of serving the old memo. Used
 * when the story-index service rebuilds from scratch — a project that gains
 * a `.storybook` config, or fixes a broken one, is picked up without a
 * process restart.
 */
export function invalidateStorybookProject(cwd: string): void {
  projectCache.delete(cwd)
}

async function loadStorybookProject(
  cwd: string,
  logDebug?: (...args: unknown[]) => void,
): Promise<StorybookProjectInfo | null | typeof TRANSIENT_FAILURE> {
  try {
    // `webpackIgnore` keeps this off Next's server webpack bundle — a
    // string-literal dynamic import is otherwise still statically bundled
    // (not just lazily run), and `storybook/internal/common` transitively
    // pulls in `oxc-resolver`'s native `.node` binding for tsconfig-paths
    // resolution, which webpack can't parse and fails the build.
    const { getStorybookInfo } = await import(
      /* webpackIgnore: true */ 'storybook/internal/common'
    )
    const info = await getStorybookInfo(path.resolve(cwd, '.storybook'), cwd, {
      skipCache: true,
    })
    if (!info.mainConfigPath) return null

    return {
      configDir: info.configDir ?? path.resolve(cwd, '.storybook'),
      mainConfigPath: info.mainConfigPath,
      frameworkPackage: info.frameworkPackage,
      renderer: info.renderer,
      builder: info.builder,
      storiesGlobs: Array.isArray(info.mainConfig?.stories)
        ? info.mainConfig.stories
        : [],
      addons: info.addons ?? [],
    }
  } catch (error) {
    // `webpackIgnore` — see the import above.
    const { MainFileMissingError } = await import(
      /* webpackIgnore: true */ 'storybook/internal/server-errors'
    )
    if (error instanceof MainFileMissingError) {
      // No `main.*` file under the given configDir — the common "not a
      // Storybook project" case here, not a failure worth surfacing.
      return null
    }
    // Any other error (a config that exists but fails to evaluate, for
    // instance) is worth logging but not caching — see `resolveStorybookProject`.
    logDebug?.(
      '[storybook-project] Failed to resolve the Storybook project config for',
      cwd,
      error instanceof Error ? error.message : String(error),
    )
    return TRANSIENT_FAILURE
  }
}

const resolvedRoots = new Map<string, string | undefined>()

/**
 * Resolves the repository root the way Storybook itself does: the
 * `STORYBOOK_PROJECT_ROOT` env override, else the nearest ancestor under
 * version control, else the nearest ancestor with a workspace manifest or
 * lockfile. Memoised per `process.cwd()` since the result can't change
 * within a single run for a given cwd — but a process can still call this
 * from more than one cwd (e.g. Nuxt's client + SSR Vite contexts, each
 * started from their own directory).
 *
 * `getProjectRoot` takes no `cwd` argument — it always resolves against the
 * real `process.cwd()` at call time, not a caller-supplied directory — which
 * is why the memo is keyed on `process.cwd()` rather than on a parameter.
 *
 * Synchronous because its one call site (`createStorybookDevframe`) builds
 * its result synchronously and has no async entry point to await from: a
 * Next.js `route.ts` re-exports its `GET`/`POST`/`DELETE` handlers directly
 * from that call, so it can't become async without breaking that public
 * API. `storybook` ships a CJS build as well as an ESM one, so a lazy
 * `require()` — never at module top level, since the module is large — gives
 * sync access.
 */
export function resolveProjectRootSync(): string | undefined {
  const cwd = process.cwd()
  if (resolvedRoots.has(cwd)) return resolvedRoots.get(cwd)

  let root: string | undefined
  try {
    const require = createRequire(import.meta.url)
    const { getProjectRoot } = require('storybook/internal/common') as {
      getProjectRoot: () => string
    }
    root = getProjectRoot()
  } catch {
    root = undefined
  }
  resolvedRoots.set(cwd, root)
  return root
}
