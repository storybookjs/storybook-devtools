import { describe, expect, it } from 'vitest'
import {
  assertStorybookPeer,
  compareVersions,
  loadStorybookInternal,
  parseVersionFloor,
  storybookPeerProblem,
} from './storybook-peer'

describe('storybook peer check', () => {
  it('parses the floor of a >= range', () => {
    expect(parseVersionFloor('>=10.6.0')).toBe('10.6.0')
    expect(parseVersionFloor('>= 11.0.0')).toBe('11.0.0')
    expect(parseVersionFloor(undefined)).toBeUndefined()
  })

  it('compares x.y.z versions numerically', () => {
    expect(compareVersions('10.6.0', '10.6.0')).toBe(0)
    expect(compareVersions('10.10.0', '10.6.0')).toBeGreaterThan(0)
    expect(compareVersions('9.9.9', '10.6.0')).toBeLessThan(0)
  })

  it('names the peer requirement when storybook is missing or too old', () => {
    expect(storybookPeerProblem(undefined, '>=10.6.0', 'pkg')).toContain(
      'storybook >=10.6.0',
    )
    expect(storybookPeerProblem('10.5.2', '>=10.6.0', 'pkg')).toContain(
      'storybook 10.5.2 is installed',
    )
    expect(storybookPeerProblem('10.6.0', '>=10.6.0', 'pkg')).toBeNull()
    expect(storybookPeerProblem('11.0.0', '>=10.6.0', 'pkg')).toBeNull()
  })

  it('passes against this repo and loads an internal subpath synchronously', () => {
    expect(() => assertStorybookPeer()).not.toThrow()
    const babel = loadStorybookInternal<{ types: { isIdentifier: unknown } }>(
      'babel',
    )
    expect(typeof babel.types.isIdentifier).toBe('function')
    expect(loadStorybookInternal('babel')).toBe(babel)
  })
})
