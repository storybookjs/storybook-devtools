import type { SerializedRegistryInstance } from '../shared-types'
import { checkStory } from './functions/check-story'
import { createStory } from './functions/create-story'
import { getConfig } from './functions/get-config'
import { getCoverage } from './functions/get-coverage'
import { highlightCoverageBatch } from './functions/highlight-coverage-batch'
import { highlightCoverageInstances } from './functions/highlight-coverage-instances'
import { highlightTarget } from './functions/highlight-target'
import { notify } from './functions/notify'
import { pushRegistryDiff } from './functions/push-registry-diff'
import { resetProp } from './functions/reset-prop'
import { scrollToComponent } from './functions/scroll-to-component'
import { selectComponent } from './functions/select-component'
import { setHighlightMode } from './functions/set-highlight-mode'
import { setProp } from './functions/set-prop'
import { startStorybook } from './functions/start-storybook'
import { storybookIndex } from './functions/storybook-index'
import { storybookStatus } from './functions/storybook-status'
import { toggleHighlightVisibility } from './functions/toggle-highlight-visibility'
import { toggleOverlay } from './functions/toggle-overlay'
import { visitStory } from './functions/visit-story'

export const serverFunctions = [
  highlightTarget,
  toggleOverlay,
  createStory,
  getCoverage,
  pushRegistryDiff,
  scrollToComponent,
  setProp,
  resetProp,
  highlightCoverageInstances,
  highlightCoverageBatch,
  setHighlightMode,
  toggleHighlightVisibility,
  visitStory,
  selectComponent,
  notify,
  getConfig,
  storybookStatus,
  storybookIndex,
  startStorybook,
  checkStory,
] as const

type DevframeRpcServerFunctionsShape =
  import('devframe/rpc').RpcDefinitionsToFunctionsWithNamespace<
    'component-highlighter',
    typeof serverFunctions
  >

// RPC function type declarations. `devframe` (not `@vitejs/devtools-kit`) owns
// these registries — the kit re-exports the same interfaces, so client code
// augmenting either module sees the same merged shape.
declare module 'devframe' {
  interface DevframeRpcServerFunctions extends DevframeRpcServerFunctionsShape {}

  interface DevframeRpcClientFunctions {
    'component-highlighter:runtime-snapshot': (query: import('../agent').RuntimeQuery) => import('../agent').RuntimePage | null
    'component-highlighter:do-scroll-to-component': (data: {
      componentName: string
      id?: string
    }) => void
    'component-highlighter:do-toggle-highlight-visibility': () => void
    'component-highlighter:do-highlight-coverage': (
      data: { componentName: string; hasStory: boolean } | null,
    ) => void
    'component-highlighter:do-highlight-coverage-batch': (
      data: Array<{ componentName: string; hasStory: boolean }>,
    ) => void
    'component-highlighter:do-set-highlight-mode': (data: {
      enabled: boolean
      toggle?: boolean
    }) => void
    'component-highlighter:do-visit-story': (data: {
      relativeFilePath: string
      preferredStoryName?: string
    }) => void
    'component-highlighter:do-open-url': (data: { url: string }) => void
    'component-highlighter:do-open-panel-tab': (data: { tab: string }) => void
    'component-highlighter:do-switch-tab': (data: { tab: string }) => void
    'component-highlighter:do-select-component': (
      data: SerializedRegistryInstance | null,
    ) => void
    'component-highlighter:do-set-prop': (data: {
      id: string
      path: Array<string | number>
      payload: { kind: string; text: string }
    }) => void
    'component-highlighter:do-reset-prop': (data: {
      id: string
      path: Array<string | number>
    }) => void
    /** Server→client broadcast announcing a story file write finished (success or failure). */
    'component-highlighter:story-created': (data: {
      filePath: string
      componentName: string
      componentPath: string
      relativeFilePath?: string
      storyName: string
      isAppend: boolean
      skipNavigation?: boolean
    }) => void
  }

  // Scalar/nullable states carry their payload in a `{ value }` envelope —
  // devframe shared state is object-only. `registry` is an array and stays flat.
  interface DevframeRpcSharedStates {
    'component-highlighter:registry': SerializedRegistryInstance[]
    'component-highlighter:pending-visit': {
      value: {
        relativeFilePath: string
        preferredStoryName?: string
      } | null
    }
    'component-highlighter:pending-tab': { value: string | null }
    'component-highlighter:highlight-active': { value: boolean }
    'component-highlighter:selected-component': {
      value: SerializedRegistryInstance | null
    }
    'component-highlighter:highlighter-tab-active': { value: boolean }
    'component-highlighter:highlights-visible': { value: boolean }
  }
}
