import { describe, expect, it, vi } from 'vitest'

// Recast's default line terminator is `os.EOL` (CRLF on Windows) on
// Storybook 10 and always LF on Storybook 11. Forcing CRLF as the printer's
// default reproduces the former on any host.
vi.mock('storybook/internal/csf-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('storybook/internal/csf-tools')>()
  return {
    ...actual,
    printCsf: (csf: Parameters<typeof actual.printCsf>[0], options = {}) =>
      actual.printCsf(csf, { lineTerminator: '\r\n', ...options }),
  }
})

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
  it('keeps LF when the printer would default to CRLF', async () => {
    const result = await writeStoryIntoCsf({ ...request, existingCode: csf3 })

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
