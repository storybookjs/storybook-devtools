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
