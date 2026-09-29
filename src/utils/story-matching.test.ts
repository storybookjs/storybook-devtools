import { describe, it, expect } from 'vitest'
import { storyNameFromExport, toId } from 'storybook/internal/csf/csf-utils'
import {
  findStoryCandidates,
  pickStoryId,
  stripExtForMatch,
  type StoryIndexEntryLike,
} from './story-matching'

function index(
  ...entries: StoryIndexEntryLike[]
): Record<string, StoryIndexEntryLike> {
  return Object.fromEntries(entries.map((e) => [e.id, e]))
}

describe('stripExtForMatch', () => {
  it('reduces component and story paths to the same base', () => {
    expect(stripExtForMatch('src/components/Header.tsx')).toBe(
      'src/components/Header',
    )
    expect(stripExtForMatch('./src/components/Header.stories.tsx')).toBe(
      'src/components/Header',
    )
    expect(stripExtForMatch('src/components/TaskForm.vue')).toBe(
      'src/components/TaskForm',
    )
    expect(stripExtForMatch('./src/components/TaskForm.stories.ts')).toBe(
      'src/components/TaskForm',
    )
  })
})

describe('findStoryCandidates', () => {
  it('matches Vue SFC components against .stories.ts entries (the .vue case)', () => {
    // Regression: stripExtForMatch previously did NOT strip `.vue`, so Vue
    // components never matched any story entry — visit-story silently
    // no-oped and the Storybook pane stayed on whatever story was selected.
    const entries = index({
      id: 'components-taskform--default',
      type: 'story',
      name: 'Default',
      title: 'Components/TaskForm',
      importPath: './src/components/TaskForm.stories.ts',
    })
    const found = findStoryCandidates(entries, 'src/components/TaskForm.vue')
    expect(found.map((e) => e.id)).toEqual(['components-taskform--default'])
  })

  it('does not cross-match components whose names merely end alike', () => {
    // Regression: a bare endsWith() matched `…/MemoForwardInput` stories for
    // component `Input`.
    const entries = index({
      id: 'patterns-memoforwardinput--default',
      type: 'story',
      name: 'Default',
      title: 'Patterns/MemoForwardInput',
      importPath: './src/components/patterns/MemoForwardInput.stories.tsx',
    })
    expect(findStoryCandidates(entries, 'src/components/Input.tsx')).toEqual([])
  })

  it('matches stories living in a separate stories directory by file name', () => {
    const entries = index({
      id: 'button--primary',
      type: 'story',
      name: 'Primary',
      title: 'Button',
      importPath: './src/stories/Button.stories.ts',
    })
    const found = findStoryCandidates(entries, 'src/components/Button.vue')
    expect(found.map((e) => e.id)).toEqual(['button--primary'])
  })

  it('falls back to title matching only when componentName is given', () => {
    const entries = index({
      id: 'ui-badge--default',
      type: 'story',
      name: 'Default',
      title: 'UI/Badge',
      importPath: './stories/badge-stories.ts',
    })
    expect(findStoryCandidates(entries, 'src/components/Badge.vue')).toEqual(
      [],
    )
    expect(
      findStoryCandidates(entries, 'src/components/Badge.vue', 'Badge').map(
        (e) => e.id,
      ),
    ).toEqual(['ui-badge--default'])
  })

  it('ignores non-story entries (docs)', () => {
    const entries = index({
      id: 'components-taskform--docs',
      type: 'docs',
      name: 'Docs',
      title: 'Components/TaskForm',
      importPath: './src/components/TaskForm.stories.ts',
    })
    expect(findStoryCandidates(entries, 'src/components/TaskForm.vue')).toEqual(
      [],
    )
  })
})

describe('real Storybook index v5 payload (componentPath + derived name)', () => {
  // Shape of a live Storybook 10 index.json: entries carry `componentPath`
  // (authoritative link to the component file), `name` is
  // `storyNameFromExport(exportName)` (Storybook inserts spaces before
  // capital runs and digit runs), and `id` is `toId(title, name)`.
  const initialStoryName = storyNameFromExport('InitialStory')
  const filledFormName = storyNameFromExport('FilledForm')
  const title = 'components/TaskForm'
  const v5Index = index(
    {
      id: toId(title, initialStoryName),
      type: 'story',
      name: initialStoryName,
      title,
      importPath: './src/components/TaskForm.stories.ts',
      componentPath: './src/components/TaskForm.vue',
      exportName: 'InitialStory',
    },
    {
      id: toId(title, filledFormName),
      type: 'story',
      name: filledFormName,
      title,
      importPath: './src/components/TaskForm.stories.ts',
      componentPath: './src/components/TaskForm.vue',
      exportName: 'FilledForm',
    },
  )

  it('matches candidates through componentPath', () => {
    const found = findStoryCandidates(v5Index, 'src/components/TaskForm.vue')
    expect(found.map((e) => e.id)).toEqual([
      toId(title, initialStoryName),
      toId(title, filledFormName),
    ])
  })

  it('navigates to the just-created story by its exact derived display name', () => {
    expect(
      pickStoryId(v5Index, 'src/components/TaskForm.vue', 'FilledForm', {
        requirePreferred: true,
      }),
    ).toBe(toId(title, filledFormName))
  })

  it('matches export names Storybook renders with inserted spaces before digit and acronym runs', () => {
    // storyNameFromExport('Button2') -> 'Button 2';
    // storyNameFromExport('HTMLPreview') -> 'HTML Preview'. A loose
    // lower-case/strip-spaces comparison would also pass here, but so would
    // unrelated names that happen to share the same letters — exact
    // derivation is the only check that rules those out.
    const digitsAndAcronyms = index(
      {
        id: toId('Button', storyNameFromExport('Button2')),
        type: 'story',
        name: storyNameFromExport('Button2'),
        title: 'Button',
        importPath: './src/components/Button.stories.tsx',
        componentPath: './src/components/Button.tsx',
        exportName: 'Button2',
      },
      {
        id: toId('Button', storyNameFromExport('HTMLPreview')),
        type: 'story',
        name: storyNameFromExport('HTMLPreview'),
        title: 'Button',
        importPath: './src/components/Button.stories.tsx',
        componentPath: './src/components/Button.tsx',
        exportName: 'HTMLPreview',
      },
    )
    expect(
      pickStoryId(digitsAndAcronyms, 'src/components/Button.tsx', 'Button2', {
        requirePreferred: true,
      }),
    ).toBe(toId('Button', storyNameFromExport('Button2')))
    expect(
      pickStoryId(
        digitsAndAcronyms,
        'src/components/Button.tsx',
        'HTMLPreview',
        { requirePreferred: true },
      ),
    ).toBe(toId('Button', storyNameFromExport('HTMLPreview')))
  })

  it('matches via exportName when the index name was overridden by a CSF `name` annotation', () => {
    // `export const primaryWithLongLabel = { name: 'Custom Label', ... }`
    // — the index `name` no longer derives from the export identifier, so
    // matching must fall back to the raw `exportName`.
    const overridden = index({
      id: toId('Button', 'Custom Label'),
      type: 'story',
      name: 'Custom Label',
      title: 'Button',
      importPath: './src/components/Button.stories.tsx',
      componentPath: './src/components/Button.tsx',
      exportName: 'primaryWithLongLabel',
    })
    expect(
      pickStoryId(
        overridden,
        'src/components/Button.tsx',
        'primaryWithLongLabel',
        { requirePreferred: true },
      ),
    ).toBe(toId('Button', 'Custom Label'))
  })

  it('componentPath is authoritative — a different component never matches, even with a similar file name', () => {
    const entries = index({
      id: 'patterns-memoforwardinput--default',
      type: 'story',
      name: 'Default',
      title: 'patterns/MemoForwardInput',
      importPath: './src/components/patterns/Input.stories.tsx',
      componentPath: './src/components/patterns/MemoForwardInput.tsx',
    })
    // importPath base would heuristically match `Input`, but componentPath
    // says the story belongs to MemoForwardInput — so it must be excluded.
    expect(findStoryCandidates(entries, 'src/components/Input.tsx')).toEqual(
      [],
    )
  })
})

describe('pickStoryId', () => {
  const taskFormIndex = index(
    {
      id: 'components-taskform--default',
      type: 'story',
      name: 'Default',
      title: 'Components/TaskForm',
      importPath: './src/components/TaskForm.stories.ts',
    },
    {
      id: 'components-taskform--filled-form',
      type: 'story',
      name: 'Filled Form',
      title: 'Components/TaskForm',
      importPath: './src/components/TaskForm.stories.ts',
    },
  )

  it('prefers the story matching preferredStoryName (exact derived display name)', () => {
    expect(
      pickStoryId(taskFormIndex, 'src/components/TaskForm.vue', 'FilledForm'),
    ).toBe('components-taskform--filled-form')
  })

  it('with requirePreferred, returns null while the new story is missing from the index', () => {
    // Regression: the visit-story retry loop polls a stale index for a
    // just-created story. Falling back to the component's FIRST story here
    // short-circuited the loop and navigated to the wrong (older) story.
    const staleIndex = index({
      id: 'components-taskform--default',
      type: 'story',
      name: 'Default',
      title: 'Components/TaskForm',
      importPath: './src/components/TaskForm.stories.ts',
    })
    expect(
      pickStoryId(staleIndex, 'src/components/TaskForm.vue', 'FilledForm', {
        requirePreferred: true,
      }),
    ).toBeNull()
    // Once the index refreshes, the preferred story wins.
    expect(
      pickStoryId(taskFormIndex, 'src/components/TaskForm.vue', 'FilledForm', {
        requirePreferred: true,
      }),
    ).toBe('components-taskform--filled-form')
  })

  it('without requirePreferred, falls back to the first story of the component', () => {
    const staleIndex = index({
      id: 'components-taskform--default',
      type: 'story',
      name: 'Default',
      title: 'Components/TaskForm',
      importPath: './src/components/TaskForm.stories.ts',
    })
    expect(
      pickStoryId(staleIndex, 'src/components/TaskForm.vue', 'FilledForm'),
    ).toBe('components-taskform--default')
  })

  it('returns null when the component has no stories at all', () => {
    expect(
      pickStoryId(taskFormIndex, 'src/components/Modal.vue', 'Anything'),
    ).toBeNull()
  })
})
