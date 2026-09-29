/**
 * Serialize a single value (handles Vue reactive objects).
 */
export function serializeValue(
  value: unknown,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet(),
): unknown {
  // Handle Vue reactive objects
  if (value && typeof value === 'object') {
    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      // Vue ref or reactive object
      try {
        return JSON.parse(
          JSON.stringify(
            (value as { toJSON?: () => unknown }).toJSON?.() ?? value,
          ),
        )
      } catch {
        return undefined
      }
    } else if (Array.isArray(value)) {
      if (ancestors.has(value)) return '[Circular]'
      if (depth >= 6) return '[Depth limit]'
      ancestors.add(value)
      try {
        return value.map((item) => serializeValue(item, depth + 1, ancestors))
      } finally {
        ancestors.delete(value)
      }
    } else {
      const proto = Object.getPrototypeOf(value)
      if (proto === Object.prototype || proto === null) {
        if (ancestors.has(value)) return '[Circular]'
        if (depth >= 6) return '[Depth limit]'
        ancestors.add(value)
        try {
          const serialized: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            serialized[k] = serializeValue(v, depth + 1, ancestors)
          }
          return serialized
        } finally {
          ancestors.delete(value)
        }
      }
      // Non-plain object (Map, Set, class instance, …): not round-trippable to
      // a story arg nor reliably cloneable over RPC. Mark it (read-only in the
      // UI) rather than leaking the live object onto the wire.
      return {
        __isObject: true,
        name:
          (value as { constructor?: { name?: string } }).constructor?.name ||
          'Object',
      }
    }
  }

  // Handle functions - return a placeholder
  if (typeof value === 'function') {
    return {
      __isFunction: true,
      name: (value as { name?: string }).name || 'anonymous',
    }
  }

  // Primitives pass through
  return value
}
