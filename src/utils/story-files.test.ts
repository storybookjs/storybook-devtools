import { describe, expect, it } from 'vitest'
import {
  CSF_STORY_FILE_PATTERN,
  STORY_EXCLUDE_GLOBS,
  STORY_FILE_PATTERN,
} from './story-files'

const cases: Array<{ path: string; story: boolean; csf: boolean }> = [
  { path: 'src/Button.stories.tsx', story: true, csf: true },
  { path: 'src/Button.stories.ts', story: true, csf: true },
  { path: 'src/Button.story.jsx', story: true, csf: true },
  { path: 'src/nested/stories.js', story: true, csf: true },
  { path: 'src/Button.stories.mdx', story: true, csf: false },
  { path: 'src/Button.stories.svelte', story: true, csf: false },
  { path: 'src/Button.tsx', story: false, csf: false },
  { path: 'src/stories/Button.tsx', story: false, csf: false },
  { path: 'src/MemoStories.tsx', story: false, csf: false },
  { path: 'src/Button.stories.tsx.bak', story: false, csf: false },
]

describe('story file patterns', () => {
  it.each(cases)(
    '$path → story file: $story, CSF-indexable: $csf',
    ({ path, story, csf }) => {
      expect(STORY_FILE_PATTERN.test(path)).toBe(story)
      expect(CSF_STORY_FILE_PATTERN.test(path)).toBe(csf)
    },
  )

  it('excludes exactly the story-file shapes the pattern matches', () => {
    expect(STORY_EXCLUDE_GLOBS).toEqual([
      '**/*.stories.*',
      '**/stories.*',
      '**/*.story.*',
      '**/story.*',
    ])
  })
})
