/// <reference path="../../runtime-module-shims.d.ts" />
/**
 * Vue runtime — non-intrusive devtools-hook detection.
 *
 * No component is wrapped and the SFC is not reconstructed. An inline <head>
 * script (src/frameworks/vue/devtools-hook.ts) installs a minimal
 * `__VUE_DEVTOOLS_GLOBAL_HOOK__` before the app boots; Vue's runtime-core then
 * reports every component mount/update/unmount through it. Here we subscribe to
 * those events (via the `window.__chInstallVueHandler` bridge), reconcile a
 * registry keyed by the live component instance, and emit the same
 * `component-highlighter:*` events + window globals the rest of the system
 * already consumes. Source identity comes from Vue's native `instance.type.__file`
 * / `__name` (stamped by @vitejs/plugin-vue in dev) — no injected metadata.
 *
 * This mirrors the React runtime (`src/frameworks/react/runtime-module.ts`):
 * hook event → resolve element + props → register/update/teardown → events,
 * with prop serialization lazily gated through the shared runtime-helpers.
 */
import {
  attachRectObservers,
  cancelScheduledSerialization,
  createLivePropEditor,
  findFirstTrackableElement,
  installLivePropEditGlobals,
  isTrackingActive,
  onListenersReady,
  onTrackingActivated,
  scheduleSerialization,
  setAtPath,
} from 'virtual:component-highlighter/runtime-helpers'
import { serializeVNodeToTemplate } from './vnode-to-template'
import { serializeValue } from './serialize-value'

// Injected by the virtual module loader.
declare const __COMPONENT_HIGHLIGHTER_DEBUG__: boolean
declare const __COMPONENT_HIGHLIGHTER_ROOT__: string

const DEBUG_MODE = __COMPONENT_HIGHLIGHTER_DEBUG__

// Expose debug flag to client modules (overlay, listeners, etc.)
if (typeof window !== 'undefined' && DEBUG_MODE) {
  window.__componentHighlighterDebug = true
}

const logDebug = (...args: unknown[]) => {
  if (DEBUG_MODE) {
    console.log('[component-highlighter-vue]', ...args)
  }
}

;(
  globalThis as typeof globalThis & { logDebug?: (...args: unknown[]) => void }
).logDebug = logDebug

const logError = (...args: unknown[]) => {
  console.error('[component-highlighter-vue]', ...args)
}

logDebug('Vue runtime loaded (devtools-hook mode)', { debug: DEBUG_MODE })

// ─── Types ───────────────────────────────────────────────────────────

type Meta = {
  componentName: string
  filePath: string
  relativeFilePath: string
  sourceId: string
  isDefaultExport: boolean
}

// Minimal shape of the Vue component internal instance we read from.
type VueInstance = {
  uid?: number
  type?: {
    __file?: string
    __name?: string
    name?: string
    emits?: unknown
    props?: unknown
  }
  vnode?: { el?: unknown; props?: Record<string, unknown> | null }
  subTree?: { el?: unknown }
  // The instance's internal props object. In dev it is shallow-reactive, so
  // assigning a top-level key re-renders the component — the same mechanism
  // the official Vue DevTools uses for its prop editor.
  props?: Record<string, unknown>
  proxy?: {
    $el?: unknown
    $props?: Record<string, unknown>
    $slots?: Record<string, ((props?: unknown) => unknown) | undefined>
  }
  slots?: Record<string, ((props?: unknown) => unknown) | undefined>
}

type RegistryInstance = {
  id: string
  meta: Meta
  props: Record<string, unknown>
  serializedProps: Record<string, unknown>
  element: Element
  rect?: DOMRect
}

// Component registry for tracking live instances.
const componentRegistry = new Map<string, RegistryInstance>()

// ─── Source identity (native __file / __name, no injected meta) ──────

/** Stable per-file hash used as the sourceId (path-based). */
function createHash(data: string): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

function basenameWithoutExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || filePath
  return base.replace(/\.(vue|tsx|ts|jsx|js)$/, '')
}

// Per-path meta cache (sourceId is stable per file).
const metaByFile = new Map<string, Meta>()
const componentSources = new Set<string>()

// Only SFCs accepted by the host's include/exclude filter register here.
// Dependency builds may contain absolute __file paths from another machine,
// so checking for node_modules in their native metadata is insufficient.
export function registerComponentSource(filePath: string) {
  componentSources.add(filePath.replace(/\\/g, '/'))
}

function getMeta(instance: VueInstance): Meta | null {
  const type = instance.type
  const filePath = type?.__file
  // SFC components stamped by @vitejs/plugin-vue carry an absolute __file. Skip
  // anything without one (built-in/functional/devtools-internal components).
  if (!filePath || typeof filePath !== 'string') return null
  if (!componentSources.has(filePath.replace(/\\/g, '/'))) return null

  const cached = metaByFile.get(filePath)
  if (cached) return cached

  const componentName =
    type?.__name || type?.name || basenameWithoutExt(filePath)
  const meta: Meta = {
    componentName,
    filePath,
    relativeFilePath: deriveRelativePath(filePath),
    sourceId: createHash(filePath),
    isDefaultExport: true,
  }
  metaByFile.set(filePath, meta)
  return meta
}

function deriveRelativePath(filePath: string): string {
  // Exact path: strip the project root injected by the virtual-module loader
  // (same result as the React transform's path.relative(process.cwd(), id)).
  const root = __COMPONENT_HIGHLIGHTER_ROOT__.replace(/\/+$/, '')
  if (root && filePath.startsWith(root + '/')) {
    return filePath.slice(root.length + 1)
  }
  // Fallbacks for files outside the root (e.g. linked packages): a stable
  // project-relative-ish path from /src/ onward, then the basename.
  const srcIdx = filePath.lastIndexOf('/src/')
  if (srcIdx !== -1) return filePath.slice(srcIdx + 1)
  return filePath.split(/[\\/]/).pop() || filePath
}

// ─── Prop / slot / emit extraction (unchanged behavior) ──────────────

function toListenerPropName(eventName: string): string {
  if (!eventName) return 'onUnknown'
  return `on${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}`
}

function extractDeclaredEmitNames(instance: VueInstance): Set<string> {
  const names = new Set<string>()
  const emits = instance.type?.emits

  if (Array.isArray(emits)) {
    for (const eventName of emits) {
      if (typeof eventName === 'string' && eventName) {
        names.add(eventName)
      }
    }
    return names
  }

  if (emits && typeof emits === 'object') {
    for (const key of Object.keys(emits as Record<string, unknown>)) {
      if (key) names.add(key)
    }
  }

  return names
}

function extractListenerProps(instance: VueInstance): Record<string, unknown> {
  const listenerProps: Record<string, unknown> = {}
  const vnodeProps = instance.vnode?.props ?? {}

  for (const [key, value] of Object.entries(vnodeProps)) {
    if (!key.startsWith('on')) continue
    if (key.length <= 2) continue
    if (key === 'onVnodeBeforeMount' || key === 'onVnodeMounted') continue
    if (
      key === 'onVnodeBeforeUpdate' ||
      key === 'onVnodeUpdated' ||
      key === 'onVnodeBeforeUnmount' ||
      key === 'onVnodeUnmounted'
    ) {
      continue
    }

    listenerProps[key] = value
  }

  return listenerProps
}

function extractSlotArgs(instance: VueInstance): Record<string, unknown> {
  const slotArgs: Record<string, unknown> = {}
  const slots = instance.slots ?? instance.proxy?.$slots ?? {}

  for (const [slotName, slotFn] of Object.entries(slots)) {
    if (!slotName || slotName.startsWith('_')) continue
    if (typeof slotFn !== 'function') continue

    try {
      const slotResult = slotFn({})
      const { source, componentRefs } = serializeVNodeToTemplate(
        slotResult,
        serializeValue,
      )

      slotArgs[`slot:${slotName}`] = source
        ? {
            __isVueSlot: true,
            source,
            componentRefs,
          }
        : slotName === 'default'
          ? 'Default slot content'
          : `${slotName} slot content`
    } catch {
      // Ignore slot evaluation errors and still expose slot control.
      slotArgs[`slot:${slotName}`] =
        slotName === 'default'
          ? 'Default slot content'
          : `${slotName} slot content`
    }
  }

  return slotArgs
}

function getStoryProps(
  instance: VueInstance,
  rawProps: Record<string, unknown>,
): Record<string, unknown> {
  const storyProps: Record<string, unknown> = { ...rawProps }

  const slotArgs = extractSlotArgs(instance)
  for (const [slotKey, slotValue] of Object.entries(slotArgs)) {
    if (!(slotKey in storyProps)) {
      storyProps[slotKey] = slotValue
    }
  }

  const declaredEmits = extractDeclaredEmitNames(instance)
  const listenerProps = extractListenerProps(instance)

  for (const [listenerName, listenerValue] of Object.entries(listenerProps)) {
    if (!(listenerName in storyProps)) {
      storyProps[listenerName] = listenerValue
    }

    if (listenerName.length > 2) {
      const eventName =
        listenerName.charAt(2).toLowerCase() + listenerName.slice(3)
      if (eventName) declaredEmits.add(eventName)
    }
  }

  for (const eventName of declaredEmits) {
    const listenerPropName = toListenerPropName(eventName)
    if (!(listenerPropName in storyProps)) {
      storyProps[listenerPropName] = () => undefined
    }
  }

  return storyProps
}


function serializeProps(props: Record<string, unknown>) {
  const serialized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    serialized[key] = serializeValue(value)
  }
  return serialized
}

// ─── Registry mutation + events (contract unchanged) ─────────────────

function dispatch(name: string, detail: unknown) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function registerInstance(
  id: string,
  meta: Meta,
  props: Record<string, unknown>,
  element: Element,
) {
  // Skip the expensive serialization until a DevTools client is connected.
  const serializedProps = isTrackingActive() ? serializeProps(props) : {}

  const instance: RegistryInstance = {
    id,
    meta,
    props,
    serializedProps,
    element,
  }
  componentRegistry.set(id, instance)

  logDebug('registerInstance', {
    id,
    componentName: meta.componentName,
    totalComponents: componentRegistry.size,
  })

  dispatch('component-highlighter:register', instance)
}

function unregisterInstance(id: string) {
  if (!componentRegistry.has(id)) return
  componentRegistry.delete(id)
  cancelScheduledSerialization(id)
  logDebug('unregistered', { id, remaining: componentRegistry.size })
  dispatch('component-highlighter:unregister', id)
}

// Serialize the instance's current props and notify listeners. Expensive —
// only ever run for live instances, coalesced to one call per frame.
function serializeAndDispatch(id: string) {
  const instance = componentRegistry.get(id)
  if (!instance) return
  instance.serializedProps = serializeProps(instance.props)
  logDebug('updateInstanceProps', { id, props: instance.props })
  dispatch('component-highlighter:update-props', {
    id,
    props: instance.props,
    serializedProps: instance.serializedProps,
  })
}

function updateInstanceProps(id: string, props: Record<string, unknown>) {
  const instance = componentRegistry.get(id)
  if (!instance) return
  // Keep raw props in sync immediately (cheap, read by the context menu).
  instance.props = props
  // Nothing consumes serialized props until DevTools connects.
  if (!isTrackingActive()) return
  // Defer the expensive serialization; collapse repeated updates per frame.
  scheduleSerialization(
    id,
    () => serializeAndDispatch(id),
    () => componentRegistry.has(id),
  )
}

// When DevTools connects after components already mounted, backfill the
// serialized props that registration skipped and push them to the panel.
onTrackingActivated(() => {
  for (const id of componentRegistry.keys()) {
    serializeAndDispatch(id)
  }
})

/**
 * Get the component registry for import resolution.
 * Returns a map of component name -> file path.
 */
export function getComponentRegistry() {
  const registry = new Map<string, string>()
  for (const instance of componentRegistry.values()) {
    registry.set(instance.meta.componentName || '', instance.meta.filePath)
  }
  return registry
}

// Expose the registry getter globally for story generation.
if (typeof window !== 'undefined') {
  ;(
    window as unknown as {
      __componentHighlighterGetRegistry?: () => Map<string, string>
    }
  ).__componentHighlighterGetRegistry = getComponentRegistry
}

// ─── Element resolution ──────────────────────────────────────────────

function resolveElement(instance: VueInstance): Element | null {
  let element: unknown =
    instance.proxy?.$el || instance.vnode?.el || instance.subTree?.el
  if (!element) return null

  let node = element as Node
  if (node.nodeType !== Node.ELEMENT_NODE) {
    logDebug('Component root is not an Element node', {
      nodeType: (node as Node).nodeType,
      nodeName: (node as Node).nodeName,
    })

    // Multi-root / text-root fallback: scan siblings for the first element.
    const children = node.parentNode?.childNodes
    if (children) {
      for (const child of Array.from(children)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          node = child
          break
        }
      }
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null
    }
  }

  return findFirstTrackableElement(node)
}

// ─── Hook-event driven reconciliation ────────────────────────────────
//
// One registry instance per live Vue component instance. We key by the live
// instance object (WeakMap), so the same instance keeps a stable id across
// updates and is torn down on removal.

const instanceIds = new WeakMap<VueInstance, string>()
// id → live internal instance, for live prop overrides. Entries are removed
// in teardownId, so this map's lifetime matches the registry's.
const instancesById = new Map<string, VueInstance>()
const rectDisconnects = new Map<string, () => void>()
let idCounter = 0

function getStableId(instance: VueInstance, meta: Meta): string {
  const existing = instanceIds.get(instance)
  if (existing) return existing
  const id = `${meta.sourceId}:${(idCounter++).toString(36)}`
  instanceIds.set(instance, id)
  return id
}

// ─── Live prop editing (reactive instance.props) ─────────────────────
//
// Vue has no renderer-level `overrideProps` API, but the internal
// `instance.props` object is shallow-reactive in dev: assigning a top-level
// key re-renders the component. This is the same mechanism the official Vue
// DevTools uses for its own prop editor. Because reactivity is shallow, a
// nested-path edit clones the top-level value (setAtPath) and reassigns it.
// All framework-agnostic machinery (payload decoding, original-value
// snapshots for reset, registry sync) is shared via createLivePropEditor.

const propEditor = createLivePropEditor({
  getInstance: (id) => componentRegistry.get(id),
  serializeValue,
  applyOverride: (id, path, value) => {
    const instance = instancesById.get(id)
    if (!instance) throw new Error('Component instance not found')
    const target = instance.props
    if (!target || typeof target !== 'object') {
      throw new Error('Live editing unavailable for this component')
    }
    const [head, ...rest] = path
    if (typeof head !== 'string') throw new Error('Invalid prop path')
    // Only declared props live on instance.props — writing anything else
    // (slot pseudo-props, listener props, fallthrough attrs) would be a
    // silent no-op for rendering, so reject it explicitly.
    const declaredProps = instance.type?.props
    const isDeclared =
      head in target ||
      (!!declaredProps &&
        typeof declaredProps === 'object' &&
        head in (declaredProps as Record<string, unknown>))
    if (!isDeclared) throw new Error(`"${head}" is not a declared prop`)

    if (rest.length === 0) {
      target[head] = value
    } else {
      const current = target[head]
      target[head] = setAtPath(
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)
          : {},
        rest,
        value,
      )
    }
    logDebug('overrideProp', { id, path, value })
  },
})

installLivePropEditGlobals(propEditor, () => true)

function attachRect(id: string, element: Element) {
  rectDisconnects.get(id)?.()
  const disconnect = attachRectObservers(
    (lookupId) => componentRegistry.get(lookupId),
    id,
    element,
  )
  rectDisconnects.set(id, disconnect)
  const inst = componentRegistry.get(id)
  if (inst) inst.rect = element.getBoundingClientRect()
}

function teardownId(id: string) {
  rectDisconnects.get(id)?.()
  rectDisconnects.delete(id)
  instancesById.delete(id)
  propEditor.forgetInstance(id)
  unregisterInstance(id)
}

function handleAddedOrUpdated(instance: VueInstance) {
  const meta = getMeta(instance)
  if (!meta) return // not an SFC component with a source path — skip

  const element = resolveElement(instance)
  if (!element) {
    logDebug('Could not resolve element for', meta.componentName)
    return
  }

  const rawProps = instance.proxy?.$props || {}
  const storyProps = getStoryProps(instance, rawProps)

  const id = getStableId(instance, meta)
  instancesById.set(id, instance)
  const existing = componentRegistry.get(id)
  if (!existing) {
    registerInstance(id, meta, storyProps, element)
    attachRect(id, element)
  } else {
    if (existing.element !== element) {
      existing.element = element
      attachRect(id, element)
    }
    updateInstanceProps(id, storyProps)
  }
}

function handleRemoved(instance: VueInstance) {
  const id = instanceIds.get(instance)
  if (!id) return
  instanceIds.delete(instance)
  teardownId(id)
}

// The Vue devtools emit signature for component events is
// `emit(event, app, uid, parentUid, instance)` — the live instance is args[3].
function handleVueEvent(event: string, args: unknown[]) {
  const instance = args[3] as VueInstance | undefined
  if (!instance || typeof instance !== 'object') return
  try {
    switch (event) {
      case 'component:added':
      case 'component:updated':
        handleAddedOrUpdated(instance)
        break
      case 'component:removed':
        handleRemoved(instance)
        break
      default:
        break
    }
  } catch (err) {
    logError('vue event handling failed:', err)
  }
}

// Instances registered before the client listeners module loaded dispatched
// register events into the void — replay the registry when it announces
// readiness so the initial page highlights without needing a navigation.
onListenersReady(() => {
  for (const instance of componentRegistry.values()) {
    dispatch('component-highlighter:register', instance)
  }
})

// ─── Install the bridge ──────────────────────────────────────────────

if (typeof window !== 'undefined') {
  const install = (
    window as unknown as {
      __chInstallVueHandler?: (
        fn: (event: string, args: unknown[]) => void,
      ) => void
    }
  ).__chInstallVueHandler
  if (typeof install === 'function') {
    install(handleVueEvent)
  } else {
    logError(
      'Vue DevTools hook bridge missing — was the inline <head> script injected?',
    )
  }
}

export default {
  getComponentRegistry,
}
