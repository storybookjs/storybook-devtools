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

  it('reads the floor from the declared multi-clause range', () => {
    expect(parseVersionFloor('>=10.6.0 || ^11.0.0-0')).toBe('10.6.0')
  })

  it('declares a peer range that covers 10.6+ and every 11 prerelease', async () => {
    const own = (await import('../package.json')).default as {
      peerDependencies: Record<string, string>
    }
    expect(own.peerDependencies['storybook']).toBe('>=10.6.0 || ^11.0.0-0')
  })

  it('compares x.y.z versions numerically', () => {
    expect(compareVersions('10.6.0', '10.6.0')).toBe(0)
    expect(compareVersions('10.10.0', '10.6.0')).toBeGreaterThan(0)
    expect(compareVersions('9.9.9', '10.6.0')).toBeLessThan(0)
  })

  it('orders a prerelease before its release and after lower releases', () => {
    expect(compareVersions('11.0.0-alpha.1', '11.0.0')).toBeLessThan(0)
    expect(compareVersions('10.6.0-beta.1', '10.6.0')).toBeLessThan(0)
    expect(compareVersions('11.0.0-alpha.1', '10.6.0')).toBeGreaterThan(0)
    expect(compareVersions('11.0.0-alpha.1', '11.0.0-alpha.1')).toBe(0)
    expect(compareVersions('11.0.0-alpha.2', '11.0.0-alpha.10')).toBeLessThan(0)
    expect(compareVersions('11.0.0-alpha.1', '11.0.0-beta.0')).toBeLessThan(0)
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

  const range = '>=10.6.0 || ^11.0.0-0'

  it.each(['10.6.0', '10.9.9', '11.0.0-alpha.1', '11.0.0', '11.3.0'])(
    'accepts storybook %s against the declared range',
    (version) => {
      expect(storybookPeerProblem(version, range, 'pkg')).toBeNull()
    },
  )

  it.each(['10.5.0', '10.6.0-beta.1', '9.1.20'])(
    'rejects storybook %s against the declared range and names the floor',
    (version) => {
      const problem = storybookPeerProblem(version, range, 'pkg')
      expect(problem).toContain(`storybook ${version} is installed`)
      expect(problem).toContain('Upgrade storybook to 10.6.0 or newer')
    },
  )

  it('passes against this repo and loads an internal subpath synchronously', () => {
    expect(() => assertStorybookPeer()).not.toThrow()
    const babel = loadStorybookInternal<{ types: { isIdentifier: unknown } }>(
      'babel',
    )
    expect(typeof babel.types.isIdentifier).toBe('function')
    expect(loadStorybookInternal('babel')).toBe(babel)
  })
})
