import * as path from 'path'
import { defineRpcFunction } from 'devframe'
import { getStorybookDevframeContext } from '../../context'
import { findStoryCandidates } from '../../utils/story-matching'

export const checkStory = defineRpcFunction({
  name: 'check-story',
  type: 'query',
  setup: (ctx) => {
    const { storyIndexService } = getStorybookDevframeContext(ctx)
    return {
      handler: async (arg: { componentPath: string }) => {
        const componentPath = arg?.componentPath
        if (!componentPath) {
          return { hasStory: false, storyPath: null }
        }

        const { entries } = await storyIndexService.getIndex()
        const relativeFilePath = path.relative(
          storyIndexService.cwd,
          componentPath,
        )
        const importPath = findStoryCandidates(entries, relativeFilePath)[0]
          ?.importPath

        return {
          hasStory: !!importPath,
          storyPath: importPath
            ? path.resolve(storyIndexService.cwd, importPath)
            : null,
        }
      },
    }
  },
})
