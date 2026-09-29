import { describe, expect, it } from 'vitest'
import type { StorybookDevframeState } from './context'
import {
  adoptStorybookSession,
  extractErrorSnippet,
  hasTerminalsDock,
  notifyStorybookFailure,
  STORYBOOK_SESSION_ID,
  TERMINALS_DOCK_ID,
  type StorybookProcessSession,
} from './storybook-process'

function buildState(): StorybookDevframeState {
  return {
    server: undefined,
    notifications: { notify: () => {} } as never,
    transformedComponents: new Map(),
    devtoolsTerminals: null,
    storybookSession: null,
    devtoolsMessages: null,
    storybookStartFailure: null,
  }
}

function buildFakeTerminals() {
  const handlers: Array<(session: StorybookProcessSession) => void> = []
  return {
    events: {
      on: (
        _event: 'terminals:session:updated',
        handler: (session: StorybookProcessSession) => void,
      ) => {
        handlers.push(handler)
        return () => {
          const i = handlers.indexOf(handler)
          if (i >= 0) handlers.splice(i, 1)
        }
      },
    },
    emit(session: StorybookProcessSession) {
      for (const handler of [...handlers]) handler(session)
    },
    handlerCount: () => handlers.length,
  }
}

const session: StorybookProcessSession = { id: STORYBOOK_SESSION_ID }

describe('adoptStorybookSession', () => {
  it('stores the session and ignores updates for other sessions', () => {
    const state = buildState()
    const terminals = buildFakeTerminals()
    adoptStorybookSession(state, terminals, session)

    terminals.emit({ id: 'other', status: 'error' })
    expect(state.storybookSession).toBe(session)
    expect(state.storybookStartFailure).toBeNull()
  })

  it('ignores running updates for the session', () => {
    const state = buildState()
    const terminals = buildFakeTerminals()
    adoptStorybookSession(state, terminals, session)

    terminals.emit({ id: STORYBOOK_SESSION_ID, status: 'running' })
    expect(state.storybookSession).toBe(session)
  })

  it('clears the slot on a clean stop, without recording a failure', () => {
    const state = buildState()
    const terminals = buildFakeTerminals()
    adoptStorybookSession(state, terminals, session)

    terminals.emit({ id: STORYBOOK_SESSION_ID, status: 'stopped' })
    expect(state.storybookSession).toBeNull()
    expect(state.storybookStartFailure).toBeNull()
    expect(terminals.handlerCount()).toBe(0)
  })

  it('records a failure with an output snippet and notifies', async () => {
    const state = buildState()
    const terminals = buildFakeTerminals()
    let notified = 0
    // bufferFlushMs 0 — resolve on the next macrotask instead of waiting 50ms.
    adoptStorybookSession(state, terminals, session, () => notified++, 0)

    terminals.emit({
      id: STORYBOOK_SESSION_ID,
      status: 'error',
      buffer: ['\x1b[31mError:\x1b[0m storybook not found\r\n'],
    })
    // Slot clears synchronously; the failure detail is read after the flush.
    expect(state.storybookSession).toBeNull()
    expect(terminals.handlerCount()).toBe(0)

    await new Promise((r) => setTimeout(r, 5))
    expect(state.storybookStartFailure).toEqual({
      code: null,
      detail: 'Error: storybook not found',
    })
    expect(notified).toBe(1)
  })
})

describe('extractErrorSnippet', () => {
  it('returns null for empty or missing buffers', () => {
    expect(extractErrorSnippet(undefined)).toBeNull()
    expect(extractErrorSnippet([])).toBeNull()
    expect(extractErrorSnippet(['\x1b[2K\r'])).toBeNull()
  })

  it('anchors on the Storybook error code and keeps its message block', () => {
    // The real clack-formatted MainFileMissingError, boxed and followed by a
    // stack trace and a Node crash dump — all of which must be dropped.
    const log = [
      '\x1b[35m┌\x1b[0m  storybook v10.3.3\n',
      '│\n',
      '\x1b[31m■\x1b[0m  SB_CORE-SERVER_0006 (MainFileMissingError): No configuration files\n',
      '│  have been found in your configDir: ./.storybook.\n',
      '│  Storybook needs a "main.js|ts" file, please add it.\n',
      '│\n',
      '│  You can pass a --config-dir flag to tell Storybook.\n',
      '│  at validateConfigurationFiles (file:///x/chunk.js:9971:11)\n',
      '\x1b[31m▲\x1b[0m  Broken build, fix the error above.\n',
      'SB_CORE-SERVER_0006 (MainFileMissingError): No configuration files have been found in your configDir: /abs/path/.storybook.\n',
      '    at validateConfigurationFiles (file:///x/chunk.js:9971:11) {\n',
      "  code: 6,\n",
      "  _name: 'MainFileMissingError'\n",
      '}\n',
      'Node.js v22.21.1\n',
    ]
    expect(extractErrorSnippet(log)).toBe(
      [
        'SB_CORE-SERVER_0006 (MainFileMissingError): No configuration files',
        'have been found in your configDir: ./.storybook.',
        'Storybook needs a "main.js|ts" file, please add it.',
      ].join('\n'),
    )
  })

  it('falls back to a generic error signature when there is no SB code', () => {
    const log = [
      '\x1b[90m$ storybook dev\x1b[0m\n',
      'Error: Cannot find module "@storybook/react-vite"\n',
      '    at loadConfig (main.ts:8:11)\n',
      "  code: 'MODULE_NOT_FOUND'\n",
      'Node.js v22.21.1\n',
    ]
    expect(extractErrorSnippet(log)).toBe(
      'Error: Cannot find module "@storybook/react-vite"',
    )
  })

  it('collapses carriage-return spinner redraws to their final state', () => {
    expect(
      extractErrorSnippet(['\rBuilding… |\rBuilding… /\rBuild failed: boom\n']),
    ).toBe('Build failed: boom')
  })

  it('falls back to the last meaningful lines with no error signature', () => {
    const snippet = extractErrorSnippet(
      ['│  starting\n', '│  compiling\n', '│  done but weird\n'],
      2,
    )
    expect(snippet).toBe('compiling\ndone but weird')
  })

  it('caps the snippet length', () => {
    const snippet = extractErrorSnippet([`Error: ${'x'.repeat(500)}`])
    expect(snippet?.length).toBeLessThanOrEqual(321)
    expect(snippet?.endsWith('…')).toBe(true)
  })
})

describe('notifyStorybookFailure', () => {
  it('posts an error message with an open-terminal activate action when the Terminals dock exists', () => {
    const state = buildState()
    state.devtoolsDocks = {
      values: () => [{ id: TERMINALS_DOCK_ID }, { id: 'storybook-devtools' }],
    }
    const calls: Array<{ message: string; extra: Record<string, unknown> }> = []
    state.devtoolsMessages = {
      error: (message: string, extra: Record<string, unknown>) => {
        calls.push({ message, extra })
        return Promise.resolve()
      },
    }

    notifyStorybookFailure(state)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.extra['actions']).toEqual([
      expect.objectContaining({
        kind: 'activate',
        activate: {
          dockId: TERMINALS_DOCK_ID,
          params: { sessionId: STORYBOOK_SESSION_ID },
        },
      }),
    ])
  })

  it('omits the open-terminal action when no Terminals dock is registered', () => {
    const state = buildState()
    state.devtoolsDocks = { values: () => [{ id: 'storybook-devtools' }] }
    const calls: Array<{ message: string; extra: Record<string, unknown> }> = []
    state.devtoolsMessages = {
      error: (message: string, extra: Record<string, unknown>) => {
        calls.push({ message, extra })
        return Promise.resolve()
      },
    }

    notifyStorybookFailure(state)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.extra).not.toHaveProperty('actions')
    expect(calls[0]?.extra['description']).toContain('shell')
  })

  it('is a no-op without a messages host', () => {
    const state = buildState()
    expect(() => notifyStorybookFailure(state)).not.toThrow()
  })
})

describe('hasTerminalsDock', () => {
  it('is false without a docks host or without the dock', () => {
    expect(hasTerminalsDock(buildState())).toBe(false)
    const state = buildState()
    state.devtoolsDocks = { values: () => [] }
    expect(hasTerminalsDock(state)).toBe(false)
  })

  it('is true when the Terminals dock is registered', () => {
    const state = buildState()
    state.devtoolsDocks = { values: () => [{ id: TERMINALS_DOCK_ID }] }
    expect(hasTerminalsDock(state)).toBe(true)
  })
})
