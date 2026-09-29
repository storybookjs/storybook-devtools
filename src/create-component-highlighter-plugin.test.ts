import * as path from 'path'
import type { ResolvedConfig, Plugin } from 'vite'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const createStoryIndexServiceMock = vi.fn((_options: unknown) => ({
  cwd: '',
  project: Promise.resolve(null),
  getIndex: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('./story-index', () => ({
  createStoryIndexService: (options: unknown) =>
    createStoryIndexServiceMock(options),
}))

describe('createComponentHighlighterPlugin', () => {
  beforeEach(() => {
    createStoryIndexServiceMock.mockClear()
  })

  it('builds the story-index service from the resolved Vite root, not process.cwd()', async () => {
    const { reactFramework } = await import('./frameworks/react')
    const { createComponentHighlighterPlugin } = await import(
      './create-component-highlighter-plugin'
    )

    const monorepoAppRoot = path.resolve(process.cwd(), 'apps/storefront')
    expect(monorepoAppRoot).not.toBe(process.cwd())

    const plugins = createComponentHighlighterPlugin(reactFramework)
    const transformPlugin = plugins[0] as Plugin

    // No service built yet — the plugin factory runs before Vite resolves
    // `root`.
    expect(createStoryIndexServiceMock).not.toHaveBeenCalled()

    const configResolved = transformPlugin.configResolved as (
      config: ResolvedConfig,
    ) => void
    configResolved({
      root: monorepoAppRoot,
      command: 'serve',
      base: '/',
    } as unknown as ResolvedConfig)

    expect(createStoryIndexServiceMock).toHaveBeenCalledTimes(1)
    expect(createStoryIndexServiceMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: monorepoAppRoot }),
    )
  })
})
