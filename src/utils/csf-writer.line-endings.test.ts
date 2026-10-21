import { describe, expect, it } from 'vitest'
import { writeStoryIntoCsf } from './csf-writer'

const csf3 = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = {
  component: Button,
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
`

const request = {
  fileName: '/project/src/Button.stories.tsx',
  storyObjectSource: `{
  args: {
    label: "Second",
  },
}`,
  desiredExportName: 'Primary',
  requiredImports: [{ source: 'storybook/test', specifiers: ['fn'] }],
}

describe('writeStoryIntoCsf line endings', () => {
  it('keeps LF', async () => {
    const result = await writeStoryIntoCsf({ ...request, existingCode: csf3 })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.code).toContain('export const Primary: Story = {')
    expect(result.code).not.toContain('\r')
  })

  // csf-tools ends every line like the file's first one; the writer
  // follows the majority instead.
  it('keeps LF when only the first line ends in CRLF', async () => {
    const existingCode = csf3.replace('\n', '\r\n')
    const result = await writeStoryIntoCsf({ ...request, existingCode })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.code).toContain('export const Primary: Story = {')
    expect(result.code).not.toContain('\r')
  })

  it('keeps CRLF, with every line CRLF, when the file used it', async () => {
    const result = await writeStoryIntoCsf({
      ...request,
      existingCode: csf3.replace(/\n/g, '\r\n'),
    })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.code.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(result.code).toContain('export const Primary: Story = {\r\n')
  })

  it('keeps LF through the regex fallback', async () => {
    const result = await writeStoryIntoCsf({
      ...request,
      existingCode: 'import x from "y"\nexport const A = 1\n',
    })

    expect(result.fallbackReason).toBeDefined()
    expect(result.code).not.toContain('\r')
  })
})
