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

describe('react generateStory — CSF factories', () => {
  const factoryFormat = {
    kind: 'factory' as const,
    previewImport: '../../../.storybook/preview',
  }

  async function parse(source: string) {
    const { loadCsf } = await import('storybook/internal/csf-tools')
    return loadCsf(source, {
      fileName: '/project/src/components/Button.stories.tsx',
      makeTitle: (title: string) => title || 'Auto',
    }).parse()
  }

  it('writes a new story file with preview.meta and meta.story, without Meta/StoryObj', async () => {
    const result = await generateStory({
      meta,
      props: { label: 'Click me', disabled: false },
      storyFormat: factoryFormat,
    })

    expect(result.content).toBe(`import preview from '../../../.storybook/preview';
import { Button } from './Button';

const meta = preview.meta({
  component: Button,
});

export const Default = meta.story({
  args: {
    label: "Click me",
    disabled: false,
  },
});
`)
    expect(result.content).not.toContain('StoryObj')
    expect(result.content).not.toContain('Meta<')
    expect(result.content).not.toContain('export default')
    const csf = await parse(result.content)
    expect(csf._metaIsFactory).toBe(true)
    expect(Object.keys(csf._storyExports)).toEqual(['Default'])
  })

  it('carries a recorded play function and its storybook/test imports over unchanged', async () => {
    const play = [
      'play: async ({ canvasElement }) => {',
      '  const canvas = within(canvasElement);',
      '  await userEvent.click(canvas.getByRole("button"));',
      '  await expect(canvas.getByRole("button")).toBeInTheDocument();',
      '}',
    ]
    const imports = ["import { userEvent, expect, within } from 'storybook/test';"]
    const factory = await generateStory({
      meta,
      props: { label: 'Hi' },
      playFunction: play,
      playImports: imports,
      storyFormat: factoryFormat,
    })
    const csf3 = await generateStory({
      meta,
      props: { label: 'Hi' },
      playFunction: play,
      playImports: imports,
    })

    expect(factory.content).toContain(
      "import { userEvent, expect, within } from 'storybook/test';",
    )
    expect(factory.content).toContain(`export const Default = meta.story({
  args: {
    label: "Hi",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button"));
    await expect(canvas.getByRole("button")).toBeInTheDocument();
  },
});
`)
    // The story body is byte-identical to the CSF3 one; only the wrapper differs.
    const body = (source: string) =>
      source.slice(source.indexOf('{', source.indexOf('export const Default')))
    expect(body(factory.content).replace(/\);\n$/, ';\n')).toBe(body(csf3.content))
    expect((await parse(factory.content))._metaIsFactory).toBe(true)
  })

  it('keeps JSX args, the React import and fn() props in factory files', async () => {
    const result = await generateStory({
      meta,
      componentRegistry: registry,
      props: {
        onClick: { __isFunction: true, name: 'onClick' },
        icon: { __isJSX: true, source: '<Icon name="star" />', componentRefs: ['Icon'] },
      },
      storyFormat: factoryFormat,
    })

    expect(result.content).toContain("import React from 'react';")
    expect(result.content).toContain("import { fn } from 'storybook/test';")
    expect(result.content).toContain("import { Icon } from './Icon';")
    expect(result.content).toContain('onClick: fn()')
    expect(result.content).toContain('icon: <Icon name="star" />')
    expect((await parse(result.content))._metaIsFactory).toBe(true)
  })

  it('appends to a factory file as meta.story using the file\'s meta name', async () => {
    const existingContent = `import preview from '../../../.storybook/preview';

import { Button } from './Button';

const buttonMeta = preview.meta({
  component: Button,
});

export const Default = buttonMeta.story({
  args: { label: 'Hello' },
});
`
    const result = await generateStory({
      meta,
      props: { label: 'Second', variant: 'primary' },
      existingContent,
      // The project's preview is irrelevant to an append.
      storyFormat: { kind: 'csf3' },
    })

    expect(result.storyName).toBe('Primary')
    expect(result.content).toBe(`${existingContent}
export const Primary = buttonMeta.story({
  args: {
    label: "Second",
    variant: "primary",
  },
});
`)
    const csf = await parse(result.content)
    expect(csf._metaIsFactory).toBe(true)
    expect(Object.keys(csf._storyExports)).toEqual(['Default', 'Primary'])
  })

  it('appends a recorded play function to a factory file, merging the test imports', async () => {
    const existingContent = `import preview from '../../../.storybook/preview';
import { within } from 'storybook/test';

import { Button } from './Button';

const meta = preview.meta({
  component: Button,
});

export const Default = meta.story({});
`
    const result = await generateStory({
      meta,
      props: { label: 'Hi' },
      storyName: 'Recorded',
      existingContent,
      playFunction: [
        'play: async ({ canvasElement }) => {',
        '  await userEvent.click(within(canvasElement).getByRole("button"));',
        '}',
      ],
      playImports: ["import { userEvent, within } from 'storybook/test';"],
    })

    expect(result.content).toContain("import { within, userEvent } from 'storybook/test';")
    expect(result.content).toContain('export const Recorded = meta.story({')
    expect(result.content).toContain('  play: async ({ canvasElement }) => {')
    expect(result.content).not.toContain(': Story')
    expect((await parse(result.content))._metaIsFactory).toBe(true)
  })

  it('follows a CSF3 file\'s format even when the project is on factories', async () => {
    const existingContent = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = {
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
`
    const result = await generateStory({
      meta,
      props: { label: 'Second' },
      existingContent,
      storyFormat: factoryFormat,
    })

    expect(result.content).toContain('export const Default2: Story = {')
    expect(result.content).not.toContain('meta.story(')
    expect(result.content).not.toContain('preview')
    const csf = await parse(result.content)
    expect(csf._metaIsFactory).toBeFalsy()
  })
})
