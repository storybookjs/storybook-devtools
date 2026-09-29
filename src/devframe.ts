/**
 * Storybook devframe definition. Registers the plugin's RPC surface and
 * shared state on the devframe-level `DevframeNodeContext`. Kit-only
 * surfaces (docks, terminals, messages, commands) are wired separately in
 * `create-component-highlighter-plugin.ts`'s `kitSetup`.
 */
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { defineDevframe } from 'devframe'
import {
  setStorybookDevframeContext,
  type CreateStorybookDevframeDeps,
} from './context'
import { serverFunctions } from './rpc'
import { resolveProjectRootSync } from './storybook-project'

// Downstream hosts and the public `./devframe` entry import these from here.
export type {
  StorybookDevframeState,
  CreateStorybookDevframeDeps,
} from './context'

const STORYBOOK_ICON =
  "data:image/svg+xml;utf8,<svg width='14' height='14' viewBox='0 0 14 14' fill='none' xmlns='http://www.w3.org/2000/svg'><g transform='translate(1.49,0)'><path d='M0.424547 12.6139L0.000492865 1.31474C-0.013512 0.941579 0.272618 0.625325 0.645319 0.602032L10.256 0.00136365C10.6354 -0.0223467 10.9621 0.265968 10.9858 0.645333C10.9867 0.659626 10.9872 0.673944 10.9872 0.688265V13.0006C10.9872 13.3808 10.679 13.6889 10.2989 13.6889C10.2886 13.6889 10.2783 13.6887 10.2681 13.6882L1.08142 13.2756C0.723641 13.2595 0.437978 12.9717 0.424547 12.6139Z' fill='%23FF4785'/></g><g transform='translate(4.32,0.05)'><path d='M2.8709 2.41309C4.66253 2.41309 5.64141 3.37189 5.64141 5.19531C5.39918 5.38328 3.59731 5.51136 3.59551 5.24414C3.63363 4.2224 3.17581 4.17676 2.92168 4.17676C2.6802 4.17684 2.27422 4.25082 2.27422 4.79785C2.27474 6.1477 5.75567 6.07536 5.75567 8.7998C5.75543 10.3321 4.50986 11.1787 2.92168 11.1787C1.28271 11.1786 -0.149264 10.5148 0.0125021 8.21582C0.0781737 7.94653 2.15713 8.01044 2.15996 8.21582C2.13456 9.16434 2.35021 9.4442 2.89629 9.44434C3.31561 9.44434 3.50664 9.21248 3.50664 8.82324C3.50588 7.43713 0.0764084 7.38812 0.0759787 4.84668C0.0759787 3.38715 1.07952 2.41323 2.8709 2.41309ZM6.72637 1.58008C6.72811 1.63655 6.68328 1.68357 6.62676 1.68555C6.60253 1.68637 6.57842 1.67907 6.55938 1.66406L6.05059 1.2627L5.44805 1.71973C5.40288 1.75399 5.33876 1.74536 5.30449 1.7002C5.29007 1.68118 5.28299 1.65764 5.28399 1.63379L5.34844 0.0830078L6.67071 0L6.72637 1.58008Z' fill='white'/></g></svg>"

/**
 * Build the `storybook-devtools` devframe: the plugin's RPC surface, shared
 * state, and the panel's client assets. Mounted into Vite DevTools by
 * `createPluginFromDevframe` in `create-component-highlighter-plugin.ts`.
 */
export function createStorybookDevframe(deps: CreateStorybookDevframeDeps) {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  )
  const repositoryRoot = resolveProjectRootSync()
  const pkgRequire = createRequire(import.meta.url)
  const pkg = pkgRequire('../package.json') as {
    version: string
    name: string
    homepage: string
    description: string
  }

  // A stale dist/panel (built before the devframe mount, or missing) makes
  // the panel dock render an empty transparent page with no error anywhere —
  // fail loudly here instead.
  const clientAssetsDir = path.join(packageRoot, 'dist', 'panel')
  try {
    const indexHtml = fs.readFileSync(
      path.join(clientAssetsDir, 'index.html'),
      'utf-8',
    )
    if (!/(?:src|href)="\.\//.test(indexHtml)) {
      console.warn(
        '[storybook-devtools] dist/panel is stale: its asset URLs are not ' +
          'relative to the panel mount base, so the panel will render ' +
          'empty. Rebuild the package (pnpm build).',
      )
    }
  } catch {
    console.warn(
      '[storybook-devtools] dist/panel/index.html not found — build the ' +
        'package (pnpm build) or the panel dock will render empty.',
    )
  }

  return defineDevframe({
    id: 'storybook-devtools',
    name: 'Storybook',
    version: pkg.version,
    packageName: pkg.name,
    homepage: pkg.homepage,
    description: pkg.description,
    importMetaUrl: import.meta.url,
    icon: STORYBOOK_ICON,
    clientAssets: clientAssetsDir,
    // Host-level open-in-editor / reveal-in-finder wire service, shipped as
    // a dependency so it resolves on every host. Clients feature-detect via
    // `rpc.services.has('@devframes/service-open')` — the panel and overlay
    // prefer it over Vite's `/__open-in-editor`, which non-Vite hosts lack.
    // The service only opens paths under the host's workspace root, but
    // registered component paths are fully resolved: with symlinked source
    // trees or sibling workspace packages they land outside the app's own
    // directory, so allow the whole repository as an extra root.
    services: [
      {
        package: '@devframes/service-open',
        options: { roots: repositoryRoot ? [repositoryRoot] : [] },
      },
    ],
    setup(ctx) {
      setStorybookDevframeContext(ctx, deps)
      const scope = ctx.scope('component-highlighter')

      // devframe shared state is immer-backed and object-only
      // (`sharedState<T extends object>`): scalar/nullable states carry
      // their payload in a `{ value }` envelope; `registry` is an array and
      // stays flat.

      scope.rpc.sharedState('registry', {
        initialValue: [],
      })

      scope.rpc.sharedState('pending-visit', {
        initialValue: { value: null },
      })

      scope.rpc.sharedState('pending-tab', {
        initialValue: { value: null },
      })

      scope.rpc.sharedState('highlight-active', {
        initialValue: { value: false },
      })

      scope.rpc.sharedState('selected-component', {
        initialValue: { value: null },
      })

      scope.rpc.sharedState('highlighter-tab-active', {
        initialValue: { value: false },
      })

      scope.rpc.sharedState('highlights-visible', {
        initialValue: { value: true },
      })

      // Which DevTools surface ('embedded' | 'standalone') is currently
      // driving — set when a surface activates the highlighter, read by the
      // panel-open/navigation handlers to route to that surface only.
      scope.rpc.sharedState('active-surface', {
        initialValue: { value: null },
      })

      for (const fn of serverFunctions) {
        scope.rpc.register(fn)
      }
    },
  })
}
