import type { RenderedComponentTree, ComponentTreeNode } from '../../shared-types'

/** Only the committed tree links and host node are needed, not React tag numbers. */
export interface TreeFiber {
  child?: TreeFiber | null
  sibling?: TreeFiber | null
  stateNode?: unknown
}

type Identity = Pick<ComponentTreeNode, 'id' | 'meta'>

/** Read component ancestry from fibers and page membership from connected DOM.
 * The identity map comes from the existing walker, so memo/forwardRef layers
 * retain its deduplication and the IDs remain usable by instance inspection.
 * No layout/viewport/style checks: offscreen and CSS-hidden DOM are included.
 */
export function captureReactComponentTree(
  roots: Iterable<TreeFiber>,
  identities: ReadonlyMap<TreeFiber, Identity>,
  maxNodes = 500,
): RenderedComponentTree {
  const nodes: ComponentTreeNode[] = []
  const rendered = new Set<string>()
  const work: Array<{ fiber: TreeFiber; parentId: string | null }> =
    Array.from(roots, fiber => ({ fiber, parentId: null })).reverse()

  while (work.length) {
    const { fiber, parentId } = work.pop()!
    let ownerId = parentId
    const identity = identities.get(fiber)
    if (identity) {
      const entry = { id: identity.id, meta: { ...identity.meta }, parentId }
      nodes.push(entry)
      ownerId = entry.id
    }
    const host = fiber.stateNode
    if (ownerId && typeof Node !== 'undefined' && host instanceof Node &&
      (host.nodeType === 1 || host.nodeType === 3) && host.isConnected) {
      rendered.add(ownerId)
    }
    // Portals/fragments are traversed just like other fibers. The DOM's parent
    // element is intentionally never used to determine component ownership.
    if (fiber.sibling) work.push({ fiber: fiber.sibling, parentId })
    if (fiber.child) work.push({ fiber: fiber.child, parentId: ownerId })
  }

  // Retain transparent ancestors with rendered descendants. Reverse DFS order
  // propagates membership up the tree in linear time, including deep wrappers.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const entry = nodes[i]!
    if (rendered.has(entry.id) && entry.parentId) rendered.add(entry.parentId)
  }
  const included = nodes.filter(entry => rendered.has(entry.id))
  // A parent-first prefix cannot contain a child without its parent.
  const bounded = included.slice(0, maxNodes)
  return {
    framework: 'react',
    rootIds: bounded.filter(entry => entry.parentId === null).map(entry => entry.id),
    nodes: bounded,
    totalNodes: included.length,
    truncated: included.length > bounded.length,
  }
}
