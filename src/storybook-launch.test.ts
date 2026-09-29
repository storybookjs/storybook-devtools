import { describe, expect, it, vi } from 'vitest'
import {
  buildStorybookEnv,
  resolveStorybookDevCommand,
} from './storybook-launch'

describe('resolveStorybookDevCommand', () => {
  it('detects this repo as pnpm and defers to its getPackageCommand', async () => {
    const result = await resolveStorybookDevCommand({
      cwd: process.cwd(),
      port: '6006',
      logDebug: () => {},
    })

    expect(result).toEqual({
      command: 'pnpm',
      args: ['exec', 'storybook', 'dev', '-p', '6006', '--no-open'],
    })
  })

  it('falls back to npx when package manager detection throws', async () => {
    vi.doMock('storybook/internal/common', () => ({
      JsPackageManagerFactory: {
        getPackageManager: () => {
          throw new Error('no lockfile found')
        },
      },
    }))
    vi.resetModules()
    const { resolveStorybookDevCommand: resolveWithMock } = await import(
      './storybook-launch'
    )

    const logDebug = vi.fn()
    const result = await resolveWithMock({
      cwd: '/tmp/does-not-matter',
      port: '6006',
      logDebug,
    })

    expect(result).toEqual({
      command: 'npx',
      args: ['storybook', 'dev', '-p', '6006', '--no-open'],
    })
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining('falling back to npx'),
    )

    vi.doUnmock('storybook/internal/common')
    vi.resetModules()
  })

  it('splits a yarn1-style command string, keeping the -- separator intact', async () => {
    vi.doMock('storybook/internal/common', () => ({
      JsPackageManagerFactory: {
        getPackageManager: () => ({
          getPackageCommand: (args: string[]) =>
            `yarn exec ${args[0]} -- ${args.slice(1).join(' ')}`,
        }),
      },
    }))
    vi.resetModules()
    const { resolveStorybookDevCommand: resolveWithMock } = await import(
      './storybook-launch'
    )

    const result = await resolveWithMock({
      cwd: '/tmp/does-not-matter',
      port: '6006',
      logDebug: () => {},
    })

    expect(result).toEqual({
      command: 'yarn',
      args: ['exec', 'storybook', '--', 'dev', '-p', '6006', '--no-open'],
    })

    vi.doUnmock('storybook/internal/common')
    vi.resetModules()
  })
})

describe('buildStorybookEnv', () => {
  it('sets STORYBOOK=true and pins PORT to the Storybook port over the host dev server value', () => {
    const env = buildStorybookEnv(
      {
        PATH: '/usr/bin',
        PORT: '5178',
        NODE_ENV: 'development',
        UNSET: undefined,
      },
      '6006',
    )

    expect(env).toEqual({
      PATH: '/usr/bin',
      NODE_ENV: 'development',
      STORYBOOK: 'true',
      PORT: '6006',
    })
  })

  it('overrides an inherited STORYBOOK value', () => {
    expect(buildStorybookEnv({ STORYBOOK: 'false' }, '6006')).toEqual({
      STORYBOOK: 'true',
      PORT: '6006',
    })
  })
})
