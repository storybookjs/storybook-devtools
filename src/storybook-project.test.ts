import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createRequire } from 'module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resolveStorybookProject,
  resolveProjectRootSync,
} from './storybook-project'

describe('resolveStorybookProject', () => {
  const tmpDirs: string[] = []

  function makeTmpProject(mainConfigSource: string): string {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb-project-')),
    )
    tmpDirs.push(dir)
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'tmp-test', version: '1.0.0' }),
    )
    fs.mkdirSync(path.join(dir, '.storybook'))
    fs.writeFileSync(path.join(dir, '.storybook', 'main.ts'), mainConfigSource)
    return dir
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a string framework field (Next.js, nextjs-vite)', async () => {
    const dir = makeTmpProject(
      `export default { stories: [], framework: '@storybook/nextjs-vite' }`,
    )

    const project = await resolveStorybookProject(dir)

    expect(project?.frameworkPackage).toBe('@storybook/nextjs-vite')
    expect(project?.configDir).toBe(path.join(dir, '.storybook'))
    expect(project?.mainConfigPath).toContain('main.ts')
  })

  it('resolves an object framework field (webpack5)', async () => {
    const dir = makeTmpProject(
      `export default { stories: [], framework: { name: '@storybook/react-webpack5', options: {} } }`,
    )

    const project = await resolveStorybookProject(dir)

    expect(project?.frameworkPackage).toBe('@storybook/react-webpack5')
    expect(project?.renderer).toBe('react')
    expect(project?.builder).toBe('webpack5')
  })

  it('carries through the raw stories globs and addons', async () => {
    const dir = makeTmpProject(
      `export default { stories: ['../src/**/*.stories.tsx'], addons: ['@storybook/addon-a11y'], framework: '@storybook/react-vite' }`,
    )

    const project = await resolveStorybookProject(dir)

    expect(project?.storiesGlobs).toEqual(['../src/**/*.stories.tsx'])
    expect(project?.addons).toEqual(['@storybook/addon-a11y'])
  })

  it('returns null when no .storybook config exists', async () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sb-project-')),
    )
    tmpDirs.push(dir)
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'tmp-test', version: '1.0.0' }),
    )

    const project = await resolveStorybookProject(dir)

    expect(project).toBeNull()
  })

  it('memoises per cwd (second call does not re-read the config)', async () => {
    const dir = makeTmpProject(
      `export default { stories: [], framework: '@storybook/react-vite' }`,
    )

    const first = await resolveStorybookProject(dir)
    // Mutate the config on disk — a memoised second call must not see this.
    fs.writeFileSync(
      path.join(dir, '.storybook', 'main.ts'),
      `export default { stories: [], framework: '@storybook/vue3-vite' }`,
    )
    const second = await resolveStorybookProject(dir)

    expect(second?.frameworkPackage).toBe(first?.frameworkPackage)
  })

  it('resolves the real react playground config', async () => {
    const reactPlayground = path.resolve(__dirname, '../playground/react')
    const project = await resolveStorybookProject(reactPlayground)

    expect(project?.frameworkPackage).toBe('@storybook/react-vite')
    expect(project?.renderer).toBe('react')
  })

  it('resolves the real vue playground config', async () => {
    const vuePlayground = path.resolve(__dirname, '../playground/vue')
    const project = await resolveStorybookProject(vuePlayground)

    expect(project?.frameworkPackage).toBe('@storybook/vue3-vite')
    expect(project?.renderer).toBe('vue3')
  })
})

describe('resolveProjectRootSync', () => {
  it('resolves the repo root (against the real process cwd)', () => {
    expect(resolveProjectRootSync()).toBe(path.resolve(__dirname, '..'))
  })

  it('resolves a new process.cwd() separately from a previously memoised one', async () => {
    // `resolveProjectRootSync` reads `storybook/internal/common` through a
    // native `require()` (via `createRequire`), which bypasses Vitest's
    // module graph entirely — `vi.doMock`/`vi.mock` have no effect on it.
    // Storybook's own `getProjectRoot` also memoises its result in a
    // process-wide variable independent of `cwd`, so a real `process.chdir`
    // between calls does not exercise a fresh resolution either. Injecting
    // straight into Node's `require.cache` is the one lever left to control
    // what `require('storybook/internal/common')` returns per call.
    const testRequire = createRequire(import.meta.url)
    const resolvedPath = testRequire.resolve('storybook/internal/common')
    const originalCacheEntry = testRequire.cache[resolvedPath]

    let calls = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    testRequire.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: { getProjectRoot: () => `root-${++calls}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    try {
      vi.resetModules()
      const { resolveProjectRootSync: resolveWithMock } = await import(
        './storybook-project'
      )

      const originalCwd = process.cwd()
      const otherDir = fs.realpathSync(os.tmpdir())
      try {
        expect(resolveWithMock()).toBe('root-1')

        process.chdir(otherDir)
        expect(resolveWithMock()).toBe('root-2')

        // Still memoised per cwd: calling again from the same (new) cwd
        // doesn't re-derive it.
        expect(resolveWithMock()).toBe('root-2')
      } finally {
        process.chdir(originalCwd)
      }
    } finally {
      if (originalCacheEntry) {
        testRequire.cache[resolvedPath] = originalCacheEntry
      } else {
        delete testRequire.cache[resolvedPath]
      }
      vi.resetModules()
    }
  })
})

describe('resolveStorybookProject transient failures', () => {
  afterEach(() => {
    vi.doUnmock('storybook/internal/common')
    vi.resetModules()
  })

  it('does not cache a transient failure (a config that fails once, then succeeds)', async () => {
    let calls = 0
    vi.doMock('storybook/internal/common', () => ({
      getStorybookInfo: async () => {
        calls++
        if (calls === 1) throw new Error('momentarily unparsable config')
        return {
          mainConfigPath: '/tmp/ch-sb-project-transient/.storybook/main.ts',
          configDir: '/tmp/ch-sb-project-transient/.storybook',
          frameworkPackage: '@storybook/react-vite',
          renderer: 'react',
          builder: 'vite',
          mainConfig: { stories: [] },
          addons: [],
        }
      },
    }))
    vi.resetModules()
    const { resolveStorybookProject: resolveWithMock } = await import(
      './storybook-project'
    )

    const logDebug = vi.fn()
    const first = await resolveWithMock(
      '/tmp/ch-sb-project-transient',
      logDebug,
    )
    expect(first).toBeNull()
    expect(logDebug).toHaveBeenCalled()

    const second = await resolveWithMock('/tmp/ch-sb-project-transient')
    expect(second?.frameworkPackage).toBe('@storybook/react-vite')
    expect(calls).toBe(2)
  })

  it('caches a missing-config result (MainFileMissingError) as null', async () => {
    let calls = 0
    vi.doMock('storybook/internal/common', () => ({
      getStorybookInfo: async () => {
        calls++
        const { MainFileMissingError } = await import(
          'storybook/internal/server-errors'
        )
        throw new MainFileMissingError({ location: '.storybook' })
      },
    }))
    vi.resetModules()
    const { resolveStorybookProject: resolveWithMock } = await import(
      './storybook-project'
    )

    const first = await resolveWithMock('/tmp/ch-sb-project-missing')
    const second = await resolveWithMock('/tmp/ch-sb-project-missing')

    expect(first).toBeNull()
    expect(second).toBeNull()
    // Cached: the mock's getStorybookInfo only ran once across both calls.
    expect(calls).toBe(1)
  })
})
