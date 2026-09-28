import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureReactComponentTree, type TreeFiber } from './component-tree'

class DomNode {
  constructor(public nodeType = 1, public isConnected = true) {}
}
const node = (children: TreeFiber[] = [], stateNode?: unknown): TreeFiber => {
  children.forEach((child, i) => { child.sibling = children[i + 1] ?? null })
  return { child: children[0] ?? null, stateNode }
}
const dom = (connected = true, type = 1) => node([], new DomNode(type, connected))
const meta = (name: string) => ({ componentName: name, filePath: `/app/${name}.tsx`, sourceId: name })

describe('React rendered component tree', () => {
  afterEach(() => vi.unstubAllGlobals())
  function capture(roots: TreeFiber[], entries: Array<[TreeFiber, string]>, limit?: number) {
    vi.stubGlobal('Node', DomNode)
    return captureReactComponentTree(roots, new Map(entries.map(([fiber, id]) => [fiber, { id, meta: meta(id) }])), limit)
  }

  it('preserves component parents across DOM, uninstrumented wrappers, fragments and portals', () => {
    // The portal host is connected elsewhere in the DOM, with no containment
    // relationship to the app. Component ancestry must still come from fibers.
    const portalChild = node([dom()])
    const portal = node([portalChild], { containerInfo: new DomNode() })
    const fragment = node([dom(false), dom()])
    const text = node([dom(true, 3)])
    const empty = node()
    const commentOnly = node([dom(true, 8)])
    const wrapper = node([node([fragment, portal, text, empty, commentOnly], new DomNode())])
    const app = node([wrapper])
    const tree = capture([node([app])], [[app, 'App'], [wrapper, 'Wrapper'], [fragment, 'Fragment'], [portalChild, 'Modal'], [text, 'Text'], [empty, 'Empty'], [commentOnly, 'Comment']])
    expect(tree.rootIds).toEqual(['App'])
    expect(tree.nodes.map(n => [n.id, n.parentId])).toEqual([
      ['App', null], ['Wrapper', 'App'], ['Fragment', 'Wrapper'], ['Modal', 'Wrapper'], ['Text', 'Wrapper'],
    ])
    expect(tree.totalNodes).toBe(5)
    expect(tree.truncated).toBe(false)
  })

  it('includes connected DOM regardless of layout or viewport, and samples connection state afresh', () => {
    const element = new DomNode()
    const offscreen = node([node([], element)])
    const disconnected = node([dom(false)])
    const root = node([offscreen, disconnected])
    const entries: Array<[TreeFiber, string]> = [[offscreen, 'Offscreen'], [disconnected, 'Detached']]
    expect(capture([root], entries).nodes.map(n => n.id)).toEqual(['Offscreen'])
    element.isConnected = false
    expect(capture([root], entries).nodes).toEqual([])
  })

  it('keeps multiple roots and repeated instances distinct; uses only registered wrapper identities', () => {
    const first = node([node([dom()])]) // unregistered memo/forwardRef layer
    const second = node([dom()])
    const tree = capture([node([first]), node([second])], [[first, 'Button:1'], [second, 'Button:2']])
    expect(tree.rootIds).toEqual(['Button:1', 'Button:2'])
    expect(tree.nodes).toHaveLength(2)
  })

  it('caps output in parent-first order without orphan references and reports the complete count', () => {
    const leaf = node([dom()])
    const child = node([leaf])
    const root = node([child])
    const tree = capture([root], [[root, 'Root'], [child, 'Child'], [leaf, 'Leaf']], 2)
    expect(tree.nodes.map(n => n.id)).toEqual(['Root', 'Child'])
    expect(tree.totalNodes).toBe(3)
    expect(tree.truncated).toBe(true)
    expect(tree.rootIds).toEqual(['Root'])
  })

  it('reflects unmounts and changed relationships on subsequent snapshots', () => {
    const leaf = node([dom()])
    const before = node([leaf])
    expect(capture([before], [[before, 'Parent'], [leaf, 'Leaf']]).nodes[1]?.parentId).toBe('Parent')
    expect(capture([leaf], [[leaf, 'Leaf']]).nodes[0]?.parentId).toBe(null)
    expect(capture([node()], []).nodes).toEqual([])
  })
})
