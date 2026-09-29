import { describe, expect, it } from 'vitest'
import { generateStory } from '../../../src/frameworks/react/story-generator'

describe('react story generation from playground-like props', () => {
  it('generates a TaskList story with correct file path and imports', async () => {
    const story = await generateStory({
      meta: {
        componentName: 'TaskList',
        filePath: '/repo/playground/react/src/components/TaskList.tsx',
        relativeFilePath: 'playground/react/src/components/TaskList.tsx',
        sourceId: 'tasklist-source-id',
        isDefaultExport: false,
      },
      props: {
        title: 'All Tasks',
        count: 3,
        children: {
          __isJSX: true,
          source:
            '<><TaskCard task={{ id: "1", title: "Review" }} onAction={function noRefCheck() {}} /><Button variant="secondary">Load more</Button></>',
          componentRefs: ['TaskCard', 'Button'],
        },
      },
      componentRegistry: new Map([
        ['TaskCard', '/repo/playground/react/src/components/TaskCard.tsx'],
        ['Button', '/repo/playground/react/src/components/Button.tsx'],
      ]),
      storyName: 'TaskListCaptured',
    })

    expect(story.filePath).toBe(
      '/repo/playground/react/src/components/TaskList.stories.tsx',
    )
    expect(story.storyName).toBe('Tasklistcaptured')

    expect(story.content).toContain("import { TaskList } from './TaskList';")
    expect(story.content).toContain("import { TaskCard } from './TaskCard';")
    expect(story.content).toContain("import { Button } from './Button';")
    expect(story.content).toContain('component: TaskList')
    expect(story.content).toContain('title: "All Tasks"')
    expect(story.content).toContain('count: 3')
    expect(story.content).toContain('children:')
    expect(story.content).toContain('onAction={fn()}')
    expect(story.content).not.toContain('function noRefCheck() {}')

    // Guard against regressions like unknown.stories.tsx / unknown metadata bleed.
    expect(story.filePath).not.toContain('unknown')
    expect(story.content).not.toContain('unknown.stories')
  })

  it('appends to an existing story file without breaking imports', async () => {
    const existingContent = `
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TaskList } from './TaskList';

const meta: Meta<typeof TaskList> = {
  component: TaskList,
};

export default meta;
type Story = StoryObj<typeof TaskList>;

export const Default: Story = {
  args: {
    title: 'Default',
  },
};
`

    const story = await generateStory({
      meta: {
        componentName: 'TaskList',
        filePath: '/repo/playground/react/src/components/TaskList.tsx',
        relativeFilePath: 'playground/react/src/components/TaskList.tsx',
        sourceId: 'tasklist-source-id',
        isDefaultExport: false,
      },
      props: {
        title: 'All Tasks',
      },
      existingContent,
      storyName: 'CapturedFromRuntime',
    })

    expect(story.content).toContain('export const Default: Story')
    expect(story.content).toContain('export const Capturedfromruntime: Story')
    expect(story.content).toContain("import { TaskList } from './TaskList';")
  })
})
