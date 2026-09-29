/**
 * Story Coverage Dashboard
 *
 * Creates a JSON-render dock panel showing component story coverage.
 * Uses the Vite DevTools json-render dock type for zero client code.
 *
 * Decides coverage from story index entries alone (`src/story-index.ts`),
 * so it can be replaced or extended without affecting other modules.
 */

import * as path from 'path'
import type { JsonRenderSpec } from '@vitejs/devtools-kit'
import { findStoryCandidates, type StoryIndexEntryLike } from './utils/story-matching'
import type { StoryIndexService } from './story-index'

export interface CoverageEntry {
  componentName: string
  filePath: string
  relativeFilePath: string
  hasStory: boolean
  storyPath: string | null
}

export interface CoverageData {
  entries: CoverageEntry[]
  totalComponents: number
  coveredComponents: number
  coveragePercent: number
}

/**
 * Compute coverage data from a set of known component file paths.
 *
 * Decides `hasStory` from story index entries (`src/story-index.ts`) the
 * same way the panel matches against Storybook's live `index.json`
 * (`findStoryCandidates`): on `componentPath`/`importPath`/title, so custom
 * titles and stories living outside the component's own directory count.
 * Pure and unit-testable: takes its inputs as data, never reaches into
 * global state.
 */
export function computeCoverage(
  componentPaths: Map<string, string>,
  projectRoot: string,
  storyIndexEntries: Record<string, StoryIndexEntryLike>,
): CoverageData {
  const entries: CoverageEntry[] = []
  const seen = new Set<string>()

  for (const [name, filePath] of componentPaths) {
    if (seen.has(filePath)) continue
    seen.add(filePath)

    const relativeFilePath = path.relative(projectRoot, filePath)
    const candidates = findStoryCandidates(
      storyIndexEntries,
      relativeFilePath,
      name,
    )
    entries.push({
      componentName: name,
      filePath,
      relativeFilePath,
      hasStory: candidates.length > 0,
      storyPath: candidates[0]?.importPath
        ? path.resolve(projectRoot, candidates[0].importPath)
        : null,
    })
  }

  // Sort: uncovered first, then alphabetical
  entries.sort((a, b) => {
    if (a.hasStory !== b.hasStory) return a.hasStory ? 1 : -1
    return a.componentName.localeCompare(b.componentName)
  })

  const totalComponents = entries.length
  const coveredComponents = entries.filter((e) => e.hasStory).length
  const coveragePercent =
    totalComponents > 0
      ? Math.round((coveredComponents / totalComponents) * 100)
      : 0

  return { entries, totalComponents, coveredComponents, coveragePercent }
}

/**
 * Coverage for the components a host has instrumented so far, against that
 * host's story index. The index service owns the root the entries' paths are
 * relative to, so coverage always compares like with like.
 */
export async function collectCoverage(
  storyIndexService: StoryIndexService,
  componentPaths: Map<string, string>,
): Promise<CoverageData> {
  const index = await storyIndexService.getIndex()
  return computeCoverage(componentPaths, storyIndexService.cwd, index.entries)
}

/**
 * Build a JSON-render spec from coverage data.
 *
 * This produces a plain object matching the DevTools Kit JsonRenderSpec
 * shape. It has no runtime dependency on `@vitejs/devtools-kit` so
 * callers can use it freely.
 */
export function buildCoverageSpec(coverage: CoverageData): JsonRenderSpec {
  const rows = coverage.entries.map((entry) => ({
    Component: entry.componentName,
    File: entry.relativeFilePath,
    Status: entry.hasStory ? 'Covered' : 'Missing',
  }))

  return {
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { direction: 'vertical', gap: 12 },
        children: ['header', 'progress', 'table'],
      },
      header: {
        type: 'Text',
        props: {
          variant: 'heading',
          text: `Story Coverage: ${coverage.coveragePercent}% (${coverage.coveredComponents}/${coverage.totalComponents})`,
        },
      },
      progress: {
        type: 'Progress',
        props: {
          value: coverage.coveragePercent,
          label: `${coverage.coveredComponents} of ${coverage.totalComponents} components in this page have stories`,
        },
      },
      table: {
        type: 'DataTable',
        props: {
          columns: [
            { key: 'Component', label: 'Component' },
            { key: 'File', label: 'File' },
            { key: 'Status', label: 'Status' },
          ],
          rows,
          maxHeight: '400px',
        },
      },
    },
  }
}
