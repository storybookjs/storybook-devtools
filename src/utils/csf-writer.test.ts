import { describe, it, expect } from 'vitest'
import { babelParse } from 'storybook/internal/babel'
import { writeStoryIntoCsf } from './csf-writer'

const story = `export const Primary: Story = {
  args: {
    label: "Second",
  },
};
`

const csf3 = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = {
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
`

const base = {
  fileName: '/project/src/Button.stories.tsx',
  storyExportSource: story,
  desiredExportName: 'Primary',
  requiredImports: [],
}

describe('writeStoryIntoCsf', () => {
  it('appends through the CSF AST, not the fallback', async () => {
    const result = await writeStoryIntoCsf({ ...base, existingCode: csf3 })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.exportName).toBe('Primary')
    expect(result.code).toContain('export const Primary: Story = {')
  })

  it('dedupes against non-story top-level bindings too', async () => {
    const existingCode = csf3.replace(
      'export default meta;',
      'export default meta;\nconst Primary = 1;\nvoid Primary;',
    )
    const result = await writeStoryIntoCsf({ ...base, existingCode })

    expect(result.exportName).toBe('Primary2')
    expect(result.fallbackReason).toBeUndefined()
  })

  it('extends an existing import rather than adding a second one', async () => {
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode: csf3.replace(
        "import { Button } from './Button';",
        "import { Button } from './Button';\nimport { within } from 'storybook/test';",
      ),
      requiredImports: [{ source: 'storybook/test', specifiers: ['fn'] }],
    })

    expect(result.code).toContain(
      "import { within, fn } from 'storybook/test';",
    )
  })

  it('falls back to a text splice when the file is not CSF', async () => {
    const existingCode = `import { Button } from './Button';

export const Default = { args: { label: 'Hello' } };
`
    const result = await writeStoryIntoCsf({ ...base, existingCode })

    expect(result.fallbackReason).toBeTruthy()
    expect(result.code).toContain('export const Primary: Story = {')
    expect(result.code).toContain("import { Button } from './Button';")
  })

  it('dedupes in the fallback path as well', async () => {
    const existingCode = `import { Button } from './Button';

export const Primary = { args: { label: 'Hello' } };
`
    const result = await writeStoryIntoCsf({ ...base, existingCode })

    expect(result.fallbackReason).toBeTruthy()
    expect(result.exportName).toBe('Primary2')
    expect(result.code).toContain('export const Primary2: Story = {')
  })

  it('does not merge a value specifier into a type-only import', async () => {
    const existingCode = csf3.replace(
      "import { Button } from './Button';",
      "import { Button } from './Button';\nimport type { fn } from 'storybook/test';",
    )
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode,
      requiredImports: [{ source: 'storybook/test', specifiers: ['fn'] }],
    })

    expect(result.fallbackReason).toBeUndefined()
    expect(() => babelParse(result.code)).not.toThrow()
    expect(result.code).toContain("import { fn } from 'storybook/test';")
  })

  it('inserts a separate import type when the request is typeOnly and only a value import exists', async () => {
    const existingCode = csf3.replace(
      "import { Button } from './Button';",
      "import { Button } from './Button';\nimport { fn } from 'storybook/test';",
    )
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode,
      requiredImports: [
        { source: 'storybook/test', specifiers: ['Mock'], typeOnly: true },
      ],
    })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.code).toContain("import { fn } from 'storybook/test';")
    expect(result.code).toContain(
      "import type { Mock } from 'storybook/test';",
    )
  })

  it('does not mistake an unrelated imported symbol for a requested helper', async () => {
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode: csf3 + "\nimport { spyOn as fn } from 'storybook/test';\n",
      storyExportSource: 'export const Primary: Story = { args: { onClick: fn() } };',
      requiredImports: [{ source: 'storybook/test', specifiers: ['fn'] }],
    })
    expect(result.fallbackReason).toBeUndefined()
    expect(() => babelParse(result.code)).not.toThrow()
    expect(result.code).toMatch(/fn as fn2/)
    expect(result.code).toContain('onClick: fn2()')
  })

  it('defines the requested default binding when the existing import has an alias', async () => {
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode: csf3.replace("import { Button } from './Button';", "import ExistingButton from './Button';"),
      storyExportSource: 'export const Primary: Story = { render: () => Button };',
      requiredImports: [{ source: './Button', defaultSpecifier: 'Button' }],
    })
    expect(result.fallbackReason).toBeUndefined()
    expect(() => babelParse(result.code)).not.toThrow()
    expect(result.code).toContain('render: () => ExistingButton')
  })

  it('dedupes exports against destructured bindings and required imports', async () => {
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode: csf3 + '\nconst { Primary } = { Primary: 1 };',
    })
    expect(result.exportName).toBe('Primary2')
    expect(() => babelParse(result.code)).not.toThrow()
  })

  it('avoids imported aliases shadowed by locals in the new play function', async () => {
    const result = await writeStoryIntoCsf({
      ...base,
      existingCode: csf3 + "\nimport { within as canvas } from 'storybook/test';",
      storyExportSource: 'export const Primary: Story = { play: ({ canvasElement }) => { const canvas = within(canvasElement); } };',
      requiredImports: [{ source: 'storybook/test', specifiers: ['within'] }],
    })
    expect(result.fallbackReason).toBeUndefined()
    expect(result.code).toContain('const canvas = within(canvasElement)')
    expect(() => babelParse(result.code)).not.toThrow()
  })

  it('reserves component imports before choosing the story export name', async () => {
    const result = await writeStoryIntoCsf({
      ...base,
      desiredExportName: 'Button',
      existingCode: csf3.replace("import { Button } from './Button';", "import ExistingButton from './Button';"),
      storyExportSource: 'export const Button: Story = { render: () => ({ components: { Button }, template: `<Button/>` }) };',
      requiredImports: [{ source: './Button', defaultSpecifier: 'Button' }],
    })
    expect(result.exportName).toBe('Button2')
    expect(result.code).toContain('Button: ExistingButton')
    expect(result.fallbackReason).toBeUndefined()
  })

  it('round-trips CRLF line endings, including the appended story', async () => {
    const crlfCsf = csf3.replace(/\n/g, '\r\n')
    const result = await writeStoryIntoCsf({ ...base, existingCode: crlfCsf })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.code).toContain('\r\n')
    expect(result.code).not.toMatch(/\r\r\n/)
    expect(result.code.replace(/\r\n/g, '\n')).not.toContain('\r')
    expect(result.code).toContain('export const Primary: Story = {\r\n')
  })
})

