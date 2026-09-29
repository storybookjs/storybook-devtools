import { describe, it, expect } from 'vitest'
import { generateStory } from './story-generator'

const meta = {
  componentName: 'BaseButton',
  filePath: '/project/src/components/BaseButton.vue',
  relativeFilePath: 'src/components/BaseButton.vue',
  sourceId: 'abc123',
  isDefaultExport: true,
}

const registry = new Map([['BaseIcon', '/project/src/components/BaseIcon.vue']])

const csf3 = `import type { Meta, StoryObj } from '@storybook/vue3-vite';
import BaseButton from './BaseButton.vue';

const meta = {
  component: BaseButton,
} satisfies Meta<typeof BaseButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: 'Hello' },
};
`

describe('vue generateStory — new file', () => {
  it('serialises props and imports the component with a .vue extension', async () => {
    const result = await generateStory({
      meta,
      props: {
        label: 'Click me',
        disabled: false,
        config: { size: 'lg' },
        items: ['a', 'b'],
        onClick: { __isFunction: true, name: 'onClick' },
      },
    })

    expect(result.filePath).toBe('/project/src/components/BaseButton.stories.ts')
    expect(result.content).toContain("from './BaseButton.vue'")
    expect(result.content).toMatchSnapshot()
  })

  it('builds a render template from slot args', async () => {
    const result = await generateStory({
      meta,
      componentRegistry: registry,
      props: {
        label: 'With slots',
        'slot:default': {
          __isVueSlot: true,
          source: '<BaseIcon name="star" />',
          componentRefs: ['BaseIcon'],
        },
        'slot:footer': 'Footer text',
      },
    })

    expect(result.content).toMatchSnapshot()
  })
})

describe('vue generateStory — append to existing file', () => {
  it('appends to a CSF3 satisfies-meta file', async () => {
    const result = await generateStory({
      meta,
      props: { label: 'Second', variant: 'primary' },
      existingContent: csf3,
    })

    expect(result.storyName).toBe('Primary')
    expect(result.content).toMatchSnapshot()
  })

  it('suffixes the export name when the story name is taken', async () => {
    const result = await generateStory({
      meta,
      props: { label: 'Again' },
      existingContent: csf3,
    })

    expect(result.content).toContain('export const Default2')
    expect(result.content).toMatchSnapshot()
  })

  it('adds the fn import when the file has no storybook/test import', async () => {
    const result = await generateStory({
      meta,
      props: { onClick: { __isFunction: true, name: 'onClick' } },
      existingContent: csf3,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('merges play imports into an existing storybook/test import', async () => {
    const existingContent = csf3.replace(
      "import BaseButton from './BaseButton.vue';",
      "import BaseButton from './BaseButton.vue';\nimport { within } from 'storybook/test';",
    )
    const result = await generateStory({
      meta,
      props: { label: 'Hi' },
      existingContent,
      playFunction: [
        'play: async ({ canvasElement }) => {',
        '  const canvas = within(canvasElement);',
        '  await userEvent.click(canvas.getByRole("button"));',
        '}',
      ],
      playImports: [
        "import { userEvent, expect, within } from 'storybook/test';",
      ],
    })

    expect(result.content).toMatchSnapshot()
  })

  it('appends a slot render template and its component import', async () => {
    const result = await generateStory({
      meta,
      componentRegistry: registry,
      props: {
        'slot:default': {
          __isVueSlot: true,
          source: '<BaseIcon name="star" />',
          componentRefs: ['BaseIcon'],
        },
      },
      existingContent: csf3,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('preserves leading comments, blank lines and single quotes', async () => {
    const existingContent = `// BaseButton stories.

import type { Meta, StoryObj } from '@storybook/vue3-vite'
import BaseButton from './BaseButton.vue'

const meta = {
  component: BaseButton,
} satisfies Meta<typeof BaseButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    label: 'Hello',
  },
}
`
    const result = await generateStory({
      meta,
      props: { label: 'Second', variant: 'ghost' },
      existingContent,
    })

    expect(result.content).toMatchSnapshot()
  })
})
