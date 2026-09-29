import { defineRpcFunction } from 'devframe'
import { getStorybookDevframeContext } from '../../context'
import { hasTerminalsDock } from '../../storybook-process'

export const storybookStatus = defineRpcFunction({
  name: 'storybook-status',
  type: 'query',
  setup: (ctx) => {
    const { storybookUrl, state } = getStorybookDevframeContext(ctx)
    return {
      handler: async () => {
        let running = false
        try {
          const r = await fetch(storybookUrl, {
            signal: AbortSignal.timeout(3000),
          })
          running = r.ok
        } catch {
          running = false
        }
        // `startFailure` lets the panel distinguish "still starting" from
        // "the start attempt's process already died" while it polls this
        // query; `terminalDockAvailable` tells it whether an "Open Terminal"
        // affordance has a dock to open.
        return {
          running,
          startFailure: state.storybookStartFailure,
          terminalDockAvailable: hasTerminalsDock(state),
        }
      },
    }
  },
})
