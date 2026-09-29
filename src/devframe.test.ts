import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createHubContext } from '@devframes/hub/node'
import { createStorybookDevframe } from './devframe'
import type { CreateStorybookDevframeDeps } from './context'
import { reactFramework } from './frameworks/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import messages from '@devframes/plugin-messages'
import { createComponentHighlighterPlugin } from './create-component-highlighter-plugin'
import type { Plugin, ResolvedConfig } from 'vite'
import type { ViteDevToolsNodeContext } from '@vitejs/devtools-kit'

describe('devframe open service', () => {
  it.each(['vite', 'portable'] as const)('registers editor RPCs once on %s', async (kind) => {
    const storage = await mkdtemp(join(tmpdir(), 'devtools-service-test-'))
    onTestFinished(() => rm(storage, { recursive: true, force: true }))
    const ctx = await createHubContext({
      cwd: process.cwd(), mode: 'dev',
      host: {
        getStorageDir: () => storage,
        mountStatic: vi.fn(), mountConnectionMeta: vi.fn(),
        resolveOrigin: () => 'http://localhost',
      },
    })
    const definition = createStorybookDevframe({
      framework: reactFramework,
      state: { transformedComponents: new Map() },
    } as unknown as CreateStorybookDevframeDeps)
    const register = vi.spyOn(ctx.rpc, 'register')
    if (kind === 'vite') {
      // Vite installs built-ins sequentially after the first ready barrier.
      await ctx.services.ready()
      await ctx.install(messages())
      const [transform, mount] = createComponentHighlighterPlugin(reactFramework) as [Plugin, Plugin]
      const resolveConfig = transform.configResolved as (config: ResolvedConfig) => void
      resolveConfig({ root: process.cwd(), command: 'serve', base: '/' } as ResolvedConfig)
      ctx.staticConfig.dock = { clientModuleResolution: '/@id/{specifier}' }
      await mount.devtools!.setup!(ctx as ViteDevToolsNodeContext)
    } else {
      await ctx.install(definition)
    }
    await vi.waitFor(() => expect(ctx.services.has('@devframes/service-open')).toBe(true))
    expect(register.mock.calls.filter(([fn]) =>
      fn.name === 'devframes:service:open:open-in-editor',
    )).toHaveLength(1)
    expect(ctx.services.has('@devframes/service-open')).toBe(true)
  })
})
