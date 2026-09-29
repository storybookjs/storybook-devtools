import { describe, expect, it } from 'vitest'
import { generateStory } from '../../../src/frameworks/vue/story-generator'

describe('vue story generation from playground-like props', () => {
  it('generates a TaskList Vue story with expected imports and args', async () => {
    const story = await generateStory({
      meta: {
        componentName: 'TaskList',
        filePath: '/repo/playground/vue/src/components/TaskList.vue',
        relativeFilePath: 'playground/vue/src/components/TaskList.vue',
        sourceId: 'tasklist-vue-source-id',
        isDefaultExport: true,
      },
      props: {
        title: 'All Tasks',
        count: 3,
      },
      storyName: 'TaskListCaptured',
    })

    expect(story.filePath).toBe('/repo/playground/vue/src/components/TaskList.stories.ts')
    expect(story.content).toContain("from '@storybook/vue3-vite'")
    expect(story.content).toContain("import TaskList from './TaskList.vue';")
    expect(story.content).toContain('component: TaskList')
    expect(story.content).toContain('title: "All Tasks"')
    expect(story.content).toContain('count: 3')
    expect(story.filePath).not.toContain('unknown')
  })

  it('appends a new Vue story export to existing content', async () => {
    const existingContent = `
import type { Meta, StoryObj } from '@storybook/vue3-vite';
import TaskList from './TaskList.vue';

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
        filePath: '/repo/playground/vue/src/components/TaskList.vue',
        relativeFilePath: 'playground/vue/src/components/TaskList.vue',
        sourceId: 'tasklist-vue-source-id',
        isDefaultExport: true,
      },
      props: {
        title: 'All Tasks',
      },
      existingContent,
      storyName: 'CapturedFromRuntime',
    })

    expect(story.content).toContain('export const Default: Story')
    expect(story.content).toContain('export const Capturedfromruntime: Story')
  })
})
