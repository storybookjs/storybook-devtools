import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { DevframeNodeContext } from 'devframe'
import { createStory } from './create-story'
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
  expect(notify.mock.calls.every(([notification]) => notification.level === 'success')).toBe(true)
})
