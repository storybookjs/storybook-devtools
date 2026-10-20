import { expect, it, vi } from 'vitest'
import { describeFor } from '../test-utils/csf-tools'

// Recast's default line terminator is `os.EOL` (CRLF on Windows) on
// Storybook 10. Forcing CRLF as the printer's default reproduces that on
// any host. Storybook 11 edits text and has no such default.
vi.mock('storybook/internal/csf-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('storybook/internal/csf-tools')>()
  return {
    ...actual,
    printCsf: (csf: Parameters<typeof actual.printCsf>[0], options = {}) =>
      (actual.printCsf as (...args: unknown[]) => ReturnType<typeof actual.printCsf>)(
        csf,
        { lineTerminator: '\r\n', ...options },
      ),
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

describeFor('babel', 'writeStoryIntoCsf with the recast printer', () => {
  it('keeps LF when the printer would default to CRLF', async () => {
    const result = await writeStoryIntoCsf({ ...request, existingCode: csf3 })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.code).toContain('export const Primary: Story = {')
    expect(result.code).not.toContain('\r')
  })
})
