/**
 * Shared types used by both server-side plugin and client-side code.
 * Kept in a separate file to avoid importing server modules from client code.
 */
import type { SerializedProps } from './frameworks/types'

/**
 * Serialized component instance — safe for RPC transfer (no DOM refs,
 * functions, or circular structures).
 *
 * Only `serializedProps` crosses the wire: it is the RPC-safe projection of the
 * live props (DOM nodes → markers, functions → `{__isFunction}`, JSX → source
 * strings). The raw live props are intentionally NOT included — they hold
 * unclonable values, and every consumer (story generation, panel display,
 * fingerprinting) reads `serializedProps`.
 */
export interface SerializedRegistryInstance {
  id: string
  meta: {
    componentName: string
    filePath: string
    relativeFilePath?: string
    sourceId: string
    isDefaultExport?: boolean
  }
  serializedProps?: SerializedProps
  isConnected: boolean
  /** React subtree has connected DOM, including components with no own anchor. */
  isRendered?: boolean
  /**
   * Top-level prop keys whose current value differs from their original
   * (pre-edit) value — i.e. props the user has live-edited. Lets the panel
   * show a per-prop "reset to original" affordance. React-only; absent for
   * frameworks without live prop editing.
   */
  editedProps?: string[]
}

/** Compact parent-first forest; parentId is the nearest instrumented ancestor. */
export interface ComponentTreeNode {
  id: string
  parentId: string | null
  meta: SerializedRegistryInstance['meta']
}

export interface RenderedComponentTree {
  framework: 'react'
  rootIds: string[]
  nodes: ComponentTreeNode[]
  totalNodes: number
  truncated: boolean
}

/** Incremental diff for syncing registry changes from client to server */
export interface RegistryDiff {
  added: SerializedRegistryInstance[]
  removed: string[]
  updated: SerializedRegistryInstance[]
  /** When true, `added` replaces the entire registry (not appended). */
  fullSync?: boolean
}
