import { defineRpcFunction } from 'devframe'
import { getStorybookDevframeContext } from '../../context'
import { createStory, type ComponentStoryData } from './create-story'

/** One batch, one summary; individual writes still update indexing and clients. */
export const createStories = defineRpcFunction({
  name: 'create-stories',
  type: 'action',
  setup: async (ctx) => {
    const { state } = getStorybookDevframeContext(ctx)
    const { handler } = await createStory.setup!(ctx)
    return {
      handler: async (items: ComponentStoryData[]) => {
        let created = 0
        let failed = 0
        for (const item of items) {
          try {
            const result = await handler!({ ...item, skipNavigation: true, suppressNotification: true })
            if (result.success) created++
            else failed++
          } catch {
            failed++
          }
        }
        state.notifications.notify({
          message: items.length
            ? `Created ${created} ${created === 1 ? 'story' : 'stories'}${failed ? `; ${failed} failed` : ''}`
            : 'No visible uncovered components found — navigate to a page with components first',
          level: failed ? 'error' : created ? 'success' : 'info',
          toast: true,
          autoDismissMs: failed ? 8000 : 4000,
          category: 'story-creation',
        })
        return { created, failed }
      },
    }
  },
})
