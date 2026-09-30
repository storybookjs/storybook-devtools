/// <reference path="../../runtime-module-shims.d.ts" />
/**
 * React runtime — non-intrusive fiber detection.
 *
 * No component is wrapped. The transform only tags component functions with a
 * metadata symbol via `__chRegisterMeta`. Here we install a commit handler on
 * the React DevTools global hook (bootstrapped by an inline <head> script) and
 * walk the live fiber tree on every commit, reconciling a registry and
 * emitting the same `component-highlighter:*` events the rest of the system
 * already consumes. The rendered tree and DOM are left untouched, so this also
 * works with React Server Components (only tagged client components appear).
 */
import React from 'react'
import { captureReactComponentTree } from './component-tree'
import reactElementToJSXString from 'react-element-to-jsx-string/dist/esm/index.js'
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
} from 'virtual:component-highlighter/runtime-helpers'

declare const __COMPONENT_HIGHLIGHTER_DEBUG__: boolean

const DEBUG_MODE = __COMPONENT_HIGHLIGHTER_DEBUG__

if (typeof window !== 'undefined' && DEBUG_MODE) {
  window.__componentHighlighterDebug = true
}

const logDebug = (...args: unknown[]) => {
  if (DEBUG_MODE) console.log('[component-highlighter]', ...args)
}
;(
  globalThis as typeof globalThis & { logDebug?: (...args: unknown[]) => void }
).logDebug = logDebug

const logError = (...args: unknown[]) => {
  console.error('[component-highlighter]', ...args)
}

logDebug('React runtime loaded (fiber mode)', { debug: DEBUG_MODE })

// ─── Metadata tag ────────────────────────────────────────────────────
//
// The transform calls __chRegisterMeta(Component, meta). We attach a
// non-enumerable symbol to the function (and unwrap memo/forwardRef) so the
// fiber walker can recover the build-time source identity.

const CH_META = Symbol.for('component-highlighter.meta')

type Meta = {
  componentName: string
  filePath: string
  relativeFilePath?: string
  sourceId: string
  isDefaultExport?: boolean
}

function tagValue(target: unknown, meta: Meta, depth: number) {
  if (depth > 4) return
  if (
    !target ||
    (typeof target !== 'function' && typeof target !== 'object')
  ) {
    return
  }
  const obj = target as Record<PropertyKey, unknown>
  if (!Object.prototype.hasOwnProperty.call(obj, CH_META)) {
    try {
      Object.defineProperty(obj, CH_META, {
        value: meta,
        configurable: true,
        enumerable: false,
      })
    } catch {
      try {
        obj[CH_META] = meta
      } catch {
        // frozen component — nothing we can do, skip silently
      }
    }
  }
  // Unwrap React.memo / React.forwardRef containers.
  if ('type' in obj) tagValue(obj['type'], meta, depth + 1)
  if ('render' in obj) tagValue(obj['render'], meta, depth + 1)
}

export function __chRegisterMeta<T>(component: T, meta: Meta): T {
  try {
    tagValue(component, meta, 0)
  } catch {
    // tagging must never break the host app
  }
  return component
}

// ─── Registry ────────────────────────────────────────────────────────

type ReactElement = any
type RegistryInstance = {
  id: string
  meta: Meta
  props: Record<string, unknown>
  serializedProps: Record<string, unknown>
  element: Element | null
  rect?: DOMRect
}

const componentRegistry = new Map<string, RegistryInstance>()

let idCounter = 0
function generateInstanceId(sourceId: string) {
  return `${sourceId}:${(idCounter++).toString(36)}`
}

// ─── Prop serialization (unchanged behavior) ─────────────────────────

function getComponentName(type: unknown): string {
  if (typeof type === 'string') return type
  const normalizeDisplayName = (name: string): string => {
    const hocMatch = name.match(/^(?:with\w+|memo|forwardRef)\((.+)\)$/)
    if (hocMatch && hocMatch[1]) return normalizeDisplayName(hocMatch[1])
    const wrapperMatch = name.match(/^([A-Z][A-Za-z0-9_$]*)\(([^)]+)\)$/)
    if (!wrapperMatch) return name
    const prefix = wrapperMatch[1]
    const innerRaw = wrapperMatch[2]
    if (!prefix || !innerRaw) return name
    const parts = innerRaw.match(/[A-Za-z0-9_$]+/g)
    if (!parts || parts.length === 0) return prefix
    const normalizedInner = parts
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
    return `${prefix}${normalizedInner}`
  }
  const metaName = (type as Record<PropertyKey, unknown>)?.[CH_META] as
    | Meta
    | undefined
  if (metaName?.componentName) return metaName.componentName
  if (typeof type === 'function') {
    const displayName = (type as { displayName?: string }).displayName
    if (displayName) return normalizeDisplayName(displayName)
    return (type as { name?: string }).name || 'Unknown'
  }
  if (type && typeof type === 'object') {
    const o = type as Record<PropertyKey, any>
    if (o[CH_META]?.componentName) return o[CH_META].componentName
    if (o['displayName']) return normalizeDisplayName(o['displayName'])
    if (o['render']) return getComponentName(o['render'])
    if (o['type']) return getComponentName(o['type'])
  }
  return 'Unknown'
}

function isValidElement(value: unknown): boolean {
  return React.isValidElement(value)
}

function extractComponentRefs(
  element: unknown,
  refs = new Set<string>(),
): Set<string> {
  // Children can be arbitrarily nested arrays (e.g. `tasks.map(...)` rendered
  // alongside a sibling element produces `[[<TaskCard/>...], <Button/>]`).
  // Recurse through arrays at any depth so refs aren't dropped.
  if (Array.isArray(element)) {
    for (const item of element) extractComponentRefs(item, refs)
    return refs
  }
  if (!isValidElement(element)) return refs
  const node = element as ReactElement
  const name = getComponentName(node.type)
  if (typeof node.type !== 'string' && typeof name === 'string') {
    const first = name.charAt(0)
    if (first && first === first.toUpperCase()) refs.add(name)
  }
  const children = node.props?.children
  if (children) {
    if (Array.isArray(children)) {
      children.forEach((c) => extractComponentRefs(c, refs))
    } else if (isValidElement(children)) {
      extractComponentRefs(children, refs)
    }
  }
  Object.entries(node.props || {}).forEach(([key, value]) => {
    if (key !== 'children' && isValidElement(value)) {
      extractComponentRefs(value, refs)
    }
  })
  return refs
}

const jsxStringOptions = {
  showDefaultProps: false,
  showFunctions: false,
  sortProps: true,
  useBooleanShorthandSyntax: true,
  useFragmentShortSyntax: true,
  displayName: (el: ReactElement) => {
    const ty = (el as { type?: unknown }).type as unknown
    if (typeof ty === 'string') return ty
    return getComponentName(ty)
  },
}

// React-reserved props that are never valid Storybook args.
const RESERVED_PROPS = new Set(['ref', 'key'])

const MAX_SERIALIZE_DEPTH = 6

function serializeValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  // DOM nodes / Window are deeply self-referential — serializing or
  // transferring them over RPC blows the stack ("Maximum call stack size
  // exceeded"). This is hit by e.g. a forwardRef's `ref` ({ current: <node> })
  // or any prop holding an element. Replace with a safe marker.
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return '[DOM node]'
  }
  if (typeof Window !== 'undefined' && value instanceof Window) {
    return '[Window]'
  }
  if (value instanceof Date) {
    return { __isDate: true, iso: value.toISOString() }
  }
  if (isValidElement(value)) {
    try {
      const source = reactElementToJSXString(value, jsxStringOptions)
      return {
        __isJSX: true,
        source,
        componentRefs: Array.from(extractComponentRefs(value)),
      }
    } catch (err) {
      logError(
        'Failed to serialize JSX element:',
        (err as { message?: string })?.message || err,
      )
      return { __isJSX: true, source: '{/* Failed to serialize */}', componentRefs: [] }
    }
  }
  if (Array.isArray(value)) {
    const hasJSX = value.some((item) => isValidElement(item))
    if (hasJSX) {
      try {
        const fragment = React.createElement(
          React.Fragment,
          null,
          ...(value as unknown[]),
        )
        const source = reactElementToJSXString(fragment, {
          ...jsxStringOptions,
          showFunctions: true,
        })
        const componentRefs = new Set<string>()
        // extractComponentRefs is array-aware; passing the whole value (which
        // may contain nested arrays like a mapped list) recurses correctly.
        extractComponentRefs(value, componentRefs)
        return {
          __isJSX: true,
          source,
          componentRefs: Array.from(componentRefs),
        }
      } catch (err) {
        logError(
          'Failed to serialize JSX array:',
          (err as { message?: string })?.message || err,
        )
        return { __isJSX: true, source: '{/* Failed to serialize */}', componentRefs: [] }
      }
    }
    if (depth >= MAX_SERIALIZE_DEPTH) return '[Depth limit]'
    if (seen.has(value)) return '[Circular]'
    seen.add(value as object)
    return (value as unknown[]).map((item) =>
      serializeValue(item, depth + 1, seen),
    )
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      if (depth >= MAX_SERIALIZE_DEPTH) return '[Depth limit]'
      if (seen.has(value as object)) return '[Circular]'
      seen.add(value as object)
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = serializeValue(v, depth + 1, seen)
      }
      return out
    }
    // Non-plain object (Map, Set, class instance, …): not round-trippable to a
    // story arg nor reliably cloneable over RPC. Mark it (read-only in the UI)
    // rather than leaking the live object onto the wire.
    return {
      __isObject: true,
      name:
        (value as { constructor?: { name?: string } }).constructor?.name ||
        'Object',
    }
  }
  if (typeof value === 'function') {
    return { __isFunction: true, name: (value as { name?: string }).name || 'anonymous' }
  }
  return value
}

function serializeProps(props: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    // `ref`/`key` are React plumbing (forwardRef receives `ref` as a prop in
    // React 19) — never valid story args, and a live `ref` holds a DOM node.
    if (RESERVED_PROPS.has(key)) continue
    out[key] = serializeValue(value)
  }
  return out
}

// ─── Registry mutation + events ──────────────────────────────────────

function dispatch(name: string, detail: unknown) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function registerInstance(
  id: string,
  meta: Meta,
  props: Record<string, unknown>,
  element: Element | null,
) {
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
    total: componentRegistry.size,
  })
  dispatch('component-highlighter:register', instance)
}

function unregisterInstance(id: string) {
  if (!componentRegistry.has(id)) return
  componentRegistry.delete(id)
  cancelScheduledSerialization(id)
  logDebug('unregister', { id, remaining: componentRegistry.size })
  dispatch('component-highlighter:unregister', id)
}

function serializeAndDispatch(id: string) {
  const instance = componentRegistry.get(id)
  if (!instance) return
  instance.serializedProps = serializeProps(instance.props)
  dispatch('component-highlighter:update-props', {
    id,
    props: instance.props,
    serializedProps: instance.serializedProps,
  })
}

function updateInstanceProps(id: string, props: Record<string, unknown>) {
  const instance = componentRegistry.get(id)
  if (!instance) return
  instance.props = props
  if (!isTrackingActive()) return
  scheduleSerialization(
    id,
    () => serializeAndDispatch(id),
    () => componentRegistry.has(id),
  )
}

// When DevTools connects after components already mounted, backfill the
// serialized props that registration skipped while tracking was off.
onTrackingActivated(() => {
  for (const id of componentRegistry.keys()) serializeAndDispatch(id)
})

export function getComponentRegistry() {
  const registry = new Map<string, string>()
  for (const instance of componentRegistry.values()) {
    registry.set(instance.meta.componentName || '', instance.meta.filePath)
  }
  return registry
}

if (typeof window !== 'undefined') {
  ;(
    window as unknown as {
      __componentHighlighterGetRegistry?: () => Map<string, string>
    }
  ).__componentHighlighterGetRegistry = getComponentRegistry
}

// ─── Fiber walking ───────────────────────────────────────────────────

type Fiber = any

function readMeta(fiber: Fiber): Meta | null {
  const candidates = [fiber.type, fiber.elementType]
  for (const c of candidates) {
    if (c && typeof c === 'object' && c[CH_META]) return c[CH_META] as Meta
    if (typeof c === 'function' && (c as any)[CH_META]) {
      return (c as any)[CH_META] as Meta
    }
  }
  return null
}

function isHostFiber(fiber: Fiber): boolean {
  const sn = fiber?.stateNode
  return !!sn && typeof Element !== 'undefined' && sn instanceof Element
}

// Nearest host DOM element rendered by this component's subtree. Descends
// THROUGH same-sourceId wrapper layers (memo/forwardRef of the same
// component) but stops at a genuinely different nested component (it owns
// its own host).
function findHostElement(fiber: Fiber, ownSourceId: string): Element | null {
  const stack: Fiber[] = []
  let child = fiber.child
  while (child) {
    stack.push(child)
    child = child.sibling
  }
  while (stack.length) {
    const node = stack.shift()
    if (isHostFiber(node)) return node.stateNode as Element
    const m = readMeta(node)
    // A different nested component owns its own host — don't descend.
    // Same-sourceId node = a wrapper layer of *this* component — descend.
    if (m && m.sourceId !== ownSourceId) continue
    let c = node.child
    while (c) {
      stack.push(c)
      c = c.sibling
    }
  }
  return null
}

// Stable instance id per fiber, mirrored across the alternate so it survives
// double-buffered commits.
const fiberIds = new WeakMap<Fiber, string>()

function getStableId(fiber: Fiber, meta: Meta): string {
  let id = fiberIds.get(fiber)
  if (id) return id
  if (fiber.alternate && fiberIds.has(fiber.alternate)) {
    id = fiberIds.get(fiber.alternate) as string
  } else {
    id = generateInstanceId(meta.sourceId)
  }
  fiberIds.set(fiber, id)
  if (fiber.alternate) fiberIds.set(fiber.alternate, id)
  return id
}

// Track which ids each root currently owns + per-instance rect observers.
const rootLiveIds = new WeakMap<object, Set<string>>()
// Retain only roots with tracked instances; an unmount commit removes them.
const treeRoots = new Set<Fiber>()
const rectDisconnects = new Map<string, () => void>()
const instanceElements = new Map<string, Element | null>()

function attachRect(id: string, element: Element | null) {
  const prev = instanceElements.get(id)
  if (prev === element) return
  rectDisconnects.get(id)?.()
  rectDisconnects.delete(id)
  instanceElements.set(id, element)
  if (element) {
    const disconnect = attachRectObservers(
      (lookupId) =>
        componentRegistry.get(lookupId) as
          | { element?: Element; rect?: DOMRect }
          | undefined,
      id,
      element,
    )
    rectDisconnects.set(id, disconnect)
    const inst = componentRegistry.get(id)
    if (inst) inst.rect = (element as HTMLElement).getBoundingClientRect()
  }
}

// id → latest current-tree fiber, for live prop overrides.
const fibersById = new Map<string, Fiber>()
// The react-dom renderer object registered on the DevTools hook. It exposes
// `overrideProps` in dev builds — the exact API React DevTools' props editor
// uses. Captured on first commit.
let reactRenderer: any = null

function teardownId(id: string) {
  rectDisconnects.get(id)?.()
  rectDisconnects.delete(id)
  instanceElements.delete(id)
  fibersById.delete(id)
  propEditor.forgetInstance(id)
  unregisterInstance(id)
}

function walkRoot(root: Fiber) {
  const current = root?.current
  if (!current) return

  const seen = new Map<
    string,
    {
      meta: Meta
      props: Record<string, unknown>
      element: Element | null
      fiber: Fiber
    }
  >()

  // Iterative DFS carrying the nearest *contiguous* tagged ancestor's
  // sourceId. `memo(forwardRef(fn))` yields two tagged fibers (Memo wrapper +
  // ForwardRef inner) with the SAME sourceId and no host between them — they
  // are ONE component instance, so the inner wrapper layer is collapsed into
  // the outer (which findHostElement anchors to the real DOM). Crossing a
  // host fiber resets the chain, so a genuinely recursive component (e.g.
  // <Tree> inside <Tree>) still registers every level.
  const work: Array<{ fiber: Fiber; parentSourceId: string | null }> = [
    { fiber: current, parentSourceId: null },
  ]
  while (work.length) {
    const item = work.pop()
    if (!item) continue
    const { fiber } = item
    let parentSourceId = item.parentSourceId

    const meta = readMeta(fiber)
    if (meta) {
      if (parentSourceId && meta.sourceId === parentSourceId) {
        // Inner wrapper layer of the same component — already registered by
        // the outer fiber; do not create a duplicate instance.
      } else {
        const id = getStableId(fiber, meta)
        if (!seen.has(id)) {
          seen.set(id, {
            meta,
            props: (fiber.memoizedProps || {}) as Record<string, unknown>,
            element: findHostElement(fiber, meta.sourceId),
            fiber,
          })
        }
        parentSourceId = meta.sourceId
      }
    }
    // A host element between two same-sourceId components means they are
    // distinct instances (recursion), not a wrapper chain.
    if (isHostFiber(fiber)) parentSourceId = null

    if (fiber.sibling) {
      work.push({ fiber: fiber.sibling, parentSourceId: item.parentSourceId })
    }
    if (fiber.child) {
      work.push({ fiber: fiber.child, parentSourceId })
    }
  }

  const prevIds = rootLiveIds.get(root) || new Set<string>()
  const nextIds = new Set(seen.keys())

  // Removed
  for (const id of prevIds) {
    if (!nextIds.has(id)) teardownId(id)
  }

  // Added / updated
  for (const [id, data] of seen) {
    const rawElement = data.element
    const element = rawElement
      ? findFirstTrackableElement(rawElement) || rawElement
      : null
    fibersById.set(id, data.fiber)
    if (!componentRegistry.has(id)) {
      registerInstance(id, data.meta, data.props, element)
      attachRect(id, element)
    } else {
      attachRect(id, element)
      const inst = componentRegistry.get(id)
      if (inst) inst.element = element
      updateInstanceProps(id, data.props)
    }
  }

  rootLiveIds.set(root, nextIds)
  if (nextIds.size) treeRoots.add(root)
  else treeRoots.delete(root)
}

function getRenderedComponentTree(maxNodes = 500) {
  const identities = new Map()
  for (const [id, fiber] of fibersById) {
    const instance = componentRegistry.get(id)
    if (instance) identities.set(fiber, { id, meta: instance.meta })
  }
  return captureReactComponentTree(
    Array.from(treeRoots, root => root.current), identities, maxNodes,
  )
}

function handleCommit(rendererId: number, root: Fiber) {
  // Capture the react-dom renderer (exposes `overrideProps` in dev builds).
  // Multiple renderers can register on one hook — e.g. Next's App Router
  // registers a react-dom instance without `overrideProps` alongside the
  // real client one, plus react-server-dom-webpack's flight renderer for
  // RSC. Keep checking each commit's renderer until one actually exposes
  // `overrideProps`, instead of latching onto whichever committed first.
  if (
    (!reactRenderer || typeof reactRenderer.overrideProps !== 'function') &&
    typeof window !== 'undefined'
  ) {
    try {
      const hook = (
        window as unknown as {
          __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
            renderers?: Map<number, unknown>
          }
        }
      ).__REACT_DEVTOOLS_GLOBAL_HOOK__
      reactRenderer = hook?.renderers?.get(rendererId) ?? reactRenderer
    } catch {
      // ignore — overrides will report unavailable
    }
  }
  // Walk synchronously on commit. React batches a render pass into a single
  // commit, so this is one traversal per render pass (not a per-setState
  // storm); keeping it synchronous preserves deterministic register/update
  // event ordering that the overlay + panel state machine depend on. The
  // expensive prop serialization stays gated by `isTrackingActive()`.
  try {
    walkRoot(root)
  } catch (err) {
    logError('fiber walk failed:', err)
  }
}

// ─── Live prop editing (React DevTools `overrideProps`) ──────────────────
//
// All framework-agnostic machinery (payload decoding, original-value
// snapshots for reset, registry/serialized-props sync) lives in the shared
// runtime-helpers `createLivePropEditor`. The React-specific part is applying
// the override through the react-dom renderer captured off the DevTools hook.

const propEditor = createLivePropEditor({
  getInstance: (id) => componentRegistry.get(id),
  serializeValue,
  applyOverride: (id, path, value) => {
    const fiber = fibersById.get(id)
    if (!fiber) throw new Error('Component instance not found')
    if (!reactRenderer || typeof reactRenderer.overrideProps !== 'function') {
      throw new Error(
        'Live editing unavailable (production React build or unsupported version)',
      )
    }
    reactRenderer.overrideProps(fiber, path, value)
    logDebug('overrideProp', { id, path, value })
  },
})

installLivePropEditGlobals(
  propEditor,
  () => !!reactRenderer && typeof reactRenderer.overrideProps === 'function',
)

// Instances committed before the client listeners module loaded dispatched
// register events into the void — replay the registry when it announces
// readiness so the initial page highlights without needing a navigation.
onListenersReady(() => {
  for (const instance of componentRegistry.values()) {
    dispatch('component-highlighter:register', instance)
  }
})

if (typeof window !== 'undefined') {
  // Queried by the existing trusted client RPC. No props or DOM references
  // leave this getter; connection state is sampled on each request.
  ;(window as unknown as {
    __componentHighlighterGetComponentTree?: typeof getRenderedComponentTree
  }).__componentHighlighterGetComponentTree = getRenderedComponentTree
  const install = (
    window as unknown as {
      __chInstallCommitHandler?: (
        fn: (id: number, root: unknown) => void,
      ) => void
    }
  ).__chInstallCommitHandler
  if (typeof install === 'function') {
    install(handleCommit)
  } else {
    logError(
      'React DevTools hook bridge missing — was the inline <head> script injected?',
    )
  }
}
