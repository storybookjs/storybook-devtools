import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStoryIndexService } from './story-index'
import { computeCoverage } from './coverage-dashboard'

const reactPlayground = path.resolve(__dirname, '../playground/react')

describe('createStoryIndexService', () => {
  const writtenFiles: string[] = []
  const tmpDirs: string[] = []

  afterEach(() => {
    for (const file of writtenFiles.splice(0)) {
      fs.rmSync(file, { force: true })
    }
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTmpProject(): string {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ch-story-index-')),
    )
    tmpDirs.push(dir)
    return dir
  }

  function configuredProject(extension = 'tsx'): string {
    const dir = makeTmpProject()
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"index-fixture"}')
    fs.mkdirSync(path.join(dir, '.storybook'))
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, '.storybook/main.ts'),
      `export default { framework: '@storybook/react-vite', stories: ['../src/*.stories.${extension}'] }`)
    fs.writeFileSync(path.join(dir, `src/Button.stories.${extension}`),
      `export default { title: 'Custom/Button' }; export const First = {};`)
    return dir
  }

  it('indexes mjs stories accepted by the playground configs', async () => {
    const service = createStoryIndexService({ cwd: configuredProject('mjs'), logDebug: () => {} })
    expect(Object.keys((await service.getIndex()).entries)).toContain('custom-button--first')
  })

  it('rebuilds against changed config globs after full invalidation', async () => {
    const cwd = configuredProject()
    const service = createStoryIndexService({ cwd, logDebug: () => {} })
    expect(Object.keys((await service.getIndex()).entries)).toContain('custom-button--first')
    fs.mkdirSync(path.join(cwd, 'other'))
    fs.writeFileSync(path.join(cwd, 'other/Card.stories.tsx'),
      `export default { title: 'Custom/Card' }; export const Second = {};`)
    fs.writeFileSync(path.join(cwd, '.storybook/main.ts'),
      `export default { framework: '@storybook/react-vite', stories: ['../other/*.stories.tsx'] }`)
    service.invalidate()
    expect(Object.keys((await service.getIndex()).entries)).toEqual(['custom-card--second'])
  })

  it('sees external edits, additions and deletions without bundler watch events', async () => {
    const cwd = configuredProject()
    const service = createStoryIndexService({ cwd, logDebug: () => {} })
    await service.getIndex()
    fs.writeFileSync(path.join(cwd, 'src/Button.stories.tsx'),
      `export default { title: 'Custom/Button' }; export const Edited = {};`)
    fs.writeFileSync(path.join(cwd, 'src/Card.stories.tsx'),
      `export default { title: 'Custom/Card' }; export const Added = {};`)
    expect(Object.keys((await service.getIndex()).entries).sort()).toEqual([
      'custom-button--edited', 'custom-card--added',
    ])
    fs.rmSync(path.join(cwd, 'src/Button.stories.tsx'))
    expect(Object.keys((await service.getIndex()).entries)).toEqual(['custom-card--added'])
  })

  it('scans symlinked source trees without following cycles', async () => {
    const cwd = makeTmpProject()
    const shared = makeTmpProject()
    fs.writeFileSync(path.join(shared, 'Button.stories.tsx'), '')
    fs.symlinkSync(shared, path.join(cwd, 'src'), 'dir')
    fs.symlinkSync(cwd, path.join(shared, 'cycle'), 'dir')
    const service = createStoryIndexService({ cwd, logDebug: () => {} })
    expect(Object.values((await service.getIndex()).entries).map(e => e.importPath)).toEqual(['./src/Button.stories.tsx'])
  })

  it('builds an index with the known react playground story entries', async () => {
    const service = createStoryIndexService({
      cwd: reactPlayground,
      logDebug: () => {},
    })

    const index = await service.getIndex()

    const ids = Object.keys(index.entries)
    expect(ids).toContain('components-badge--inprogress')
    expect(ids).toContain('components-button--qaeditedprops')
    expect(ids).toContain('components-input--empty')
  })

  it('reflects a newly added story file after invalidate()', async () => {
    const service = createStoryIndexService({
      cwd: reactPlayground,
      logDebug: () => {},
    })

    const before = await service.getIndex()
    expect(
      Object.keys(before.entries).some((id) =>
        id.startsWith('components-storyindextestwidget'),
      ),
    ).toBe(false)

    const newStoryPath = path.join(
      reactPlayground,
      'src/components/StoryIndexTestWidget.stories.tsx',
    )
    writtenFiles.push(newStoryPath)
    fs.writeFileSync(
      newStoryPath,
      `import type { Meta, StoryObj } from '@storybook/react-vite'

const StoryIndexTestWidget = () => null

const meta: Meta<typeof StoryIndexTestWidget> = {
  title: 'Components/StoryIndexTestWidget',
  component: StoryIndexTestWidget,
}
export default meta
type Story = StoryObj<typeof StoryIndexTestWidget>

export const Default: Story = {}
`,
    )

    service.invalidate(newStoryPath)
    const after = await service.getIndex()

    expect(Object.keys(after.entries)).toContain(
      'components-storyindextestwidget--default',
    )
  })

  it('drops a deleted story file from the index after invalidate(path, { removed: true })', async () => {
    const service = createStoryIndexService({
      cwd: reactPlayground,
      logDebug: () => {},
    })
    await service.getIndex()

    const storyPath = path.join(
      reactPlayground,
      'src/components/StoryIndexDeletedWidget.stories.tsx',
    )
    writtenFiles.push(storyPath)
    fs.writeFileSync(
      storyPath,
      `import type { Meta, StoryObj } from '@storybook/react-vite'

const StoryIndexDeletedWidget = () => null

const meta: Meta<typeof StoryIndexDeletedWidget> = {
  title: 'Components/StoryIndexDeletedWidget',
  component: StoryIndexDeletedWidget,
}
export default meta
type Story = StoryObj<typeof StoryIndexDeletedWidget>

export const Default: Story = {}
`,
    )
    service.invalidate(storyPath)
    const withFile = await service.getIndex()
    expect(Object.keys(withFile.entries)).toContain(
      'components-storyindexdeletedwidget--default',
    )

    fs.rmSync(storyPath)
    service.invalidate(storyPath, { removed: true })
    const after = await service.getIndex()

    expect(Object.keys(after.entries)).not.toContain(
      'components-storyindexdeletedwidget--default',
    )
  })

  it('a second service in the same process sees a story file created between it and the first', async () => {
    const first = createStoryIndexService({
      cwd: reactPlayground,
      logDebug: () => {},
    })
    await first.getIndex()

    const newStoryPath = path.join(
      reactPlayground,
      'src/components/StoryIndexSecondServiceWidget.stories.tsx',
    )
    writtenFiles.push(newStoryPath)
    fs.writeFileSync(
      newStoryPath,
      `import type { Meta, StoryObj } from '@storybook/react-vite'

const StoryIndexSecondServiceWidget = () => null

const meta: Meta<typeof StoryIndexSecondServiceWidget> = {
  title: 'Components/StoryIndexSecondServiceWidget',
  component: StoryIndexSecondServiceWidget,
}
export default meta
type Story = StoryObj<typeof StoryIndexSecondServiceWidget>

export const Default: Story = {}
`,
    )

    // A second, freshly constructed service for the same cwd — no
    // invalidate() call, so it can only see the new file if its own
    // `StoryIndexGenerator.initialize()` scan picks it up rather than
    // reusing the first instance's cached file list.
    const second = createStoryIndexService({
      cwd: reactPlayground,
      logDebug: () => {},
    })
    const index = await second.getIndex()

    expect(Object.keys(index.entries)).toContain(
      'components-storyindexsecondservicewidget--default',
    )
  })

  describe('file-scan fallback (no Storybook project)', () => {
    it('synthesises an entry for a story file sitting next to its component', async () => {
      const projectRoot = makeTmpProject()
      const componentPath = path.join(projectRoot, 'src/Button.tsx')
      fs.mkdirSync(path.dirname(componentPath), { recursive: true })
      fs.writeFileSync(componentPath, '')
      fs.writeFileSync(path.join(projectRoot, 'src/Button.stories.tsx'), '')

      const service = createStoryIndexService({
        cwd: projectRoot,
        logDebug: () => {},
      })
      const index = await service.getIndex()
      const entry = Object.values(index.entries)[0]

      // No synthesised `componentPath`: `findStoryCandidates` matches these
      // on `importPath`, and a `componentPath` would decide membership
      // outright.
      expect(entry).toEqual({
        id: expect.any(String),
        type: 'story',
        importPath: './src/Button.stories.tsx',
      })

      const coverage = computeCoverage(
        new Map([['Button', componentPath]]),
        projectRoot,
        index.entries,
      )
      expect(coverage.entries[0]?.hasStory).toBe(true)
    })

    it('finds a story in a stories directory next to the component', async () => {
      const projectRoot = makeTmpProject()
      const componentPath = path.join(projectRoot, 'src/Card.tsx')
      fs.mkdirSync(path.join(projectRoot, 'src/stories'), { recursive: true })
      fs.writeFileSync(componentPath, '')
      fs.writeFileSync(
        path.join(projectRoot, 'src/stories/Card.stories.ts'),
        '',
      )

      const service = createStoryIndexService({
        cwd: projectRoot,
        logDebug: () => {},
      })
      const coverage = computeCoverage(
        new Map([['Card', componentPath]]),
        projectRoot,
        (await service.getIndex()).entries,
      )

      expect(coverage.entries[0]?.hasStory).toBe(true)
    })

    it('leaves a component without a story file uncovered', async () => {
      const projectRoot = makeTmpProject()
      const componentPath = path.join(projectRoot, 'Orphan.tsx')
      fs.writeFileSync(componentPath, '')

      const service = createStoryIndexService({
        cwd: projectRoot,
        logDebug: () => {},
      })
      const index = await service.getIndex()

      expect(index.entries).toEqual({})

      const coverage = computeCoverage(
        new Map([['Orphan', componentPath]]),
        projectRoot,
        index.entries,
      )
      expect(coverage.entries[0]?.hasStory).toBe(false)
    })

    it('memoises a failed generator build until invalidate()', async () => {
      const projectRoot = makeTmpProject()
      fs.writeFileSync(
        path.join(projectRoot, 'package.json'),
        JSON.stringify({ name: 'tmp-test', version: '1.0.0' }),
      )
      fs.mkdirSync(path.join(projectRoot, '.storybook'))
      // A stories entry `normalizeStories` rejects: the project resolves,
      // building the generator throws.
      fs.writeFileSync(
        path.join(projectRoot, '.storybook', 'main.ts'),
        `export default { stories: [123], framework: '@storybook/react-vite' }`,
      )

      const logDebug = vi.fn()
      const buildAttempts = () =>
        logDebug.mock.calls.filter((call) =>
          String(call[0]).includes('Failed to build'),
        ).length

      const service = createStoryIndexService({ cwd: projectRoot, logDebug })

      await service.getIndex()
      await service.getIndex()
      expect(buildAttempts()).toBe(1)

      service.invalidate()
      await service.getIndex()
      expect(buildAttempts()).toBe(2)
    })

    it('picks up a story file written after the first getIndex()', async () => {
      const projectRoot = makeTmpProject()
      fs.writeFileSync(path.join(projectRoot, 'Late.tsx'), '')

      const service = createStoryIndexService({
        cwd: projectRoot,
        logDebug: () => {},
      })
      expect(Object.keys((await service.getIndex()).entries)).toHaveLength(0)

      const storyPath = path.join(projectRoot, 'Late.stories.tsx')
      fs.writeFileSync(storyPath, '')
      service.invalidate(storyPath)

      expect(Object.keys((await service.getIndex()).entries)).toHaveLength(1)
    })
  })
})
