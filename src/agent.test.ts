import { afterEach, describe, expect, it } from 'vitest'
import { createHostContext } from 'devframe/node'
import { createMcpFetchHandler } from 'devframe/adapters/mcp'
import { queryRuntimePages, registerRuntimeTools, type RuntimePage } from './agent'
import type { DevframeNodeContext } from 'devframe'
import type { StoryIndex } from './story-index'

const page = (pageId = 'page-a'): RuntimePage => ({
  pageId, url: 'http://localhost/tasks', capturedAt: new Date().toISOString(),
  selectedInstanceId: 'button-1', totalInstances: 2, truncated: false,
  instances: [
    { id: 'button-1', meta: { componentName: 'Button', sourceId: 'button', filePath: '/app/Button.tsx' }, isConnected: true, serializedProps: { disabled: true } },
    { id: 'card-1', meta: { componentName: 'Card', sourceId: 'card', filePath: '/app/Card.tsx' }, isConnected: true },
  ],
})

describe('runtime agent MCP', () => {
  const disposers: Array<() => Promise<void>> = []
  afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

  async function setup(pages: RuntimePage[] = [page()], source: StoryIndex['source'] = 'storybook') {
    const ctx = await createHostContext({ cwd: '/app', mode: 'dev', host: { mountStatic() {}, resolveOrigin: () => 'http://localhost', getStorageDir: () => '/tmp' } })
    registerRuntimeTools(ctx, {
      cwd: '/app', storybookUrl: 'http://localhost:6006',
      getPages: async () => ({ pages, unavailableClients: 0 }),
      getIndex: async () => ({ v: 5, source, entries: {
        'custom--disabled': { id: 'custom--disabled', type: 'story', title: 'Custom', componentPath: './Button.tsx', importPath: './stories/Other.stories.tsx' },
      } }),
    })
    const mcp = createMcpFetchHandler(ctx, { serverName: 'test', serverVersion: '0', exposeSharedState: false })
    disposers.push(mcp.dispose)
    return async (method: string, params = {}) => {
      const response = await mcp.fetch(new Request('http://localhost/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Origin: 'http://localhost' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }))
      expect(response.status).toBe(200)
      const body = await response.text()
      return JSON.parse(body.startsWith('{') ? body : body.split('\n').find(l => l.startsWith('data:'))!.slice(5)).result
    }
  }

  async function tool(call: Awaited<ReturnType<typeof setup>>, name: string, args = {}) {
    const result = await call('tools/call', { name: `storybook-devtools_${name}`, arguments: args })
    return result.isError ? result : JSON.parse(result.content[0].text)
  }

  it('exposes exactly four read-only tools with schemas and no shared-state resources', async () => {
    const call = await setup()
    const { tools } = await call('tools/list')
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      'storybook-devtools_get-app-context', 'storybook-devtools_get-component-tree', 'storybook-devtools_get-story-gaps', 'storybook-devtools_inspect-component',
    ])
    expect(tools.every((t: any) => t.annotations.readOnlyHint && !t.annotations.destructiveHint)).toBe(true)
    expect(tools.find((t: any) => t.name.endsWith('inspect-component')).inputSchema.required).toEqual(['pageId', 'instanceId'])
    expect((await call('resources/list')).resources).toEqual([])
    expect((await tool(call, 'create-story')).isError).toBe(true)
  })

  it('lists page-scoped instances without props and reports missing browsers honestly', async () => {
    const call = await setup([page(), page('page-b')])
    const context = await tool(call, 'get-app-context')
    expect(context.pages.map((p: any) => p.pageId)).toEqual(['page-a', 'page-b'])
    expect(context.pages[0].instances[0]).not.toHaveProperty('serializedProps')
    expect(context.pages[0].selectedInstanceId).toBe('button-1')
    expect((await tool(await setup([]), 'get-app-context')).status).toBe('no-connected-app')
  })

  it('inspects an exact instance and joins custom-path stories without claiming prop coverage', async () => {
    const call = await setup()
    const result = await tool(call, 'inspect-component', { pageId: 'page-a', instanceId: 'button-1' })
    expect(result.instance.serializedProps).toEqual({ disabled: true })
    expect(result.stories[0].id).toBe('custom--disabled')
    expect(result.storybook.mcpUrl).toBe('http://localhost:6006/mcp')
    expect(result.storybook.endpointVerified).toBe(false)
    expect(result.coverageMeaning).toContain('not')
    expect((await tool(call, 'inspect-component', { pageId: 'page-a', instanceId: 'gone' })).isError).toBe(true)
    expect((await tool(call, 'inspect-component', { pageId: 'page-b', instanceId: 'button-1' })).isError).toBe(true)
    expect((await tool(call, 'inspect-component', { instanceId: 'button-1' })).isError).toBe(true)
  })

  it('inspects rendered React wrappers without a highlighter DOM anchor', async () => {
    const fixture = page()
    fixture.instances[0]!.isConnected = false
    fixture.instances[0]!.isRendered = true
    const result = await tool(await setup([fixture]), 'inspect-component', { pageId: 'page-a', instanceId: 'button-1' })
    expect(result.instance.serializedProps).toEqual({ disabled: true })
    fixture.instances[0]!.isRendered = false
    expect((await tool(await setup([fixture]), 'inspect-component', { pageId: 'page-a', instanceId: 'button-1' })).isError).toBe(true)
  })

  it('reports gaps only among this page’s mounted components, with index provenance', async () => {
    const result = await tool(await setup(), 'get-story-gaps', { pageId: 'page-a' })
    expect(result.components.map((c: any) => c.componentName)).toEqual(['Card'])
    expect(result.indexSource).toBe('storybook')
    const fallback = await tool(await setup([page()], 'scan'), 'get-story-gaps', { pageId: 'page-a' })
    expect(fallback.indexSource).toBe('scan')
    const stale = await tool(await setup([page()], 'stale'), 'get-story-gaps', { pageId: 'page-a' })
    expect(stale.status).toBe('index-unavailable')
    expect(stale.components).toEqual([])
  })

  it('returns a page-scoped React tree and reports unsupported runtimes explicitly', async () => {
    const fixture = page()
    fixture.componentTree = {
      framework: 'react', rootIds: ['card-1'], totalNodes: 2, truncated: false,
      nodes: [
        { id: 'card-1', parentId: null, meta: fixture.instances[1]!.meta },
        { id: 'button-1', parentId: 'card-1', meta: fixture.instances[0]!.meta },
      ],
    }
    const result = await tool(await setup([fixture]), 'get-component-tree', { pageId: 'page-a' })
    expect(result.status).toBe('ok')
    expect(result.scope).toBe('rendered-page')
    expect(result.nodes[1].parentId).toBe('card-1')
    expect(result.nodes[1]).not.toHaveProperty('serializedProps')
    expect((await tool(await setup(), 'get-component-tree', { pageId: 'page-a' })).status).toBe('unsupported-framework')
    expect((await tool(await setup(), 'get-component-tree', { pageId: 'closed' })).isError).toBe(true)
    expect((await tool(await setup(), 'get-component-tree')).isError).toBe(true)
  })

  it('bounds unresponsive peers and skips untrusted connections without losing healthy pages', async () => {
    let queriedUntrusted = false
    const clients = [
      { $meta: { isTrusted: true }, $callRaw: async () => page() },
      { $meta: { isTrusted: true }, $callRaw: () => new Promise(() => {}) },
      { $meta: { isTrusted: false }, $callRaw: async () => { queriedUntrusted = true; return page('untrusted') } },
    ]
    const ctx = { rpc: { broadcast: async ({ filter }: any) => { clients.forEach(filter) } } } as unknown as DevframeNodeContext
    const result = await queryRuntimePages(ctx, {}, 10)
    expect(result.pages.map(p => p.pageId)).toEqual(['page-a'])
    expect(result.unavailableClients).toBe(1)
    expect(queriedUntrusted).toBe(false)
  })
})
