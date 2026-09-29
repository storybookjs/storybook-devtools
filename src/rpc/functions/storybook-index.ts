import { defineRpcFunction } from 'devframe'
import { getStorybookDevframeContext } from '../../context'

export const storybookIndex = defineRpcFunction({
  name: 'storybook-index',
  type: 'query',
  setup: (ctx) => {
    const { storybookUrl } = getStorybookDevframeContext(ctx)
    return {
      handler: async () => {
        try {
          const indexUrl = new URL('/index.json', storybookUrl).href
          const r = await fetch(indexUrl, {
            signal: AbortSignal.timeout(5000),
          })
          return await r.json()
        } catch {
          // Storybook isn't running (yet). The panel navigates by story id,
          // so only Storybook's own index can answer this — an empty index
          // reads as "no stories yet" instead of offering ids that resolve
          // to nothing.
          return { v: 0, entries: {} }
        }
      },
    }
  },
})
