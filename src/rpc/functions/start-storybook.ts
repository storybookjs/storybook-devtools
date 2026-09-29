import { defineRpcFunction } from 'devframe'
import { getStorybookDevframeContext } from '../../context'
import {
  buildStorybookEnv,
  resolveStorybookDevCommand,
} from '../../storybook-launch'
import {
  adoptStorybookSession,
  notifyStorybookFailure,
  STORYBOOK_SESSION_ID,
} from '../../storybook-process'

export const startStorybook = defineRpcFunction({
  name: 'start-storybook',
  type: 'action',
  setup: (ctx) => {
    const { storybookUrl, state, logDebug } = getStorybookDevframeContext(ctx)
    return {
      handler: async () => {
        if (state.storybookSession) {
          return { started: true, alreadyRunning: true }
        }

        if (!state.devtoolsTerminals) {
          return { started: false, error: 'Terminals API not available' }
        }

        state.storybookStartFailure = null

        try {
          // A previous run's dead session may still be registered (kept so
          // its scrollback stays readable in the Terminals dock) — drop it
          // so the spawn can reuse the session id.
          const stale = state.devtoolsTerminals.sessions?.get?.(
            STORYBOOK_SESSION_ID,
          )
          if (stale) state.devtoolsTerminals.remove(stale)

          const port = new URL(storybookUrl).port || '6006'
          const { command, args } = await resolveStorybookDevCommand({
            cwd: ctx.cwd,
            port,
            logDebug,
          })

          // A PTY session: the Terminals dock renders it writable, so
          // interactive prompts (e.g. Storybook's port-conflict question)
          // can actually be answered, and the process sees a real TTY.
          const session = await state.devtoolsTerminals.startPtySession(
            {
              command,
              args,
              cwd: ctx.cwd,
              env: buildStorybookEnv(process.env, port),
            },
            {
              id: STORYBOOK_SESSION_ID,
              title: 'Storybook',
              icon: 'ph:book-duotone',
              // Restarting goes through this RPC (fresh session), not the
              // dock's restart control — a closed PTY stream can't rerun.
              restartable: false,
            },
          )

          adoptStorybookSession(state, state.devtoolsTerminals, session, () =>
            notifyStorybookFailure(state),
          )

          return { started: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          state.storybookStartFailure = { code: null }
          notifyStorybookFailure(state)
          return { started: false, error: msg }
        }
      },
    }
  },
})
