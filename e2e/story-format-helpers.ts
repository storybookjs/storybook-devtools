import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from '@playwright/test'
import { loadCsf } from 'storybook/internal/csf-tools'

/**
 * Playgrounds whose `.storybook/preview` is a CSF factory preview
 * (`definePreview`). Every other Storybook playground stays on CSF3, so both
 * generated formats are covered end to end.
 */
export const FACTORY_HOSTS: ReadonlySet<string> = new Set(['vue'])

export type StoryFileFormat = 'factory' | 'csf3'

export function expectedStoryFormat(host: string): StoryFileFormat {
  return FACTORY_HOSTS.has(host) ? 'factory' : 'csf3'
}

/** The playground's preview file, or undefined when it has no Storybook project. */
function previewFile(cwd: string): string | undefined {
  const dir = path.join(cwd, '.storybook')
  return ['preview.ts', 'preview.tsx', 'preview.js', 'preview.jsx']
    .map(name => path.join(dir, name))
    .find(file => fs.existsSync(file))
}

/** Guards the expectation itself: the preview on disk matches the format asserted. */
export function expectPreviewFormat(cwd: string, format: StoryFileFormat): void {
  const file = previewFile(cwd)
  if (!file) return
  const isFactory = /\bdefinePreview\b/.test(fs.readFileSync(file, 'utf8'))
  expect(isFactory, `${file} format`).toBe(format === 'factory')
}

/**
 * Asserts a generated story file is purely in one format. `CsfFile` rejects
 * a file that mixes `meta.story()` exports with CSF3 object exports, so
 * parsing it also proves Storybook can index the file.
 */
export function expectStoryFileFormat(
  source: string,
  fileName: string,
  format: StoryFileFormat,
  storyNames: string[],
): void {
  const csf = loadCsf(source, {
    fileName, makeTitle: title => title || 'Review',
  }).parse()
  expect(Object.keys(csf._storyExports)).toEqual(storyNames)
  if (format === 'factory') {
    expect(csf._metaIsFactory).toBe(true)
    expect(source).toMatch(/import preview from '[^']*\/preview';/)
    expect(source).toContain('preview.meta({')
    expect(source.match(/= meta\.story\(/g)).toHaveLength(storyNames.length)
    expect(source).not.toMatch(/\bStoryObj\b|\bMeta</)
    expect(source).not.toContain('export default')
    expect(source).not.toMatch(/export const \w+(: \w+)? = \{/)
  } else {
    expect(csf._metaIsFactory).toBeFalsy()
    expect(source).not.toContain('preview.meta(')
    expect(source).not.toContain('.story(')
    expect(source).toContain('export default meta')
    expect(source.match(/export const \w+: Story = \{/g)).toHaveLength(storyNames.length)
  }
}
