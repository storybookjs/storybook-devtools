import * as path from 'node:path'
import type { DevframeNodeContext } from 'devframe'
import type { SerializedRegistryInstance } from './shared-types'
import type { StoryIndex } from './story-index'
import { findStoryCandidates } from './utils/story-matching'

export interface RuntimePage {
  pageId: string
  /** Query strings and fragments are deliberately omitted. */
  url: string
  capturedAt: string
  selectedInstanceId: string | null
  totalInstances: number
  truncated: boolean
  instances: SerializedRegistryInstance[]
  propsTruncated?: boolean
}

export interface RuntimeQuery { pageId?: string; instanceId?: string }
export interface RuntimePages { pages: RuntimePage[]; unavailableClients: number }

const coverageMeaning = 'Story presence only, not test coverage or proof that a story reproduces these props. Matching may use filename/title heuristics.'

export function registerRuntimeTools(ctx: DevframeNodeContext, deps: {
  cwd: string
  storybookUrl: string
  getPages: (query: RuntimeQuery) => Promise<RuntimePages>
  getIndex: () => Promise<StoryIndex>
}) {
  const storybook = {
    url: deps.storybookUrl,
    mcpUrl: new URL('mcp', `${deps.storybookUrl.replace(/\/$/, '')}/`).href,
    endpointVerified: false,
    hint: 'Use Storybook MCP for component documentation, story previews and tests. This is the default MCP endpoint; custom endpoints may differ.',
  }
  function register(name: string, description: string, keys: string[], handler: (args: Record<string, string>) => Promise<unknown>) {
    ctx.agent.registerTool({
      id: `storybook-devtools:${name}`, description, safety: 'read',
      inputSchema: {
        type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'string', minLength: 1, maxLength: 256 }])),
        required: keys, additionalProperties: false,
      },
      handler: async (args: unknown) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected an argument object.')
        const values = args as Record<string, string>
        if (Object.keys(values).some(key => !keys.includes(key)) || keys.some(key => typeof values[key] !== 'string' || !values[key] || values[key]!.length > 256)) {
          throw new Error(`Expected exactly: ${keys.join(', ') || 'no arguments'}. Use get-app-context for page and instance IDs.`)
        }
        return handler(values)
      },
    })
  }
  async function readPage(args: Record<string, string>) {
    const result = await deps.getPages(args)
    const page = result.pages.find(p => p.pageId === args['pageId'])
    if (!page) throw new Error('Page unavailable. Open and authorize the app, then call get-app-context again. No cached data was used.')
    return page
  }
  function candidates(index: StoryIndex, instance: SerializedRegistryInstance) {
    return findStoryCandidates(index.entries, path.relative(deps.cwd, instance.meta.filePath).split(path.sep).join('/'), instance.meta.componentName)
  }

  register('get-app-context', 'Discover connected application pages and their mounted component instances before inspecting runtime props. Returns fresh browser snapshots, selected instance IDs and source files; no props. Requires an open, trusted app page.', [], async () => {
    const result = await deps.getPages({})
    return {
      status: result.pages.length ? 'connected' : 'no-connected-app',
      ...result,
      pages: result.pages.map(page => ({ ...page, instances: page.instances.map(({ serializedProps: _props, ...instance }) => instance) })),
      storybook,
      limitations: ['Mounted means DOM-connected, not viewport-visible.', 'Only instrumented client components are included; server components and uninstrumented modules are absent.', 'Each page is captured independently; this is not an atomic cross-page snapshot.'],
    }
  })
  register('inspect-component', 'Inspect one exact component instance from get-app-context: current serialized runtime props, source identity, live edits and matching stories. Select the page explicitly. Props are lossy snapshots, not component API documentation; use Storybook MCP for docs.', ['pageId', 'instanceId'], async args => {
    const page = await readPage(args)
    const instance = page.instances.find(i => i.id === args['instanceId'] && i.isConnected)
    if (!instance) throw new Error('Instance no longer mounted. Call get-app-context again.')
    const index = await deps.getIndex()
    return {
      pageId: page.pageId, url: page.url, capturedAt: page.capturedAt,
      instance, propsTruncated: page.propsTruncated ?? false,
      propsAvailable: instance.serializedProps !== undefined,
      indexSource: index.source ?? 'unknown', stories: candidates(index, instance), coverageMeaning, storybook,
    }
  })
  register('get-story-gaps', 'Find mounted components on a chosen application page with no matching Storybook story. Prioritize missing stories using real app usage. This does not measure test coverage or missing prop variants. Refuses definitive gaps when the index is stale.', ['pageId'], async args => {
    const page = await readPage(args)
    const index = await deps.getIndex()
    const components = new Map<string, { componentName: string; filePath: string; sourceId: string; instanceIds: string[] }>()
    if (index.source === 'storybook' || index.source === 'scan') {
      for (const instance of page.instances) {
        if (!instance.isConnected || candidates(index, instance).length) continue
        const key = `${instance.meta.filePath}:${instance.meta.sourceId}`
        const entry = components.get(key) ?? { componentName: instance.meta.componentName, filePath: instance.meta.filePath, sourceId: instance.meta.sourceId, instanceIds: [] }
        entry.instanceIds.push(instance.id)
        components.set(key, entry)
      }
    }
    return {
      status: index.source === 'storybook' || index.source === 'scan' ? 'ok' : 'index-unavailable',
      pageId: page.pageId, capturedAt: page.capturedAt, truncated: page.truncated,
      totalInstances: page.totalInstances, indexSource: index.source ?? 'unknown',
      components: [...components.values()], coverageMeaning, storybook,
    }
  })
}

/** Enumerate live RPC peers using the public broadcast filter, then query them
 * individually to retain responses. Do not read the shared, cross-tab registry. */
export async function queryRuntimePages(ctx: DevframeNodeContext, query: RuntimeQuery, timeoutMs = 2000): Promise<RuntimePages> {
  const requests: Array<Promise<RuntimePage | null>> = []
  await ctx.rpc.broadcast({
    method: 'component-highlighter:runtime-snapshot', args: [query],
    filter(client) {
      if (client.$meta.isTrusted === false) return false
      requests.push(new Promise(resolve => {
        const timeout = setTimeout(() => resolve(null), timeoutMs)
        client.$callRaw({ method: 'component-highlighter:runtime-snapshot', args: [query], optional: true, event: false })
          .then(value => { clearTimeout(timeout); resolve((value as unknown as RuntimePage | null) ?? null) }, () => { clearTimeout(timeout); resolve(null) })
      }))
      return false
    },
  })
  const results = await Promise.all(requests)
  return { pages: results.filter((p): p is RuntimePage => !!p), unavailableClients: results.filter(p => !p).length }
}
