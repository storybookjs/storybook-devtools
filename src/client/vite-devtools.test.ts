import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DockClientScriptContext } from '@vitejs/devtools-kit/client'

vi.mock('./overlay', () => ({
  overlayEvents: { on: vi.fn(() => () => {}) },
  showStoryCreationFeedback: vi.fn(),
  hideContextMenu: vi.fn(),
}))
vi.mock('./listeners', () => ({ autoInitRpc: vi.fn(), setRegistryRpcCall: vi.fn() }))

import clientScriptSetup from './vite-devtools'

afterEach(() => vi.unstubAllGlobals())

function createDock(isActive: boolean) {
  vi.stubGlobal('window', {})
  const handlers = new Map<string, Set<() => void>>()
  const ctx = {
    clientType: 'embedded',
    current: {
      isActive,
      entryMeta: { id: 'component-highlighter' },
      events: {
        on: (name: string, handler: () => void) => {
          const set = handlers.get(name) ?? new Set()
          set.add(handler)
          handlers.set(name, set)
          return () => set.delete(handler)
        },
      },
    },
    rpc: { ensureTrusted: vi.fn(async () => true), call: vi.fn(async () => {}) },
    docks: { toggleEntry: vi.fn() },
  }
  return {
    ctx: ctx as unknown as DockClientScriptContext,
    call: ctx.rpc.call,
    emit: (name: string) => handlers.get(name)?.forEach(handler => handler()),
  }
}

describe('highlighter action dock lifecycle', () => {
  it('activates on the first click when the host loads the action after selecting it', async () => {
    // The hub selects the entry, emits entry:activated, THEN imports its action.
    const { ctx, call } = createDock(true)
    clientScriptSetup(ctx)
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith(
      'component-highlighter:set-highlight-mode', { enabled: true },
    ))
  })

  it('does not stack activation handlers when the host executes the action again', async () => {
    const { ctx, call, emit } = createDock(false)
    clientScriptSetup(ctx)
    clientScriptSetup(ctx)
    call.mockClear()
    emit('entry:activated')
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1))
  })

  it('registers navigation and save handlers once per RPC client, including reconnects', () => {
    for (let connection = 0; connection < 2; connection++) {
      const { ctx } = createDock(false)
      const register = vi.fn()
      Object.assign(ctx.rpc, { client: { register } })
      clientScriptSetup(ctx)
      clientScriptSetup(ctx)
      expect(register.mock.calls.map(([fn]) => fn.name)).toEqual([
        'component-highlighter:do-visit-story',
        'component-highlighter:story-created',
      ])
    }
  })
})
