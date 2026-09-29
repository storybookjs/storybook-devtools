/**
 * Story ↔ component matching against Storybook's index.json.
 *
 * Single source of truth for "which stories belong to this component file"
 * and "which story should we navigate to". Used by the panel (visit-story
 * navigation, highlighter tab story list) and the client overlay's no-RPC
 * fallback. Pure functions — callers fetch/cache the index themselves.
 */

import { storyNameFromExport } from 'storybook/internal/csf/csf-utils'

export interface StoryIndexEntryLike {
  id: string
  title?: string
  name?: string
  importPath?: string
  /** Storybook index v5+: the component file the story renders (e.g. `./src/components/TaskForm.vue`). */
  componentPath?: string
  exportName?: string
  type?: string
}

/**
 * Normalise a file path for story matching: strip a leading `./`, a
 * `.stories.*` suffix, and code/SFC extensions. Component paths (`.tsx`,
 * `.vue`, …) and story paths (`.stories.tsx`, `.stories.ts`, …) both reduce
 * to the same base, e.g. `src/components/TaskForm`.
 */
export function stripExtForMatch(p: string): string {
  return p
    .replace(/^\.\//, '')
    .replace(/\.(stories\.)?(tsx?|jsx?|mts|mjs|vue)$/, '')
}

/**
 * Collect the story entries belonging to a component file, preserving index
 * order. Matches by:
 * 1. `componentPath` (Storybook index v5+) — the index's own authoritative
 *    story→component link. When an entry carries it, it decides membership
 *    outright (no heuristics for that entry);
 * 2. exact importPath base (`src/components/TaskForm` ===
 *    stripped `./src/components/TaskForm.stories.ts`);
 * 3. same file name in a different directory (stories-dir layouts) — the
 *    LAST PATH SEGMENT must be equal. A bare `endsWith` is too loose:
 *    `…/MemoForwardInput` must not match component `Input`;
 * 4. optionally by title — the last segment of the story title equals
 *    `componentName` (case-insensitive). Only applied when `componentName`
 *    is provided.
 */
export function findStoryCandidates(
  entries: Record<string, StoryIndexEntryLike>,
  relativeFilePath: string,
  componentName?: string,
): StoryIndexEntryLike[] {
  const componentBase = stripExtForMatch(relativeFilePath)
  const baseName = componentBase.split('/').pop() || componentBase
  const nameToMatch = (componentName || '').toLowerCase()

  const results: StoryIndexEntryLike[] = []
  for (const entry of Object.values(entries)) {
    if (entry.type !== 'story') continue

    if (entry.componentPath) {
      if (stripExtForMatch(entry.componentPath) === componentBase) {
        results.push(entry)
      }
      continue
    }

    const entryBase = stripExtForMatch(entry.importPath || '')
    if (entryBase) {
      const entryFileName = entryBase.split('/').pop()
      if (entryBase === componentBase || entryFileName === baseName) {
        results.push(entry)
        continue
      }
    }

    if (nameToMatch && entry.title) {
      const titleParts = entry.title.split('/')
      const titleComponent = titleParts[titleParts.length - 1]!.toLowerCase()
      if (titleComponent === nameToMatch) {
        results.push(entry)
      }
    }
  }
  return results
}

/**
 * Pick the story id to navigate to for a component file.
 *
 * When `preferredStoryName` is supplied (the export name of a story that was
 * just created), the story whose derived display name or export name matches
 * wins. Otherwise:
 * - with `requirePreferred: true`, returns `null` — the caller is polling a
 *   possibly-stale index for the new story and must NOT fall back to an
 *   older story of the same component (that navigates to the wrong story);
 * - without it, falls back to the component's first story.
 */
export function pickStoryId(
  entries: Record<string, StoryIndexEntryLike>,
  relativeFilePath: string,
  preferredStoryName?: string,
  opts: { requirePreferred?: boolean } = {},
): string | null {
  const candidates = findStoryCandidates(entries, relativeFilePath)
  if (candidates.length === 0) return null

  if (preferredStoryName) {
    // `preferredStoryName` is the export identifier we just wrote (e.g.
    // `FilledForm`). Storybook's index derives the display `name` from it via
    // `storyNameFromExport` (inserting spaces before capital/digit runs), so
    // compare against that exact derivation — and also against `exportName`
    // directly, which still lines up even when a CSF `name`/`storyName`
    // annotation overrides the derived display name.
    const expectedName = storyNameFromExport(preferredStoryName)
    const match = candidates.find(
      (e) => e.name === expectedName || e.exportName === preferredStoryName,
    )
    if (match) return match.id
    if (opts.requirePreferred) return null
  }

  return candidates[0]!.id
}
