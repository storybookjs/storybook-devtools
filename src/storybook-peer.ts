/**
 * Guarded access to the `storybook` peer dependency. Everything this plugin
 * borrows from `storybook/internal/*` goes through here (or through a lazy
 * `import()` in the async code paths), never through a static import in a
 * host plugin entry: ES module linking resolves every static import before
 * any module body runs, so a missing or too-old `storybook` would surface as
 * a bare module-resolution error naming an internal subpath instead of the
 * peer requirement. Loading is synchronous (`createRequire`) because the
 * bundler transform hooks that need Babel have no async entry point; Node's
 * `require()` loads Storybook's ESM `dist` builds directly.
 *
 * Node-only: `createRequire` has no browser equivalent, so modules shared
 * with the panel and overlay bundles (`src/utils/story-matching.ts`) keep a
 * static import of the browser-safe `storybook/internal/csf/csf-utils`
 * chunk instead; that subpath exists in every supported Storybook major, so
 * the version floor is enforced here for the Node-side internals.
 */
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

interface OwnPackageJson {
  name: string
  peerDependencies?: Record<string, string>
}

/** Parses the `>=x.y.z` floor of this package's `storybook` peer range. */
export function parseVersionFloor(range: string | undefined): string | undefined {
  const match = range?.match(/>=\s*(\d+\.\d+\.\d+)/)
  return match?.[1]
}

/** `a` and `b` as `x.y.z`; negative when `a < b`, zero when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Pure form of the check, for tests: returns the error message for an
 * installed `version` (`undefined` when `storybook` cannot be resolved) and
 * peer `range`, or `null` when it satisfies the range.
 */
export function storybookPeerProblem(
  version: string | undefined,
  range: string | undefined,
  packageName: string,
): string | null {
  const floor = parseVersionFloor(range)
  const requirement = `storybook ${range ?? ''}`.trim()
  if (!version) {
    return (
      `${packageName} requires the "storybook" package as a peer dependency (${requirement}), ` +
      `but it could not be resolved. Install it alongside the plugin.`
    )
  }
  if (floor && compareVersions(version, floor) < 0) {
    return (
      `${packageName} requires ${requirement}, but storybook ${version} is installed. ` +
      `Upgrade storybook to ${floor} or newer.`
    )
  }
  return null
}

let checked = false

/**
 * Verifies the installed `storybook` satisfies this package's peer range,
 * once per process. Throws a message naming the peer requirement.
 */
export function assertStorybookPeer(): void {
  if (checked) return
  const own = require('../package.json') as OwnPackageJson
  let version: string | undefined
  try {
    version = (require('storybook/package.json') as { version?: string }).version
  } catch {
    version = undefined
  }
  const problem = storybookPeerProblem(
    version,
    own.peerDependencies?.['storybook'],
    own.name,
  )
  if (problem) throw new Error(problem)
  checked = true
}

const loaded = new Map<string, unknown>()

/**
 * Synchronously loads `storybook/internal/<subpath>` after the peer check,
 * memoised per subpath.
 */
export function loadStorybookInternal<T>(subpath: string): T {
  const cached = loaded.get(subpath)
  if (cached) return cached as T
  assertStorybookPeer()
  const mod = require(`storybook/internal/${subpath}`) as T
  loaded.set(subpath, mod)
  return mod
}
