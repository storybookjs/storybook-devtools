import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { findFactoryPreview, resolveStoryFormat } from './csf-format'

const factoryPreview = `import { definePreview } from '@storybook/react-vite'
export default definePreview({ parameters: {} })
`
const csf3Preview = `import type { Preview } from '@storybook/react-vite'
const preview: Preview = { parameters: {} }
export default preview
`

describe('CSF factory detection', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function project(files: Record<string, string>): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'csf-format-')))
    dirs.push(root)
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content)
    }
    return root
  }

  describe('findFactoryPreview', () => {
    it.each(['preview.ts', 'preview.tsx', 'preview.js', 'preview.jsx'])(
      'finds a definePreview preview in %s',
      async (name) => {
        const root = project({ [`.storybook/${name}`]: factoryPreview })
        expect(await findFactoryPreview(path.join(root, '.storybook'))).toBe(
          path.join(root, '.storybook', name),
        )
      },
    )

    it('reports a plain CSF3 preview as not a factory preview', async () => {
      const root = project({ '.storybook/preview.ts': csf3Preview })
      expect(await findFactoryPreview(path.join(root, '.storybook'))).toBeUndefined()
    })

    it('reports a missing preview file as not a factory preview', async () => {
      const root = project({ '.storybook/main.ts': 'export default {}' })
      expect(await findFactoryPreview(path.join(root, '.storybook'))).toBeUndefined()
    })

    it('reports a missing config directory as not a factory preview', async () => {
      expect(await findFactoryPreview('/nonexistent/.storybook')).toBeUndefined()
    })

    it('does not throw on a preview that fails to parse', async () => {
      const root = project({ '.storybook/preview.ts': 'export default definePreview({ ((( ' })
      await expect(findFactoryPreview(path.join(root, '.storybook'))).resolves.toBeUndefined()
    })

    it('ignores a definePreview import from a non-storybook package', async () => {
      const root = project({
        '.storybook/preview.ts': `import { definePreview } from 'other-lib'\nexport default definePreview({})`,
      })
      expect(await findFactoryPreview(path.join(root, '.storybook'))).toBeUndefined()
    })
  })

  describe('resolveStoryFormat', () => {
    it('is CSF3 without a Storybook config directory', async () => {
      expect(await resolveStoryFormat({ storyFilePath: '/x/src/A.stories.tsx' })).toEqual({
        kind: 'csf3',
      })
    })

    it('is CSF3 for a CSF3 preview', async () => {
      const root = project({ '.storybook/preview.ts': csf3Preview })
      expect(
        await resolveStoryFormat({
          configDir: path.join(root, '.storybook'),
          renderer: 'react',
          storyFilePath: path.join(root, 'src/A.stories.tsx'),
        }),
      ).toEqual({ kind: 'csf3' })
    })

    it('uses a relative preview import, without extension, when there is no imports map', async () => {
      const root = project({
        'package.json': '{"name":"x"}',
        '.storybook/preview.ts': factoryPreview,
      })
      expect(
        await resolveStoryFormat({
          configDir: path.join(root, '.storybook'),
          renderer: 'react',
          storyFilePath: path.join(root, 'src/components/Button.stories.tsx'),
        }),
      ).toEqual({ kind: 'factory', previewImport: '../../.storybook/preview' })
    })

    it('prefixes ./ when the story sits beside the config directory', async () => {
      const root = project({ '.storybook/preview.ts': factoryPreview })
      expect(
        await resolveStoryFormat({
          configDir: path.join(root, '.storybook'),
          renderer: 'vue3',
          storyFilePath: path.join(root, 'Button.stories.ts'),
        }),
      ).toEqual({ kind: 'factory', previewImport: './.storybook/preview' })
    })

    it('uses the #.storybook/preview subpath import when package.json declares imports', async () => {
      const root = project({
        'package.json': JSON.stringify({ imports: { '#*': ['./*', './*.ts'] } }),
        '.storybook/preview.ts': factoryPreview,
      })
      expect(
        await resolveStoryFormat({
          configDir: path.join(root, '.storybook'),
          renderer: 'react',
          storyFilePath: path.join(root, 'src/components/Button.stories.tsx'),
        }),
      ).toEqual({ kind: 'factory', previewImport: '#.storybook/preview' })
    })

    it('finds an imports map in an ancestor of the config directory', async () => {
      const root = project({
        'package.json': JSON.stringify({ imports: { '#*': ['./*'] } }),
        'apps/web/.storybook/preview.ts': factoryPreview,
      })
      expect(
        await resolveStoryFormat({
          configDir: path.join(root, 'apps/web/.storybook'),
          renderer: 'react',
          storyFilePath: path.join(root, 'apps/web/src/A.stories.tsx'),
        }),
      ).toEqual({ kind: 'factory', previewImport: '#.storybook/preview' })
    })

    it('stays CSF3 for a renderer the generators do not emit factories for', async () => {
      const root = project({ '.storybook/preview.ts': factoryPreview })
      expect(
        await resolveStoryFormat({
          configDir: path.join(root, '.storybook'),
          renderer: 'svelte',
          storyFilePath: path.join(root, 'src/A.stories.ts'),
        }),
      ).toEqual({ kind: 'csf3' })
    })
  })
})
