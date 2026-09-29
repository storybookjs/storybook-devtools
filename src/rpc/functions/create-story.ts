import * as fs from 'fs'
import * as path from 'path'
import { defineRpcFunction } from 'devframe'
import type { SerializedProps } from '../../frameworks'
import type { SerializedRegistryInstance } from '../../shared-types'
import { getStorybookDevframeContext } from '../../context'
import { ordinal } from '../../utils/instance-selection'
import { formatStoryFile } from '../../utils/csf-writer'

// Generating/formatting is async. Serialize read-modify-write per output
// file so two save actions cannot overwrite each other's exports.
const writes = new Map<string, Promise<void>>()
async function lockStoryFile(filePath: string): Promise<() => void> {
  const previous = writes.get(filePath)
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  writes.set(filePath, current)
  await previous
  return () => {
    if (writes.get(filePath) === current) writes.delete(filePath)
    release()
  }
}

export interface ComponentStoryData {
  meta: {
    componentName: string
    filePath: string
    relativeFilePath?: string
    sourceId: string
    isDefaultExport?: boolean
  }
  /**
   * Story generation reads `serializedProps` only — raw live props hold
   * unclonable values and are never sent over RPC.
   */
  serializedProps?: SerializedProps
  /** Component registry for import resolution: componentName -> filePath */
  componentRegistry?: Record<string, string>
  /** Custom story name */
  storyName?: string
  /** Play function code lines generated from recorded interactions */
  playFunction?: string[]
  /** Import statements required by the play function */
  playImports?: string[]
  /** When true, skip navigating to the story after creation (e.g. batch "Create all") */
  skipNavigation?: boolean
  /**
   * Which live instance these props came from, among the component's
   * connected siblings — set by the caller when more than one instance is
   * rendered, so the creation toast can name the source (e.g. "the 3rd of 3
   * instances").
   */
  sourceInstance?: { index: number; total: number }
}

export const createStory = defineRpcFunction({
  name: 'create-story',
  type: 'action',
  setup: (ctx) => {
    const {
      framework,
      writeStoryFiles,
      storiesDir,
      logDebug,
      state,
      storybookFramework,
      storyIndexService,
    } = getStorybookDevframeContext(ctx)
    return {
      handler: async (data: ComponentStoryData) => {
        logDebug(
          'Create story:',
          data.meta.componentName,
          'name:',
          data.storyName,
        )

        // Generate and write the story file
        if (writeStoryFiles && data.serializedProps) {
          let releaseWrite: (() => void) | undefined
          try {
            // Convert component registry from object to Map
            const registryMap = new Map<string, string>()
            if (data.componentRegistry) {
              for (const [name, filePath] of Object.entries(
                data.componentRegistry,
              )) {
                registryMap.set(name, filePath)
              }
            }
            // Augment/fallback from the server's synced registry so
            // referenced components (e.g. <TaskCard> inside
            // <TaskList>'s children) resolve to real imports even when
            // the caller didn't pass a componentRegistry — e.g.
            // coverage "Generate all" and the command palette. Without
            // this they'd be replaced with a "not exported" div.
            try {
              const all = (
                await ctx.rpc.sharedState.get(
                  'component-highlighter:registry',
                )
              ).value() as SerializedRegistryInstance[]
              for (const inst of all) {
                const n = inst?.meta?.componentName
                const fp = inst?.meta?.filePath
                if (n && fp && !registryMap.has(n)) {
                  registryMap.set(n, fp)
                }
              }
            } catch {
              // registry not ready — fall back to caller-provided map
            }

            // Determine the output path
            const componentDir = path.dirname(data.meta.filePath)
            const componentFileName = path.basename(
              data.meta.filePath,
              path.extname(data.meta.filePath),
            )
            const storyExtension = framework.name === 'vue' ? 'ts' : 'tsx'
            let outputPath = path.join(
              componentDir,
              `${componentFileName}.stories.${storyExtension}`,
            )
            if (storiesDir) {
              outputPath = path.join(
                componentDir,
                storiesDir,
                `${componentFileName}.stories.${storyExtension}`,
              )
            }

            releaseWrite = await lockStoryFile(outputPath)

            // Check if file already exists
            let existingContent: string | undefined
            if (fs.existsSync(outputPath)) {
              existingContent = fs.readFileSync(outputPath, 'utf-8')
              logDebug(`Appending to existing story file: ${outputPath}`)
            }

            // Dynamically import the framework-specific story generator
            let generateStory: typeof import('../../frameworks/react/story-generator').generateStory

            if (framework.name === 'react') {
              const { generateStory: generateReactStory } =
                await import('../../frameworks/react/story-generator')
              generateStory = generateReactStory
            } else if (framework.name === 'vue') {
              const { generateStory: generateVueStory } =
                await import('../../frameworks/vue/story-generator')
              generateStory = generateVueStory
            } else {
              throw new Error(`Unsupported framework: ${framework.name}`)
            }

            const story = await generateStory({
              meta: {
                componentName: data.meta.componentName,
                filePath: data.meta.filePath,
                relativeFilePath:
                  data.meta.relativeFilePath ??
                  path.relative(process.cwd(), data.meta.filePath),
                sourceId: data.meta.sourceId,
                isDefaultExport: data.meta.isDefaultExport ?? false,
              },
              props: data.serializedProps,
              componentRegistry: registryMap,
              storybookFramework: await storybookFramework,
              ...(data.storyName ? { storyName: data.storyName } : {}),
              ...(existingContent ? { existingContent } : {}),
              ...(data.playFunction
                ? { playFunction: data.playFunction }
                : {}),
              ...(data.playImports
                ? { playImports: data.playImports }
                : {}),
            })

            if (story.fallbackReason) {
              logDebug(
                `Story file could not be appended to on the CSF AST, spliced as text instead: ${story.fallbackReason}`,
              )
            }

            if (data.playFunction?.length) {
              logDebug(
                `Story includes a play function with ${data.playFunction.length} lines`,
              )
            }

            // Ensure the directory exists
            const outputDir = path.dirname(outputPath)
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true })
            }

            // Write the story file, formatted with the user project's
            // prettier when it has one (a no-op otherwise).
            const formatted = await formatStoryFile(outputPath, story.content)
            fs.writeFileSync(outputPath, formatted, 'utf-8')
            logDebug(
              `Story "${story.storyName}" ${existingContent ? 'added to' : 'created in'}: ${outputPath}`,
            )
            // Hosts without watch-based invalidation (or a slower watcher)
            // still see the new/updated story immediately on the next
            // coverage request.
            storyIndexService.invalidate(outputPath)

            const verb = existingContent ? 'added to' : 'created in'
            const sourceNote =
              data.sourceInstance && data.sourceInstance.total > 1
                ? ` (from the ${ordinal(data.sourceInstance.index)} of ${data.sourceInstance.total} instances)`
                : ''
            state.notifications.notify({
              message: `Story "${story.storyName}" ${verb} ${path.basename(outputPath)}${sourceNote}`,
              level: 'success',
              toast: true,
              autoDismissMs: 4000,
              filePosition: { file: outputPath, line: 1 },
              category: 'story-creation',
            })

            // Notify the client about the created file
            ctx.rpc.broadcast({
              method: 'component-highlighter:story-created',
              args: [
                {
                  filePath: outputPath,
                  componentName: data.meta.componentName,
                  componentPath: data.meta.filePath,
                  relativeFilePath:
                    data.meta.relativeFilePath ??
                    path.relative(process.cwd(), data.meta.filePath),
                  storyName: story.storyName,
                  isAppend: !!existingContent,
                  skipNavigation: !!data.skipNavigation,
                },
              ],
              optional: true,
            })

            // Coverage dashboard auto-refreshes via client-side RPC polling
          } catch (error) {
            state.notifications.notify({
              message: `Failed to create story for ${data.meta.componentName}`,
              level: 'error',
              toast: true,
              description:
                error instanceof Error ? error.message : String(error),
              category: 'story-creation',
            })

            // Still try to notify the client so the button resets
            ctx.rpc.broadcast({
              method: 'component-highlighter:story-created',
              args: [
                {
                  filePath: '',
                  componentName: data.meta.componentName,
                  componentPath: data.meta.filePath,
                  storyName: data.storyName ?? 'Unknown',
                  isAppend: false,
                },
              ],
              optional: true,
            })
          } finally {
            releaseWrite?.()
          }
        }
      },
    }
  },
})
