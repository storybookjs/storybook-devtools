import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DevframeNodeContext } from 'devframe'
import { createStory } from './create-story'
import { createStories } from './create-stories'
import { setStorybookDevframeContext, type CreateStorybookDevframeDeps } from '../../context'
import { reactFramework } from '../../frameworks/react'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

it('preserves both concurrent saves to the same story file', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-story-'))
  dirs.push(cwd)
  const ctx = { cwd, rpc: { broadcast: vi.fn(), sharedState: { get: async () => ({ value: () => [] }) } } } as unknown as DevframeNodeContext
  const notify = vi.fn()
  setStorybookDevframeContext(ctx, {
    framework: reactFramework, writeStoryFiles: true, logDebug: () => {},
    storybookFramework: Promise.resolve('@storybook/react-vite'),
    storyIndexService: { invalidate: vi.fn() },
    state: { notifications: { notify } },
  } as unknown as CreateStorybookDevframeDeps)
  const { handler } = await createStory.setup!(ctx)
  const data = { meta: { componentName: 'Button', filePath: path.join(cwd, 'Button.tsx'), sourceId: 'test' }, serializedProps: { children: 'Test' }, storyName: 'Saved' }
  await Promise.all([handler!(data), handler!(data)])
  const content = fs.readFileSync(path.join(cwd, 'Button.stories.tsx'), 'utf8')
  expect(content).toContain('export const Saved: Story')
  expect(content).toContain('export const Saved2: Story')
  expect(notify).toHaveBeenCalledTimes(2)
  expect(notify.mock.calls.every(([notification]) => notification.level === 'success')).toBe(true)
})

for (const mode of ['success', 'partial', 'disabled'] as const) {
  it(`summarizes a ${mode} batch in one notification`, async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'create-batch-'))
    dirs.push(cwd)
    const ctx = { cwd, rpc: { broadcast: vi.fn(), sharedState: { get: async () => ({ value: () => [] }) } } } as unknown as DevframeNodeContext
    const notify = vi.fn()
    setStorybookDevframeContext(ctx, {
      framework: reactFramework, writeStoryFiles: mode !== 'disabled', logDebug: () => {},
      storybookFramework: Promise.resolve('@storybook/react-vite'),
      storyIndexService: { invalidate: vi.fn() },
      state: { notifications: { notify } },
    } as unknown as CreateStorybookDevframeDeps)
    const blocked = path.join(cwd, 'blocked')
    fs.writeFileSync(blocked, 'not a directory')
    const items = ['Button', 'Badge'].map((componentName, i) => ({
      meta: { componentName, filePath: path.join(mode === 'partial' && i === 1 ? blocked : cwd, `${componentName}.tsx`), sourceId: 'test' },
      serializedProps: { children: 'Test' },
    }))
    const { handler } = await createStories.setup!(ctx)
    const result = await handler!(items)
    expect(result).toEqual(mode === 'success' ? { created: 2, failed: 0 } : mode === 'partial' ? { created: 1, failed: 1 } : { created: 0, failed: 2 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      message: mode === 'success' ? 'Created 2 stories' : mode === 'partial' ? 'Created 1 story; 1 failed' : 'Created 0 stories; 2 failed',
      level: mode === 'success' ? 'success' : 'error', toast: true,
    }))
    if (mode !== 'disabled') {
      expect(fs.existsSync(path.join(cwd, 'Button.stories.tsx'))).toBe(true)
      expect(ctx.rpc.broadcast).toHaveBeenCalledWith(expect.objectContaining({
        args: [expect.objectContaining({ skipNavigation: true })],
      }))
    }
  })
}

async function setupProject(preview: string | undefined, renderer = 'react') {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'create-story-format-')))
  dirs.push(cwd)
  const configDir = path.join(cwd, '.storybook')
  fs.mkdirSync(configDir)
  if (preview !== undefined) fs.writeFileSync(path.join(configDir, 'preview.ts'), preview)
  const ctx = { cwd, rpc: { broadcast: vi.fn(), sharedState: { get: async () => ({ value: () => [] }) } } } as unknown as DevframeNodeContext
  setStorybookDevframeContext(ctx, {
    framework: reactFramework, writeStoryFiles: true, logDebug: () => {},
    storybookFramework: Promise.resolve('@storybook/react-vite'),
    storyIndexService: { invalidate: vi.fn(), project: Promise.resolve({ configDir, renderer }) },
    state: { notifications: { notify: vi.fn() } },
  } as unknown as CreateStorybookDevframeDeps)
  const { handler } = await createStory.setup!(ctx)
  const componentPath = path.join(cwd, 'src/components/Button.tsx')
  fs.mkdirSync(path.dirname(componentPath), { recursive: true })
  const data = { meta: { componentName: 'Button', filePath: componentPath, sourceId: 'test' }, serializedProps: { children: 'Test' } }
  return { handler: handler!, data, storyFile: path.join(cwd, 'src/components/Button.stories.tsx') }
}

const factoryPreview = `import { definePreview } from '@storybook/react-vite'\nexport default definePreview({})\n`

it('creates a factory story file, then appends Create and Create with Interactions stories in factory syntax', async () => {
  const { handler, data, storyFile } = await setupProject(factoryPreview)
  await handler({ ...data, storyName: 'Plain' })
  await handler({
    ...data, storyName: 'Recorded',
    playImports: ["import { expect, userEvent, within } from 'storybook/test';"],
    playFunction: ['play: async ({ canvasElement }) => {', '  await userEvent.click(within(canvasElement).getByRole("button"));', '}'],
  })
  const content = fs.readFileSync(storyFile, 'utf8')
  expect(content).toContain("import preview from '../../.storybook/preview';")
  expect(content).toContain('const meta = preview.meta({')
  expect(content).toContain('export const Plain = meta.story({')
  expect(content).toContain('export const Recorded = meta.story({')
  expect(content).toContain('play: async ({ canvasElement }) => {')
  expect(content).not.toMatch(/StoryObj|Meta<|: Story\b|export default/)
  const { loadCsf } = await import('storybook/internal/csf-tools')
  const csf = loadCsf(content, { fileName: storyFile, makeTitle: (t: string) => t || 'Auto' }).parse()
  expect(csf._metaIsFactory).toBe(true)
  expect(Object.keys(csf._storyExports)).toEqual(['Plain', 'Recorded'])
})

it('keeps writing CSF3 for a project whose preview is not a factory preview', async () => {
  const { handler, data, storyFile } = await setupProject(`import type { Preview } from '@storybook/react-vite'\nexport default {} satisfies Preview\n`)
  await handler({ ...data, storyName: 'Plain' })
  const content = fs.readFileSync(storyFile, 'utf8')
  expect(content).toContain('export default meta;')
  expect(content).toContain('export const Plain: Story = {')
  expect(content).not.toContain('meta.story(')
})

it('keeps writing CSF3 for a project without a preview file', async () => {
  const { handler, data, storyFile } = await setupProject(undefined)
  await handler({ ...data, storyName: 'Plain' })
  expect(fs.readFileSync(storyFile, 'utf8')).toContain('export const Plain: Story = {')
})

it('appends to an existing CSF3 file as CSF3 even when the project preview is a factory preview', async () => {
  const { handler, data, storyFile } = await setupProject(factoryPreview)
  fs.mkdirSync(path.dirname(storyFile), { recursive: true })
  fs.writeFileSync(storyFile, `import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

const meta = { component: Button } satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
`)
  await handler({ ...data, storyName: 'Second' })
  const content = fs.readFileSync(storyFile, 'utf8')
  expect(content).toContain('export const Second: Story = {')
  expect(content).not.toContain('meta.story(')
  expect(content).not.toContain('import preview')
})
