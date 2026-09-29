import { defineRpcFunction } from 'devframe'
import { collectCoverage } from '../../coverage-dashboard'
import { getStorybookDevframeContext } from '../../context'

// Coverage dashboard — RPC to fetch coverage data
export const getCoverage = defineRpcFunction({
  name: 'get-coverage',
  type: 'query',
  setup: (ctx) => {
    const { state, storyIndexService } = getStorybookDevframeContext(ctx)
    return {
      handler: () =>
        collectCoverage(storyIndexService, state.transformedComponents),
    }
  },
})
