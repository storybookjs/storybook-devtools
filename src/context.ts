import type { DevframeNodeContext } from 'devframe'
import type { ViteDevServer } from 'vite'
import type { FrameworkConfig } from './frameworks'
import type { NotificationService } from './notifications'
import type { StoryIndexService } from './story-index'

/**
 * Transform state shared by the plugin, with a derived state per RPC context.
 * Hub resources (terminals, notifications) and process lifecycle are assigned
 * on that derived state so Nuxt client/SSR hubs remain independent.
 * Shared-state stores are NOT cached here — `setup()` may run in more than
 * one context (e.g. Nuxt's client + SSR Vite), so handlers resolve stores
 * from their own `ctx.rpc.sharedState` per call.
 */
export interface StorybookDevframeState {
  server: ViteDevServer | undefined
  notifications: NotificationService
  transformedComponents: Map<string, string>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  devtoolsTerminals: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storybookSession: any
  /** Hub messages host, for failure toasts — set alongside `devtoolsTerminals`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  devtoolsMessages: any
  /**
   * Hub docks host, set alongside `devtoolsTerminals`. Consulted to decide
   * whether a Terminals dock exists to deep-link into: the hub always
   * provides `ctx.terminals` for spawning sessions, but the dock that shows
   * them is a separate plugin the Vite host registers and the Rsbuild/Next
   * adapters register explicitly.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  devtoolsDocks?: any
  /**
   * Set when the last `start-storybook` child process exited before
   * Storybook became reachable; cleared on the next start attempt.
   */
  storybookStartFailure: {
    code: number | null
    /** Short tail of the process output, shown as a failure preview. */
    detail?: string | null
  } | null
}

export interface CreateStorybookDevframeDeps {
  framework: FrameworkConfig
  storybookUrl: string
  writeStoryFiles: boolean
  storiesDir: string | undefined
  logDebug: (...args: unknown[]) => void
  state: StorybookDevframeState
  /**
   * The Storybook framework package to write into generated stories and to
   * pick the docs URL from: the one in the user's `.storybook/main` config,
   * falling back to `framework.storybookFramework` when the project has no
   * Storybook config. Resolved once per host at setup; handlers await it
   * rather than the startup path doing so.
   */
  storybookFramework: Promise<string>
  /**
   * Builds/serves the index behind coverage and `check-story`. One instance
   * per host, constructed at setup; also carries the host's
   * resolved Storybook project info (`storyIndexService.project`).
   */
  storyIndexService: StoryIndexService
}

/**
 * The Storybook framework package for `CreateStorybookDevframeDeps`: what
 * the user's `.storybook/main` config declares, falling back to the host
 * framework's default when the project has no Storybook config. Hosts call
 * this once at setup, without awaiting it there.
 */
export async function resolveStorybookFramework(
  storyIndexService: StoryIndexService,
  framework: FrameworkConfig,
): Promise<string> {
  const project = await storyIndexService.project
  return project?.frameworkPackage ?? framework.storybookFramework
}

const map = new WeakMap<DevframeNodeContext, CreateStorybookDevframeDeps>()

export function setStorybookDevframeContext(
  ctx: DevframeNodeContext,
  deps: CreateStorybookDevframeDeps,
): void {
  // Nuxt installs the same definition into client and SSR hubs. Share
  // transform state through the prototype, but keep process/terminal state
  // on each RPC context so the second hub cannot steal the first's PTY.
  const state: StorybookDevframeState = Object.create(deps.state)
  state.storybookSession = null
  state.storybookStartFailure = null
  map.set(ctx, { ...deps, state })
}

export function getStorybookDevframeContext(
  ctx: DevframeNodeContext,
): CreateStorybookDevframeDeps {
  const deps = map.get(ctx)
  if (!deps) {
    throw new Error(
      'StorybookDevframe context not initialized — call setStorybookDevframeContext in devframe.setup',
    )
  }
  return deps
}
