import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { computeCoverage } from './coverage-dashboard'
import type { StoryIndexEntryLike } from './utils/story-matching'

describe('computeCoverage', () => {
  it('marks a component covered via componentPath, ignoring file location', () => {
    const projectRoot = '/repo'
    const componentPath = path.join(projectRoot, 'src/components/Card.tsx')
    const entries: Record<string, StoryIndexEntryLike> = {
      'other-title--default': {
        id: 'other-title--default',
        type: 'story',
        title: 'Somewhere/Totally/Different',
        name: 'Default',
        importPath: './stories/nested/dir/wherever.stories.tsx',
        componentPath: './src/components/Card.tsx',
      },
    }

    const coverage = computeCoverage(
      new Map([['Card', componentPath]]),
      projectRoot,
      entries,
    )

    expect(coverage.entries[0]?.hasStory).toBe(true)
    expect(coverage.entries[0]?.storyPath).toBe(
      path.join(projectRoot, 'stories/nested/dir/wherever.stories.tsx'),
    )
  })

  it('marks a component uncovered when the index has no matching entry', () => {
    const projectRoot = '/repo'
    const componentPath = path.join(projectRoot, 'src/components/Lonely.tsx')

    const coverage = computeCoverage(
      new Map([['Lonely', componentPath]]),
      projectRoot,
      {},
    )

    expect(coverage.entries[0]?.hasStory).toBe(false)
    expect(coverage.entries[0]?.storyPath).toBeNull()
    expect(coverage.coveragePercent).toBe(0)
  })

  it('sorts uncovered components first, then alphabetically', () => {
    const projectRoot = '/repo'
    const entries: Record<string, StoryIndexEntryLike> = {
      'components-zeta--default': {
        id: 'components-zeta--default',
        type: 'story',
        importPath: './src/components/Zeta.stories.tsx',
        componentPath: './src/components/Zeta.tsx',
      },
    }

    const coverage = computeCoverage(
      new Map([
        ['Zeta', path.join(projectRoot, 'src/components/Zeta.tsx')],
        ['Alpha', path.join(projectRoot, 'src/components/Alpha.tsx')],
        ['Beta', path.join(projectRoot, 'src/components/Beta.tsx')],
      ]),
      projectRoot,
      entries,
    )

    expect(coverage.entries.map((e) => e.componentName)).toEqual([
      'Alpha',
      'Beta',
      'Zeta',
    ])
  })
})
