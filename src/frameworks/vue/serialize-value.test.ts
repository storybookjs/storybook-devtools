import { describe, expect, it } from 'vitest'
import { serializeValue } from './serialize-value'

describe('Vue prop serialization', () => {
  it('serializes circular objects and arrays without overflowing the stack', () => {
    const object: Record<string, unknown> = { label: 'Nuxt context' }
    object['self'] = object
    const array: unknown[] = [object]
    array.push(array)
    expect(serializeValue(array)).toEqual([
      { label: 'Nuxt context', self: '[Circular]' }, '[Circular]',
    ])
  })

  it('bounds deeply nested props and preserves repeated non-circular values', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 1000; i++) deep = { child: deep }
    expect(JSON.stringify(serializeValue(deep))).toContain('[Depth limit]')
    const shared = { label: 'shared' }
    expect(serializeValue([shared, shared])).toEqual([shared, shared])
  })
})
