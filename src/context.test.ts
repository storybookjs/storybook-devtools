import { expect, it, vi } from 'vitest'
import type { DevframeHubContext } from '@devframes/hub'
import { setStorybookDevframeContext, type CreateStorybookDevframeDeps } from './context'
import { registerStorybookHubSurfaces } from './hub-setup'
import { startStorybook } from './rpc/functions/start-storybook'
import { reactFramework } from './frameworks/react'

it('launches into the calling hub when Nuxt installs the plugin in two contexts', async () => {
  const makeHub = () => ({
    cwd: process.cwd(),
    terminals: {
      sessions: new Map(),
      startPtySession: vi.fn(async () => ({ id: 'storybook-dev', status: 'running', buffer: [] })),
      events: { on: vi.fn(() => () => {}) },
    },
    docks: { register: vi.fn() },
    commands: { register: vi.fn() },
  })
  const first = makeHub()
  const second = makeHub()
  const deps = {
    framework: reactFramework, storybookUrl: 'http://localhost:6006', logDebug: () => {},
    storybookFramework: Promise.resolve('@storybook/react-vite'),
    storyIndexService: {},
    state: { storybookSession: null, storybookStartFailure: null, transformedComponents: new Map() },
  } as unknown as CreateStorybookDevframeDeps
  for (const hub of [first, second]) {
    const ctx = hub as unknown as DevframeHubContext
    setStorybookDevframeContext(ctx, deps)
    registerStorybookHubSurfaces(ctx, { deps, devtoolsDockId: 'highlighter', dockClientScript: { importFrom: '/client.js' } })
  }
  const firstHandler = await startStorybook.setup!(first as unknown as DevframeHubContext)
  await firstHandler.handler!()
  expect(first.terminals.startPtySession).toHaveBeenCalledOnce()
  expect(second.terminals.startPtySession).not.toHaveBeenCalled()
  const secondHandler = await startStorybook.setup!(second as unknown as DevframeHubContext)
  await secondHandler.handler!()
  expect(second.terminals.startPtySession).toHaveBeenCalledOnce()
})
