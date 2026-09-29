/// <reference types="@vitejs/devtools-kit" />
/// <reference types="vite/client" />
import type { DockClientScriptContext } from '@vitejs/devtools-kit/client'
import {
  overlayEvents,
  showStoryCreationFeedback,
  hideContextMenu,
} from './overlay'
import { autoInitRpc, setRegistryRpcCall } from './listeners'
import {
  getActiveSurface,
  setActiveSurface,
  surfaceHandlesPanelActions,
} from './utils/active-surface'
import { debug, error as logError } from './logger'

// Track previous subscription so we never stack duplicate listeners
// (clientScriptSetup may be called more than once on HMR or dock reconnect)
let unsubLogInfo: (() => void) | null = null
const visitStoryClients = new WeakSet<object>()
const storyCreatedClients = new WeakSet<object>()
const initializedDocks = new WeakSet<object>()

export default function clientScriptSetup(ctx: DockClientScriptContext): void {
  debug('clientScriptSetup called')
  // The action can be imported on the first click, before the listeners'
  // host-context retry has run. Register receivers before broadcasting.
  autoInitRpc()

  // Inject RPC call function into listeners.ts so it can push registry diffs.
  // Wait for trust first to avoid "Unauthorized access" errors.
  ctx.rpc
    .ensureTrusted()
    .then(() => {
      setRegistryRpcCall(async (method: string, ...args: unknown[]) => {
        // `ctx.rpc.call` only accepts a literal method name from
        // `DevframeRpcServerFunctions`; this passthrough forwards an
        // arbitrary runtime method string, which no literal-keyed
        // signature can type.
        return (
          ctx.rpc.call as (m: string, ...a: unknown[]) => Promise<unknown>
        )(method, ...args)
      })
    })
    .catch(() => {
      // Trust denied or timed out
    })

  // ─── Dock activation/deactivation ─────────────────────────────────

  // Toggle highlight mode through the server, not the local state machine.
  // This dock's client script runs wherever the dock UI lives — the embedded
  // in-page dock, but also a separate DevTools-panel/browser-extension
  // context — while the overlay must run in the app page. `set-highlight-mode`
  // fans `do-set-highlight-mode` out to every connected client, so the app
  // page's listeners toggle their own overlay regardless of where this runs
  // (the embedded case receives its own broadcast just the same).
  const setHighlightMode = (enabled: boolean) => {
    ;(ctx.rpc.call as (m: string, ...a: unknown[]) => Promise<unknown>)(
      'component-highlighter:set-highlight-mode',
      { enabled },
    ).catch(() => {
      // Not connected/trusted yet — best effort.
    })
  }

  const activate = () => {
    debug('dock activated - enabling highlight mode')
    // Claim "driver" for this surface, so panel-open/navigation actions that
    // follow (e.g. Go to story) route here instead of popping every surface.
    setActiveSurface(ctx.rpc, ctx.clientType)
    setHighlightMode(true)
  }

  if (!initializedDocks.has(ctx.current)) {
    initializedDocks.add(ctx.current)
    ctx.current.events.on('entry:activated', activate)
    ctx.current.events.on('entry:deactivated', () => {
      debug('dock deactivated - disabling highlight mode')
      setHighlightMode(false)
    })
    // The hub selects action entries before importing/executing their script.
    // That initial event has already fired; subsequent selections use events.
    if (ctx.current.isActive) activate()
  }

  // Open/switch this surface's Storybook panel when a story is visited —
  // but only on the surface that's currently driving. The `do-visit-story`
  // broadcast reaches every connected surface; the panel iframe navigation
  // is handled separately (panel.ts) on all of them, while the dock only
  // opens where the user is actually working.
  if (ctx.rpc.client && !visitStoryClients.has(ctx.rpc.client)) {
    try {
      ctx.rpc.client.register({
        name: 'component-highlighter:do-visit-story',
        type: 'action',
        handler: async () => {
          const active = await getActiveSurface(ctx.rpc)
          if (!surfaceHandlesPanelActions(ctx.clientType, active)) return
          if (ctx.docks?.switchEntry) {
            await ctx.docks.switchEntry('storybook-devtools')
          }
        },
      })
      visitStoryClients.add(ctx.rpc.client)
    } catch {
      // Client RPC registration not supported
    }
  }

  // Expose a function so the double-Escape handler in listeners.ts can
  // programmatically toggle the dock off (updates the DevTools button state).
  ;(
    window as unknown as { __componentHighlighterDeactivateDock?: () => void }
  ).__componentHighlighterDeactivateDock = () => {
    ctx.docks.toggleEntry(ctx.current.entryMeta.id)
  }

  // Clean up previous listener before adding a new one
  if (unsubLogInfo) {
    unsubLogInfo()
    unsubLogInfo = null
  }

  // Listen for "Create Story" button clicks from overlay
  unsubLogInfo = overlayEvents.on('log-info', async (data) => {
    debug(
      'log-info event received, calling RPC:',
      data.meta.componentName,
      'story:',
      data.storyName,
    )

    try {
      // Pass serialized props and component registry to the server. Raw props
      // are intentionally NOT sent — they hold unclonable live values and the
      // server generates stories from serializedProps only.
      await ctx.rpc.call('component-highlighter:create-story', {
        meta: data.meta,
        ...(data.serializedProps
          ? { serializedProps: data.serializedProps }
          : {}),
        ...(data.componentRegistry
          ? { componentRegistry: data.componentRegistry }
          : {}),
        ...(data.storyName ? { storyName: data.storyName } : {}),
        ...(data.playFunction ? { playFunction: data.playFunction } : {}),
        ...(data.playImports ? { playImports: data.playImports } : {}),
      })

      debug('RPC call successful')
      // Feedback will be shown via HMR event from server
    } catch (err) {
      logError('RPC call failed:', err)
      // Show error feedback in overlay
      showStoryCreationFeedback('error')
    }
  })

  // Listen for story creation confirmation, broadcast by the server via RPC.
  if (ctx.rpc.client && !storyCreatedClients.has(ctx.rpc.client)) {
    try {
      ctx.rpc.client.register({
        name: 'component-highlighter:story-created',
        type: 'action',
        handler: async (data: {
          filePath: string
          componentName: string
          componentPath?: string
          relativeFilePath?: string
          storyName?: string
          isAppend?: boolean
          skipNavigation?: boolean
        }) => {
          debug(`Story created for ${data.componentName}: ${data.filePath}`)
          showStoryCreationFeedback(
            'success',
            data.filePath,
            data.componentPath,
          )

          // Skip navigation for batch operations (e.g. "Create all" from coverage panel)
          if (data.skipNavigation) return

          // If Storybook is already running, tell the panel to navigate to
          // the newly created story via RPC (works whether panel is inline
          // or popped out)
          const relPath = data.relativeFilePath
          if (!relPath) return

          try {
            const status = await ctx.rpc.call(
              'component-highlighter:storybook-status',
            )
            if (!status.running) return
          } catch {
            return
          }

          // Close the context menu now that we're navigating to the story
          // (a no-op on surfaces without an in-page overlay).
          hideContextMenu()

          // The story-created broadcast reaches every surface; only the one
          // driving triggers the navigation, so we don't pop a dock on a
          // surface the user isn't working in. The dock switch itself is done
          // by the `do-visit-story` handler above, on the matching surface.
          const active = await getActiveSurface(ctx.rpc)
          if (!surfaceHandlesPanelActions(ctx.clientType, active)) return

          try {
            await ctx.rpc.call('component-highlighter:visit-story', {
              relativeFilePath: relPath,
              ...(data.storyName
                ? { preferredStoryName: data.storyName }
                : {}),
            })
          } catch {
            // Panel may not have registered its handler yet; best effort
          }
        },
      })
      storyCreatedClients.add(ctx.rpc.client)
    } catch {
      // Client RPC registration not supported
    }
  }
}
