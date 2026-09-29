/**
 * Host-neutral hub surfaces (docks, commands, terminals, messages,
 * diagnostics) for the component-highlighter devframe.
 *
 * `DevframeHubContext` (from `@devframes/hub`) is the runtime shape a
 * bundler-kit context actually has once its bundler-specific fields
 * (`viteConfig`, `viteServer`, ...) are set aside — every kit's context is
 * built on top of it. Everything here works against that shared shape, so
 * it runs unchanged under any host, not just Vite.
 */
import {
  defineCommand,
  defineDockEntry,
  type DevframeHubContext,
  type DevframeViewAction,
} from '@devframes/hub'
import { DevToolsNotificationService } from './notifications'
import { collectCoverage } from './coverage-dashboard'
import { getStorybookDevframeContext, type CreateStorybookDevframeDeps } from './context'
import type { ChDiagnostics } from './unplugin'
import type { SerializedRegistryInstance } from './shared-types'
import { getStorybookDocsUrl } from './utils/storybook-docs-url'

const COMPONENT_HIGHLIGHTER_ICON =
  "data:image/svg+xml;utf8,<svg width='14' height='14' viewBox='0 0 14 14' fill='none' xmlns='http://www.w3.org/2000/svg'><path d='M12 1C12.5523 1 13 1.44772 13 2V7.5C13 7.77614 12.7761 8 12.5 8C12.2239 8 12 7.77614 12 7.5V2H2V12.0039H7.5C7.77612 12.0039 7.99996 12.2278 8 12.5039C8 12.78 7.77614 13.0039 7.5 13.0039H2C1.44771 13.0039 1 12.5562 1 12.0039V2C1 1.44772 1.44771 1 2 1H12Z' fill='%23515151'/><path d='M9.50098 6.00391C9.77697 6.00444 10.0004 6.22885 10 6.50488C9.99946 6.78088 9.77506 7.00427 9.49902 7.00391L7.70801 7.00098L12.8535 12.1465C13.0488 12.3417 13.0488 12.6583 12.8535 12.8535C12.6583 13.0488 12.3417 13.0488 12.1465 12.8535L7 7.70703V9.5C7 9.77614 6.77614 10 6.5 10C6.22386 10 6 9.77614 6 9.5V6.50391C6 6.46848 6.00276 6.43373 6.00977 6.40039C6.05604 6.1717 6.25871 5.99968 6.50098 6L9.50098 6.00391Z' fill='%23515151'/></svg>"

export interface StorybookHubSetupOptions {
  /** The same dependencies the devframe itself was built with. */
  deps: CreateStorybookDevframeDeps
  devtoolsDockId: string
  /**
   * Client script for the highlighter action dock. Vite hosts pass the bare
   * package specifier (resolved via the host's clientModuleResolution
   * template); other hosts pass a URL path to a served self-contained
   * bundle.
   */
  dockClientScript: { importFrom: string; importName?: string }
}

/**
 * Registers the component-highlighter's hub-level surfaces — notifications,
 * diagnostics, terminals, the action dock, and the command-palette entries —
 * against a bundler-neutral `DevframeHubContext`. Excludes the Vite-only
 * `clientModuleResolution` pre-seed, which stays with the Vite adapter.
 */
export function registerStorybookHubSurfaces(
  ctx: DevframeHubContext,
  options: StorybookHubSetupOptions,
): { diagnostics: ChDiagnostics | null } {
  const { deps, devtoolsDockId, dockClientScript } = options
  const { storyIndexService } = deps
  const { state } = getStorybookDevframeContext(ctx)

  // Upgrade to DevTools notifications when the Messages API is available.
  if (ctx.messages) {
    state.notifications = new DevToolsNotificationService(ctx.messages)
  }

  // Structured diagnostics: a coded catalog of the plugin's non-fatal
  // detection gaps, surfaced through the DevTools diagnostics host instead
  // of bare console warnings. Emitted from the transform hook.
  let diagnostics: ChDiagnostics | null = null
  if (ctx.diagnostics) {
    const defined = ctx.diagnostics.defineDiagnostics({
      // Function form returns a clean URL for every code (the string form
      // would append the lowercased code as a path segment).
      docsBase: () =>
        'https://github.com/storybookjs/vite-plugin-experimental-storybook-devtools/blob/main/docs/REACT_PATTERNS.md',
      codes: {
        CH_TRANSFORM_FAILED: {
          why: (p: { file: string; detail: string }) =>
            `Failed to instrument ${p.file} for component detection: ${p.detail}`,
          fix: 'The file was served unmodified, so its components have no stories/highlights. Check that it parses as valid TS/JSX.',
        },
        CH_UNSUPPORTED_PATTERN: {
          why: (p: { name: string; detail: string }) =>
            `Component "${p.name}" can’t be detected: ${p.detail}`,
          fix: 'See the supported authoring-pattern matrix for the recommended form.',
        },
      },
    })
    ctx.diagnostics.register(defined)
    diagnostics = defined as ChDiagnostics
  }

  // Store terminals + messages references for the start-storybook RPC handler
  state.devtoolsTerminals = ctx.terminals
  state.devtoolsMessages = ctx.messages
  state.devtoolsDocks = ctx.docks

  // Register dock entry for component highlighter UI
  ctx.docks.register(
    defineDockEntry<DevframeViewAction>({
      id: devtoolsDockId,
      title: 'Component Highlighter',
      icon: COMPONENT_HIGHLIGHTER_ICON,
      type: 'action',
      action: dockClientScript,
    }),
  )

  // ─── Helper: open a specific tab in the panel ──────────────────

  function openPanelTab(tab: string) {
    // Store in shared state so the panel picks it up on load or via subscription
    ctx.rpc.sharedState
      .get('component-highlighter:pending-tab')
      .then((store) =>
        store.mutate((s: { value: string | null }) => {
          s.value = tab
        }),
      )
      .catch(() => {})
    // Tell the client to switch the dock to the panel (if not already open)
    ctx.rpc.broadcast({
      method: 'component-highlighter:do-open-panel-tab',
      args: [{ tab }],
    })
    // Tell the panel directly to switch tabs (if already open)
    ctx.rpc.broadcast({
      method: 'component-highlighter:do-switch-tab',
      args: [{ tab }],
    })
  }

  // ─── Commands (Mod+K palette) ──────────────────────────────────

  ctx.commands.register(
    defineCommand({
      id: 'storybook:toggle-highlight-mode',
      title: 'Toggle Component Highlighter',
      description: 'Start or stop inspecting components on the page',
      icon: 'ph:crosshair',
      category: 'Storybook',
      keybindings: [{ key: 'Mod+Shift+H' }],
      handler: () => {
        ctx.rpc.broadcast({
          method: 'component-highlighter:do-set-highlight-mode',
          args: [{ enabled: true, toggle: true }],
        })
      },
    }),
  )

  ctx.commands.register(
    defineCommand({
      id: 'storybook:create-missing-stories',
      title: 'Write Stories for Missing Components',
      description:
        'Generate story files for all visible components without stories',
      icon: 'ph:file-plus-duotone',
      category: 'Storybook',
      handler: async () => {
        // Use the registry snapshot + coverage data to find uncovered visible components
        const coverage = await collectCoverage(
          storyIndexService,
          state.transformedComponents,
        )
        const uncovered = coverage.entries.filter((e) => !e.hasStory)
        if (uncovered.length === 0) {
          state.notifications.notify({
            message: 'All components already have stories',
            level: 'success',
            toast: true,
            autoDismissMs: 3000,
            category: 'story-creation',
          })
          return
        }

        // Find visible uncovered components in the registry snapshot
        const registryStore = await ctx.rpc.sharedState.get(
          'component-highlighter:registry',
        )
        let storiesCreated = 0
        for (const entry of uncovered) {
          // Find a matching instance in the registry
          const allInstances = registryStore.value()
          const instances = (
            allInstances as SerializedRegistryInstance[]
          ).filter(
            (inst) => inst.meta.filePath === entry.filePath && inst.isConnected,
          )
          if (instances.length === 0) continue

          // Deduplicate by props fingerprint
          const seen = new Set<string>()
          for (const inst of instances) {
            const fp = inst.serializedProps
              ? JSON.stringify(inst.serializedProps)
              : '{}'
            if (seen.has(fp)) continue
            seen.add(fp)

            // Invoke the create-story handler directly
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (ctx.rpc.invokeLocal as any)(
              'component-highlighter:create-story',
              {
                meta: inst.meta,
                serializedProps: inst.serializedProps,
                skipNavigation: true,
              },
            )
            storiesCreated++
          }
        }

        state.notifications.notify({
          message:
            storiesCreated > 0
              ? `Created stories for ${storiesCreated} component${storiesCreated === 1 ? '' : 's'}`
              : 'No visible uncovered components found — navigate to a page with components first',
          level: storiesCreated > 0 ? 'success' : 'info',
          toast: true,
          autoDismissMs: 4000,
          category: 'story-creation',
        })

        // Open the coverage tab so the user can see the updated results
        openPanelTab('coverage')
      },
    }),
  )

  ctx.commands.register(
    defineCommand({
      id: 'storybook:see-coverage',
      title: 'See Component Coverage',
      description:
        'Open the coverage dashboard showing story status for all components',
      icon: 'ph:chart-bar-duotone',
      category: 'Storybook',
      handler: () => {
        openPanelTab('coverage')
      },
    }),
  )

  ctx.commands.register(
    defineCommand({
      id: 'storybook:open-docs',
      title: 'Open Storybook Docs',
      description: 'Open the Storybook documentation website',
      icon: 'ph:book-open-duotone',
      category: 'Storybook',
      handler: async () => {
        // Server-side commands can't open browser tabs directly,
        // but we can broadcast to the client to do it
        ctx.rpc.broadcast({
          method: 'component-highlighter:do-open-url',
          args: [{ url: getStorybookDocsUrl(await deps.storybookFramework) }],
        })
      },
    }),
  )

  return { diagnostics }
}
