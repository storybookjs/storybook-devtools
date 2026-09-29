import { describe, it, expect } from 'vitest'
import { generateStory } from './story-generator'

const meta = {
  componentName: 'Button',
  filePath: '/project/src/components/Button.tsx',
  relativeFilePath: 'src/components/Button.tsx',
  sourceId: 'abc123',
  isDefaultExport: false,
}

const registry = new Map([['Icon', '/project/src/components/Icon.tsx']])

describe('react generateStory — new file', () => {
  it('serialises primitive, object, array, function and JSX props', async () => {
    const result = await generateStory({
      meta,
      componentRegistry: registry,
      props: {
        label: 'Click me',
        disabled: false,
        count: 3,
        config: { size: 'lg', nested: { deep: true } },
        items: ['a', 'b'],
        onClick: { __isFunction: true, name: 'onClick' },
        icon: {
          __isJSX: true,
          source: '<Icon name="star" />',
          componentRefs: ['Icon'],
        },
      },
    })

    expect(result.storyName).toBe('Default')
    expect(result.filePath).toBe('/project/src/components/Button.stories.tsx')
    expect(result.content).toMatchSnapshot()
  })

  it('emits a play function and its imports', async () => {
    const result = await generateStory({
      meta,
      props: { label: 'Hi' },
      playFunction: [
        'play: async ({ canvasElement }) => {',
        '  const canvas = within(canvasElement);',
        '  await userEvent.click(canvas.getByRole("button"));',
        '  await expect(canvas.getByRole("button")).toBeInTheDocument();',
        '}',
      ],
      playImports: [
        "import { userEvent, expect, within } from 'storybook/test';",
      ],
    })

    expect(result.content).toMatchSnapshot()
  })
})

describe('react generateStory — append to existing file', () => {
  const csf3 = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = {
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: 'Hello' },
};
`

  it('appends to a CSF3 satisfies-meta file', async () => {
    const result = await generateStory({
      meta,
      props: { label: 'Second', variant: 'primary' },
      existingContent: csf3,
    })

    expect(result.storyName).toBe('Primary')
    expect(result.content).toMatchSnapshot()
  })

  it('appends to a file with an inline default export', async () => {
    const existingContent = `import { Button } from './Button';

export default { component: Button };

export const Default = {
  args: { label: 'Hello' },
};
`
    const result = await generateStory({
      meta,
      props: { label: 'Second' },
      existingContent,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('suffixes the export name when the story name is taken', async () => {
    const result = await generateStory({
      meta,
      props: { label: 'Again' },
      existingContent: csf3,
    })

    expect(result.storyName).toBe('Default2')
    expect(result.content).toContain('export const Default2')
    expect(result.content).toMatchSnapshot()
  })

  it('keeps counting past an already suffixed export', async () => {
    const existingContent = `${csf3}
export const Default2: Story = {};
`
    const result = await generateStory({
      meta,
      props: { label: 'Third' },
      existingContent,
    })

    expect(result.content).toContain('export const Default3')
  })

  it('adds the fn import when the file has no storybook/test import', async () => {
    const result = await generateStory({
      meta,
      props: { onClick: { __isFunction: true, name: 'onClick' } },
      existingContent: csf3,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('merges fn into an existing storybook/test import', async () => {
    const existingContent = csf3.replace(
      "import { Button } from './Button';",
      "import { Button } from './Button';\nimport { expect } from 'storybook/test';",
    )
    const result = await generateStory({
      meta,
      props: { onClick: { __isFunction: true, name: 'onClick' } },
      existingContent,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('merges play imports into a partially populated storybook/test import', async () => {
    const existingContent = csf3.replace(
      "import { Button } from './Button';",
      "import { Button } from './Button';\nimport { within } from 'storybook/test';",
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

  it('adds a referenced component import', async () => {
    const result = await generateStory({
      meta,
      componentRegistry: registry,
      props: {
        icon: {
          __isJSX: true,
          source: '<Icon name="star" />',
          componentRefs: ['Icon'],
        },
      },
      existingContent: csf3,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('preserves leading comments, blank lines, single quotes and trailing commas', async () => {
    const existingContent = `// Button stories.
// Keep these in sync with the design system.

import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './Button'

const meta = {
  component: Button,
  args: {
    label: 'Hello',
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

/** The resting state. */
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

  it("appends when meta's component is a different component", async () => {
    const existingContent = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from './Card';

const meta = {
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
`
    const result = await generateStory({
      meta,
      props: { label: 'Hi' },
      existingContent,
    })

    expect(result.content).toMatchSnapshot()
  })

  it('appends to a file containing a CSF2 story', async () => {
    const existingContent = `import type { Meta } from '@storybook/react-vite';
import { Button } from './Button';

export default { component: Button } as Meta<typeof Button>;

export const Old = () => <Button label="old" />;
`
    const result = await generateStory({
      meta,
      props: { label: 'New', variant: 'primary' },
      existingContent,
    })

    expect(result.content).toMatchSnapshot()
  })
})
