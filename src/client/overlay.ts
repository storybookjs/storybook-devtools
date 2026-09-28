import type { ComponentInstance, SerializedProps } from '../frameworks/types'
import type { Emitter } from 'nanoevents'
import { createNanoEvents } from 'nanoevents'
import { getHostClientContext } from './utils/host-context'
import { debug, warn, error as logError } from './logger'
import {
  UI_MARKER,
  getPlayFunctionCode,
  isCurrentlyRecording,
  startRecording,
  stopRecording,
} from './interaction-recorder'
import { createContextMenu, type ContextMenuHandle } from './context-menu'
import type { HighlightEvent } from './highlight-machine'
import { attachHighlightLabel, removeHighlightLabel } from './highlight-label'
import { pickStoryId } from '../utils/story-matching'

/**
 * Wraps an overlay operation in a try-catch so that errors in the
 * highlight/menu rendering never bubble up and break the host app.
 */
function safeOverlayCall<T>(fn: () => T, fallback?: T): T | undefined {
  try {
    return fn()
  } catch (err) {
    logError('Overlay error — disabling to avoid breaking the host app:', err)
    try {
      disableOverlaySafe()
    } catch {
      /* best effort cleanup */
    }
    return fallback
  }
}

function disableOverlaySafe() {
  if (highlightContainer) {
    highlightContainer.remove()
    highlightContainer = null
  }
  highlightElements.clear()
  if (contextMenuHandle) {
    contextMenuHandle.destroy()
    contextMenuHandle = null
  }
  document.body.style.cursor = ''
}

// Event emitter for overlay actions
export interface OverlayEvents {
  'log-info': (data: {
    meta: ComponentInstance['meta']
    serializedProps?: SerializedProps
    componentRegistry?: Record<string, string>
    storyName?: string
    playFunction?: string[]
    playImports?: string[]
  }) => void
}

export const overlayEvents: Emitter<OverlayEvents> =
  createNanoEvents<OverlayEvents>()

const OVERLAY_Z_INDEX = {
  container: 2147483000,
  menu: 2147483647,
} as const

// Host-page overlays cannot consume shadow-root tokens.
const COLORS = {
  uncovered: { stroke: '#006DEB', bg: 'rgba(0, 109, 235, 0.05)', selectedBg: 'rgba(0, 109, 235, 0.2)' }, // --sb-color-secondary
  covered: { stroke: '#FF4785', bg: 'rgba(255, 71, 133, 0.05)', selectedBg: 'rgba(255, 71, 133, 0.2)' }, // --sb-color-brand
}

// ─── DOM-level state (managed by overlay, not the machine) ──────────

let highlightContainer: HTMLDivElement | null = null
let highlightElements: Map<string, HTMLDivElement> = new Map()
let contextMenuHandle: ContextMenuHandle | null = null

// Whether the selected component's persistent highlight (its own box and its
// same-type siblings) is hidden. Toggled by the panel's "Show/Hide highlights"
// action. Hover highlights and click-to-select keep working while hidden, and
// selecting a different component shows highlights again.
let highlightsHidden = false
let onHighlightsVisibilityChange: ((visible: boolean) => void) | null = null
let lastDraw: Parameters<typeof drawAllHighlights> | null = null
let lastSelectedId: string | null = null

/** Called with the new visible state whenever it changes (panel label sync). */
export function setHighlightsVisibilityListener(cb: (visible: boolean) => void) {
  onHighlightsVisibilityChange = cb
}

function setHighlightsHidden(hidden: boolean) {
  if (highlightsHidden === hidden) return
  highlightsHidden = hidden
  onHighlightsVisibilityChange?.(!hidden)
}

export function toggleHighlightsHidden() {
  setHighlightsHidden(!highlightsHidden)
  if (lastDraw) drawAllHighlights(...lastDraw)
}

// Cache for story file existence checks
const storyFileCache: Map<
  string,
  { hasStory: boolean; storyPath: string | null }
> = new Map()

// Import component registry from listeners
let componentRegistry: Map<string, ComponentInstance>

export function setComponentRegistry(
  registry: Map<string, ComponentInstance>,
) {
  componentRegistry = registry
}

// Check if a component has a story file
async function checkStoryFile(
  componentPath: string,
): Promise<{ hasStory: boolean; storyPath: string | null }> {
  if (storyFileCache.has(componentPath)) {
    return storyFileCache.get(componentPath)!
  }

  try {
    const ctx = getHostClientContext()
    if (ctx?.rpc?.call) {
      const result = await ctx.rpc.call('component-highlighter:check-story', {
        componentPath,
      })
      storyFileCache.set(componentPath, result)
      return result
    }
  } catch (e) {
    warn('Failed to check story file:', e)
  }

  const defaultResult = { hasStory: false, storyPath: null }
  storyFileCache.set(componentPath, defaultResult)
  return defaultResult
}

// Open-in-editor availability
const OPEN_SERVICE = '@devframes/service-open'
let openInEditorAvailable: boolean | undefined

/** Whether the host advertises the open wire service (synchronous snapshot). */
function hasOpenService(): boolean {
  return !!getHostClientContext()?.rpc.services?.has(OPEN_SERVICE)
}

async function isOpenInEditorAvailable(): Promise<boolean> {
  if (hasOpenService()) return true
  if (openInEditorAvailable !== undefined) return openInEditorAvailable

  try {
    const res = await fetch('/__open-in-editor?file=__probe__', {
      method: 'HEAD',
    })
    openInEditorAvailable = res.status !== 404
  } catch {
    openInEditorAvailable = false
  }
  return openInEditorAvailable
}

async function openInEditor(filePath: string) {
  if (hasOpenService()) {
    try {
      const ctx = getHostClientContext()
      await (ctx!.rpc.call as (m: string, ...a: unknown[]) => Promise<unknown>)(
        'devframes:service:open:open-in-editor',
        { path: filePath },
      )
      debug('Opened file via open service:', filePath)
      return
    } catch (e) {
      logError('Failed to open file via open service:', e)
      return
    }
  }

  if (!(await isOpenInEditorAvailable())) {
    warn(
      'Cannot open file in editor — the /__open-in-editor endpoint is not available.',
    )
    return
  }

  try {
    await fetch(`/__open-in-editor?file=${encodeURIComponent(filePath)}`)
    debug('Opened file:', filePath)
  } catch (e) {
    logError('Failed to open file:', e)
  }
}

// ─── DOM overlay management ─────────────────────────────────────────

function createHighlightContainer() {
  if (highlightContainer) return

  highlightContainer = document.createElement('div')
  highlightContainer.id = 'component-highlighter-container'
  highlightContainer.setAttribute(UI_MARKER, 'true')
  highlightContainer.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: ${OVERLAY_Z_INDEX.container};
  `
  document.body.appendChild(highlightContainer)
}

function removeHighlightContainer() {
  if (highlightContainer) {
    highlightContainer.remove()
    highlightContainer = null
  }
  highlightElements.clear()
}

function getDOMDepth(element: HTMLElement): number {
  let depth = 0
  let current: HTMLElement | null = element
  while (current && current !== document.body) {
    depth++
    current = current.parentElement
  }
  return depth
}

function getEffectiveStackOrder(element: HTMLElement): number {
  let highestAncestorZIndex = 0
  let current: HTMLElement | null = element

  while (current && current !== document.body) {
    const computed = window.getComputedStyle(current)
    const parsed = Number.parseInt(computed.zIndex, 10)
    if (!Number.isNaN(parsed)) {
      highestAncestorZIndex = Math.max(highestAncestorZIndex, parsed)
    }
    current = current.parentElement
  }

  const depth = getDOMDepth(element)
  return highestAncestorZIndex * 10000 + depth
}

/** Whether click-through is currently active (read from DOM state for highlight creation) */
let _clickThroughActive = false

function createHighlightElement(instance: ComponentInstance): HTMLDivElement {
  const el = document.createElement('div')
  el.dataset['highlightId'] = instance.id
  el.style.cssText = `
    position: fixed;
    box-sizing: border-box;
    pointer-events: ${_clickThroughActive ? 'none' : 'auto'};
    cursor: pointer;
  `
  return el
}

function updateHighlightElement(
  el: HTMLDivElement,
  instance: ComponentInstance,
  type: 'hovered' | 'sameType' | 'other' | 'selected',
  hasStory = false,
) {
  if (!instance.rect) return

  const rect = instance.rect
  const colorConfig = hasStory ? COLORS.covered : COLORS.uncovered

  const stackOrder =
    instance.element?.isConnected &&
    instance.element?.nodeType === Node.ELEMENT_NODE
      ? getEffectiveStackOrder(instance.element as HTMLElement)
      : 0
  el.style.zIndex = String(stackOrder)

  el.style.left = `${rect.left}px`
  el.style.top = `${rect.top}px`
  el.style.width = `${rect.width}px`
  el.style.height = `${rect.height}px`
  el.style.backgroundColor = type === 'selected' ? colorConfig.selectedBg : colorConfig.bg

  el.style.border = 'none'
  if (type === 'sameType') {
    el.style.outline = `1px dashed ${colorConfig.stroke}`
  } else {
    el.style.outline = `1px solid ${colorConfig.stroke}`
  }
  el.style.outlineOffset = '-1px'

  if (type === 'hovered' || type === 'selected') {
    attachHighlightLabel(
      el,
      rect,
      instance.meta.componentName,
      colorConfig.stroke,
      hasStory,
    )
  } else {
    removeHighlightLabel(el)
  }
}

// Track pending story file fetches
const pendingStoryChecks = new Set<string>()

/**
 * Draw all highlight overlays for the current state.
 * Called by the machine's drawHighlights action.
 *
 * @param hoveredId  Currently hovered component ID
 * @param selectedId Currently selected component ID
 * @param clickThrough Whether click-through is active
 * @param onHighlightClick Callback when a highlight element is clicked
 */
export function drawAllHighlights(
  hoveredId: string | null,
  selectedId: string | null,
  clickThrough: boolean,
  onHighlightClick?: (instance: ComponentInstance, e: MouseEvent) => void,
) {
  lastDraw = [hoveredId, selectedId, clickThrough, onHighlightClick]
  safeOverlayCall(() =>
    drawAllHighlightsImpl(hoveredId, selectedId, clickThrough, onHighlightClick),
  )
}

function drawAllHighlightsImpl(
  hoveredId: string | null,
  selectedId: string | null,
  clickThrough: boolean,
  onHighlightClick?: (instance: ComponentInstance, e: MouseEvent) => void,
) {
  if (!highlightContainer) return

  if (selectedId && selectedId !== lastSelectedId) setHighlightsHidden(false)
  lastSelectedId = selectedId

  _clickThroughActive = clickThrough
  const instances = Array.from(componentRegistry.values())

  // Find the component name to highlight
  let highlightComponentName: string | null = null
  if (selectedId) {
    const sel = instances.find((inst) => inst.id === selectedId)
    if (sel) highlightComponentName = sel.meta.componentName
  } else if (hoveredId) {
    const hov = instances.find((inst) => inst.id === hoveredId)
    if (hov) highlightComponentName = hov.meta.componentName
  }

  const usedIds = new Set<string>()

  // Prefetch story info
  for (const instance of instances) {
    const filePath = instance.meta.filePath
    if (!storyFileCache.has(filePath) && !pendingStoryChecks.has(filePath)) {
      pendingStoryChecks.add(filePath)
      checkStoryFile(filePath).then(() => {
        pendingStoryChecks.delete(filePath)
        if (highlightContainer) {
          drawAllHighlights(hoveredId, selectedId, clickThrough, onHighlightClick)
        }
      })
    }
  }

  for (const instance of instances) {
    if (!instance.rect) continue

    const storyInfo = storyFileCache.get(instance.meta.filePath)
    const hasStory = storyInfo?.hasStory ?? false

    let shouldShow = false
    let type: 'hovered' | 'sameType' | 'other' | 'selected' = 'other'

    if (selectedId === instance.id) {
      type = 'selected'
      shouldShow = !highlightsHidden
    } else if (hoveredId === instance.id) {
      type = 'hovered'
      shouldShow = true
    } else if (
      highlightComponentName &&
      instance.meta.componentName === highlightComponentName &&
      instance.id !== selectedId &&
      instance.id !== hoveredId
    ) {
      type = 'sameType'
      shouldShow = !(highlightsHidden && selectedId)
    }

    if (shouldShow) {
      usedIds.add(instance.id)

      let el = highlightElements.get(instance.id)
      if (!el) {
        el = createHighlightElement(instance)
        if (onHighlightClick) {
          const inst = instance
          el.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            onHighlightClick(inst, e)
          })
        }
        highlightElements.set(instance.id, el)
        highlightContainer!.appendChild(el)
      }

      updateHighlightElement(el, instance, type, hasStory)
    }
  }

  // Remove unused highlight elements
  for (const [id, el] of highlightElements.entries()) {
    if (!usedIds.has(id)) {
      el.remove()
      highlightElements.delete(id)
    }
  }

  // Update pointer-events
  const pointerEvents = clickThrough ? 'none' : 'auto'
  for (const el of highlightElements.values()) {
    el.style.pointerEvents = pointerEvents
  }
}

function clearAllHighlights() {
  for (const el of highlightElements.values()) {
    el.remove()
  }
  highlightElements.clear()
}

function emitCreateStory(
  data: {
    meta: ComponentInstance['meta']
    serializedProps?: SerializedProps
    storyName: string
  },
  includePlayFunction: boolean,
) {
  const getRegistry = (
    window as unknown as {
      __componentHighlighterGetRegistry?: () => Map<string, string>
    }
  ).__componentHighlighterGetRegistry

  let componentRegistryObj: Record<string, string> = {}
  if (getRegistry) {
    const registry = getRegistry()
    componentRegistryObj = Object.fromEntries(registry)
  }

  const playCode = includePlayFunction ? getPlayFunctionCode() : null

  const componentInfoBase = {
    meta: data.meta,
    componentRegistry: componentRegistryObj,
    storyName: data.storyName,
    ...(playCode
      ? { playFunction: playCode.playLines, playImports: playCode.imports }
      : {}),
  }

  const componentInfo: Parameters<typeof overlayEvents.emit<'log-info'>>[1] = {
    ...componentInfoBase,
    ...(data.serializedProps ? { serializedProps: data.serializedProps } : {}),
  }

  debug('Emitting story creation payload', {
    component: data.meta.componentName,
    storyName: data.storyName,
    includePlayFunction,
    interactionCount: playCode?.playLines.length ?? 0,
  })

  overlayEvents.emit('log-info', componentInfo)

  const createStoryEvent = new CustomEvent(
    'component-highlighter:create-story-request',
    {
      detail: {
        ...componentInfo,
        includePlayFunction,
      },
    },
  )
  window.dispatchEvent(createStoryEvent)
}

// ─── Context menu ───────────────────────────────────────────────────

/**
 * Show context menu for a selected component.
 * @param onMenuClosed Called when the context menu closes itself (click outside, Escape, etc.)
 */
export async function showContextMenu(
  instance: ComponentInstance,
  x: number,
  y: number,
  onMenuClosed: () => void,
) {
  hideContextMenu()

  const meta = instance.meta
  // Resolve the *latest* registry entry at save time so live prop edits
  // (renderer.overrideProps via the tooltip/panel pencil) are reflected in
  // the generated story — not the snapshot captured when the menu opened.
  const liveInstance = () => componentRegistry?.get(instance.id) ?? instance

  const storyInfo = await checkStoryFile(meta.filePath)

  contextMenuHandle = createContextMenu(instance, x, y, storyInfo, {
    openInEditor,
    isOpenInEditorAvailable,
    onSaveStory(storyName: string) {
      debug('Save Story clicked (without interactions)', {
        component: meta.componentName,
      })

      if (isCurrentlyRecording()) {
        debug(
          'Active recording detected during Save Story, stopping recording first',
        )
        stopRecording()
      }

      const live = liveInstance()
      const payload: Parameters<typeof emitCreateStory>[0] = {
        meta,
        storyName,
      }
      if (live.serializedProps) {
        payload.serializedProps = live.serializedProps
      }
      emitCreateStory(payload, false)
    },
    onSaveStoryWithInteractions(storyName: string) {
      if (isCurrentlyRecording()) {
        debug(
          'Save Story with Interactions ignored because recording is already active',
        )
        return
      }

      debug(
        'Save Story with Interactions clicked, starting recording session',
        { component: meta.componentName, storyName },
      )

      // The machine will handle suspending the overlay via START_RECORDING event.
      // We need to import the machine to send events... but to avoid circular deps,
      // we use a callback pattern: the caller (listeners.ts) provides onStartRecording.
      // Actually, we can just use the window hook for recording.
      const sendEvent = (
        window as unknown as {
          __highlightMachineSend?: (event: HighlightEvent) => void
        }
      ).__highlightMachineSend
      if (sendEvent) {
        sendEvent({ type: 'START_RECORDING' })
      }

      startRecording((interactions) => {
        debug(
          'Recording callback received, creating story with recorded interactions',
          {
            component: meta.componentName,
            storyName,
            interactions: interactions.length,
          },
        )

        const live = liveInstance()
        const payload: Parameters<typeof emitCreateStory>[0] = {
          meta,
          storyName,
        }
        if (live.serializedProps) {
          payload.serializedProps = live.serializedProps
        }

        emitCreateStory(payload, true)

        // Resume highlighting via machine
        if (sendEvent) {
          sendEvent({ type: 'STOP_RECORDING' })
        }
      })
    },
    onClose() {
      const h = contextMenuHandle
      contextMenuHandle = null
      h?.destroy()
      onMenuClosed()
    },
    async visitStory(relativeFilePath: string) {
      // Don't open a dock here. `visit-story` broadcasts `do-visit-story` to
      // every surface: each panel navigates its own Storybook iframe, and the
      // surface currently driving (see active-surface routing) opens/switches
      // its dock. Opening it locally would pop the in-app embedded dock even
      // when the user is working in a separate DevTools-panel/extension.
      try {
        const rpcCtx = getHostClientContext()
        if (rpcCtx?.rpc?.call) {
          await rpcCtx.rpc.call('component-highlighter:visit-story', {
            relativeFilePath,
          })
          return
        }
      } catch {
        // RPC not available
      }

      try {
        const rpcCtx = getHostClientContext()
        if (!rpcCtx?.rpc?.call) return
        const data = await rpcCtx.rpc.call(
          'component-highlighter:storybook-index',
        )
        const entries = data.entries || {}
        const storyId = pickStoryId(entries, relativeFilePath)
        if (storyId) {
          window.open(
            `http://localhost:6006/?path=/story/${encodeURIComponent(storyId)}&nav=0`,
            '_blank',
          )
        }
      } catch {
        // Storybook not available
      }
    },
  })
}

export function hideContextMenu() {
  if (contextMenuHandle) {
    contextMenuHandle.destroy()
    contextMenuHandle = null
  }
}

// No-op hover menu exports (label is attached to highlight box)
export function showHoverMenu(
  _instance: ComponentInstance,
  _x: number,
  _y: number,
) {}

export function hideHoverMenu() {}

// ─── Public API (called by machine actions) ─────────────────────────

export function createOverlayDOM() {
  createHighlightContainer()
  setHighlightsHidden(false)
}

export function removeOverlayDOM() {
  clearAllHighlights()
  removeHighlightContainer()
  lastDraw = null
  lastSelectedId = null
}

export function setClickThroughDOM(enabled: boolean) {
  _clickThroughActive = enabled
  const pointerEvents = enabled ? 'none' : 'auto'
  for (const el of highlightElements.values()) {
    el.style.pointerEvents = pointerEvents
  }
  if (enabled) {
    document.body.style.cursor = ''
  }
}

export function updateInstanceRects() {
  for (const instance of componentRegistry.values()) {
    if (
      instance.element &&
      instance.element.isConnected &&
      instance.element.nodeType === Node.ELEMENT_NODE
    ) {
      instance.rect = instance.element.getBoundingClientRect()
    }
  }
}

/** Push selected component to panel via RPC shared state */
export function pushSelectedComponentRPC(
  instance: ComponentInstance | null,
) {
  try {
    const ctx = getHostClientContext()
    if (!ctx?.rpc) return

    const data = instance
      ? {
          id: instance.id,
          meta: { ...instance.meta },
          ...(instance.serializedProps !== undefined
            ? { serializedProps: instance.serializedProps }
            : {}),
          isConnected: instance.element?.isConnected ?? false,
        }
      : null

    if (ctx.rpc.call) {
      ctx.rpc
        .call('component-highlighter:select-component', data)
        .catch(() => {})
    }

    if (ctx.rpc.sharedState) {
      ctx.rpc.sharedState
        .get('component-highlighter:selected-component')
        .then((state: any) =>
          state.mutate((s: any) => {
            s.value = data
          }),
        )
        .catch(() => {})
    }
  } catch {
    // RPC not available
  }
}

/**
 * Test/automation hook: select a component by its registry ID.
 */
export function selectComponentById(
  id: string,
  onSelect: (instance: ComponentInstance, x: number, y: number) => void,
): boolean {
  if (!componentRegistry) return false
  const instance = componentRegistry.get(id)
  if (!instance) return false
  if (instance.element?.isConnected) {
    instance.rect = instance.element.getBoundingClientRect()
  }
  const rect = instance.rect
  if (!rect) return false
  onSelect(instance, rect.left + rect.width / 2, rect.top + rect.height / 2)
  return true
}

// Invalidate story cache
export function invalidateStoryCache(componentPath: string) {
  storyFileCache.delete(componentPath)
}

function updateOpenStoriesButton(storyPath: string) {
  if (!contextMenuHandle) return
  contextMenuHandle.enableGoToStory(storyPath)
  contextMenuHandle.enableViewStory()
}

export function showStoryCreationFeedback(
  status: 'success' | 'error',
  filePath?: string,
  componentPath?: string,
): void {
  if (contextMenuHandle) {
    contextMenuHandle.showSaveFeedback(status)
  } else {
    debug('No context menu open for feedback (menu closed during recording)')
  }

  if (status === 'success') {
    debug('Story creation success feedback', filePath)

    if (componentPath) {
      invalidateStoryCache(componentPath)
      checkStoryFile(componentPath).then((storyInfo) => {
        if (storyInfo.hasStory && storyInfo.storyPath) {
          updateOpenStoriesButton(storyInfo.storyPath)
        }
      })
    }

    if (filePath) {
      updateOpenStoriesButton(filePath)
    }
  } else {
    debug('Story creation error feedback')
  }
}
