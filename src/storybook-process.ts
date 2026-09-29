import type { StorybookDevframeState } from './context'

/**
 * Dock id of devframe's built-in Terminals dock (hub-ui's
 * `devframes_plugin_terminals` constant, not exported by the package).
 * Activating it with `{ sessionId }` deep-links to one session.
 */
export const TERMINALS_DOCK_ID = 'devframes_plugin_terminals'

/** Terminal session id of the Storybook dev-server process. */
export const STORYBOOK_SESSION_ID = 'storybook-dev'

/**
 * Structural slice of a devframe PTY terminal session — enough for lifecycle
 * tracking and reading the scrollback, without importing the hub host package.
 */
export interface StorybookProcessSession {
  id: string
  status?: string
  /** Terminal scrollback, newest chunks last (raw, with ANSI/control codes). */
  buffer?: string[]
}

interface TerminalsHostSlice {
  events: {
    on: (
      event: 'terminals:session:updated',
      handler: (session: StorybookProcessSession) => void,
    ) => () => void
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
// Leading whitespace + clack/box-drawing/marker glyphs (│ ┌ └ ├ ─ ■ ▲ ◆ ● ✗ …).
const BOX_PREFIX = /^[\s─-╿■-◿✓-✘×]+/
// Stack frames, module URLs, the crash caret, and the re-thrown raw error —
// noise that follows the human-readable message.
const NOISE_LINE =
  /^(at\s|file:\/\/|node:|Node\.js v|\^+\s*$|throw\s|[a-z_]+:\s|\}|\{$)/
// A Storybook CLI error code, e.g. `SB_CORE-SERVER_0006`.
const SB_ERROR = /\bSB_[A-Z0-9][A-Z0-9_-]*_\d+\b/
// A generic error signature to fall back on when there's no SB code.
const GENERIC_ERROR =
  /([A-Z][A-Za-z]*Error\b|\bCannot find\b|\bENOENT\b|\bEACCES\b|\bnot found\b)/

function cleanLine(raw: string): string {
  // A line rewritten in place (spinner, progress) keeps only its final state,
  // then loses its clack/box prefix.
  return (raw.split('\r').pop() ?? raw).replace(BOX_PREFIX, '').trimEnd()
}

function cap(snippet: string, maxChars: number): string {
  return snippet.length > maxChars
    ? `${snippet.slice(0, maxChars).trimEnd()}…`
    : snippet
}

/**
 * Distill a PTY scrollback into a short, plain-text failure preview. Strips
 * ANSI/OSC and clack box-drawing prefixes, then anchors on the actual error
 * — a Storybook `SB_*` code if present, else a generic error signature — and
 * returns that line plus its immediate message, stopping at the first blank
 * or stack frame so the Node crash dump and stack trace stay in the terminal.
 * Falls back to the last meaningful lines when no error signature is found.
 * Best-effort — the full output lives in the Terminals dock.
 */
export function extractErrorSnippet(
  buffer: string[] | undefined,
  maxLines = 5,
  maxChars = 320,
): string | null {
  if (!buffer?.length) return null
  const lines = buffer.join('').replace(ANSI, '').split(/\r?\n/).map(cleanLine)

  let anchor = lines.findIndex((line) => SB_ERROR.test(line))
  if (anchor < 0) {
    anchor = lines.findIndex(
      (line) => GENERIC_ERROR.test(line) && !NOISE_LINE.test(line),
    )
  }

  if (anchor >= 0) {
    const collected: string[] = []
    for (let i = anchor; i < lines.length && collected.length < maxLines; i++) {
      const line = lines[i]!
      if (!line.trim()) {
        if (collected.length) break
        continue
      }
      if (i > anchor && NOISE_LINE.test(line)) break
      collected.push(line)
    }
    const snippet = collected.join('\n').trim()
    if (snippet) return cap(snippet, maxChars)
  }

  // No recognizable error line — show the last meaningful, non-noise lines.
  const meaningful = lines.filter(
    (line) => line.trim() && /[A-Za-z0-9]/.test(line) && !NOISE_LINE.test(line),
  )
  if (!meaningful.length) return null
  return cap(meaningful.slice(-maxLines).join('\n').trim(), maxChars)
}

/**
 * Wire a spawned Storybook PTY session into the shared state: watch the
 * terminals host for the session leaving `running`, record a start failure
 * when it errored, and clear the session slot so the next start can respawn.
 * The dead session stays registered in the terminals host — its scrollback
 * is where the failure detail lives — and is only dropped by the next start.
 */
export function adoptStorybookSession(
  state: StorybookDevframeState,
  terminals: TerminalsHostSlice,
  session: StorybookProcessSession,
  onError?: () => void,
  // The host drains the stream's final chunks (the error text) a tick after
  // it marks the session `error`; wait briefly so `buffer` is complete.
  bufferFlushMs = 50,
): void {
  state.storybookSession = session
  const unbind = terminals.events.on('terminals:session:updated', (updated) => {
    if (updated.id !== session.id || updated.status === 'running') return
    unbind()
    state.storybookSession = null
    if (updated.status === 'error') {
      setTimeout(() => {
        state.storybookStartFailure = {
          code: null,
          detail: extractErrorSnippet(updated.buffer),
        }
        onError?.()
      }, bufferFlushMs)
    }
  })
}

/**
 * Whether the hub has a Terminals dock registered to deep-link into. The
 * dock is a separate hub plugin, registered by all three hosts. Check the
 * actual registration so custom hosts can omit unavailable actions.
 */
export function hasTerminalsDock(state: StorybookDevframeState): boolean {
  try {
    const entries: Array<{ id?: string }> | undefined =
      state.devtoolsDocks?.values?.()
    return entries?.some((entry) => entry.id === TERMINALS_DOCK_ID) ?? false
  } catch {
    return false
  }
}

/**
 * Toast an error notification, with an action that opens the Terminals dock
 * on the Storybook session (where the failure output lives) when that dock
 * exists on the host.
 */
export function notifyStorybookFailure(state: StorybookDevframeState): void {
  const detail = state.storybookStartFailure?.detail
  const terminal = hasTerminalsDock(state)
  const hint = terminal
    ? 'Open the terminal for the full output.'
    : 'Rerun Storybook from a shell for the full output.'
  state.devtoolsMessages?.error?.('Storybook failed to start', {
    description: detail ? `${detail}\n\n${hint}` : `The process exited. ${hint}`,
    category: 'storybook',
    ...(terminal
      ? {
          actions: [
            {
              id: 'open-storybook-terminal',
              label: 'Open Terminal',
              kind: 'activate',
              activate: {
                dockId: TERMINALS_DOCK_ID,
                params: { sessionId: STORYBOOK_SESSION_ID },
              },
            },
          ],
        }
      : {}),
  })
}
