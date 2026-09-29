import { test, expect, type APIRequestContext } from '@playwright/test'
import { clickComponentHighlight, enableHighlighting, disableHighlighting, exerciseTaskFormInteractions } from './highlighter-helpers'

export async function callMcp(request: APIRequestContext, url: string, method: string, params: object = {}, runtime = true) {
  const response = await request.post(url, {
    headers: { Origin: new URL(url).origin, Accept: 'application/json, text/event-stream', ...(runtime ? { Authorization: 'Bearer playground-only' } : {}) },
    data: { jsonrpc: '2.0', id: 1, method, params },
  })
  expect(response.status(), await response.text()).toBe(200)
  const text = await response.text()
  const data = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:'))!.slice(5))
  expect(data.error).toBeUndefined()
  return data.result
}

export function registerAgentSuite() {
  test.describe('Runtime MCP', () => {
    test('inspects a real selected instance and joins story coverage without exposing mutations', async ({ page, request, baseURL }, testInfo) => {
      const endpoint = `${baseURL}${testInfo.project.name.startsWith('next') ? '/__devframes/storybook-devtools/mcp' : '/__storybook-devtools/mcp'}`
      await page.goto('/')
      const route = `/mcp-inspect-${testInfo.testId}`
      let id = ''
      await expect.poll(async () => {
        try {
          id = await page.evaluate(route => {
            const instance = [...((window as any).__componentHighlighterRegistry?.values() ?? [])].find((i: any) => i.meta.componentName === 'TaskList')
            if (!instance) return ''
            history.replaceState(null, '', route + '?private=hidden#secret')
            return instance.id
          }, route)
          return !!id
        } catch { return false }
      }).toBe(true)
      const call = async (name: string, args = {}) => {
        const result = await callMcp(request, endpoint, 'tools/call', { name: `storybook-devtools_${name}`, arguments: args })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        return JSON.parse(result.content[0].text)
      }
      const tools = await callMcp(request, endpoint, 'tools/list')
      expect(tools.tools).toHaveLength(4)
      expect(tools.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true)
      expect((await callMcp(request, endpoint, 'resources/list')).resources).toEqual([])
      let context: any
      await expect.poll(async () => {
        context = await call('get-app-context')
        return context.pages.some((p: any) => p.url.endsWith(route) && p.instances.some((i: any) => i.id === id))
      }).toBe(true)
      const target = context.pages.find((p: any) => p.url.endsWith(route))
      expect(target.instances.every((i: any) => !('serializedProps' in i))).toBe(true)
      await enableHighlighting(page)
      await clickComponentHighlight(page, 'TaskList')
      await expect.poll(async () => (await call('get-app-context')).pages.find((p: any) => p.pageId === target.pageId)?.selectedInstanceId).toBe(id)
      const inspected = await call('inspect-component', { pageId: target.pageId, instanceId: id })
      expect(inspected.instance.meta.componentName).toBe('TaskList')
      expect(inspected.instance.serializedProps).toBeDefined()
      expect(inspected.instance.meta.filePath).toContain('TaskList')
      expect(inspected.storybook.mcpUrl).toBe(`${process.env.STORYBOOK_E2E_URL || 'http://localhost:6006'}/mcp`)
      expect(Date.now() - Date.parse(inspected.capturedAt)).toBeLessThan(10_000)
      const gaps = await call('get-story-gaps', { pageId: target.pageId })
      expect(gaps.status).toBe('ok')
      expect(['storybook', 'scan']).toContain(gaps.indexSource)
      expect(gaps.totalInstances).toBeGreaterThan(0)
      // Exercise real input/select changes, then verify that runtime MCP sees
      // the subsequent render rather than returning the earlier snapshot.
      await disableHighlighting(page)
      await page.getByRole('button', { name: '+ New Task' }).click()
      await exerciseTaskFormInteractions(page)
      await page.getByRole('button', { name: 'Add Task', exact: true }).click()
      await expect.poll(async () => {
        const updated = await call('inspect-component', { pageId: target.pageId, instanceId: id })
        return updated.instance.serializedProps.count
      }).toBe(inspected.instance.serializedProps.count + 1)
      const denied = await request.post(endpoint, { headers: { Origin: new URL(endpoint).origin }, data: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
      expect(denied.status()).toBe(401)
    })

    test('returns the rendered React component tree with fresh modal membership', async ({ page, request, baseURL }, testInfo) => {
      const endpoint = `${baseURL}${testInfo.project.name.startsWith('next') ? '/__devframes/storybook-devtools/mcp' : '/__storybook-devtools/mcp'}`
      await page.goto('/')
      const route = `/mcp-tree-${testInfo.testId}`
      await expect.poll(async () => page.evaluate(route => {
        if (!(window as any).__componentHighlighterRegistry?.size) return false
        history.replaceState(null, '', route)
        return true
      }, route).catch(() => false)).toBe(true)
      const call = async (name: string, args = {}) => {
        const response = await callMcp(request, endpoint, 'tools/call', { name: `storybook-devtools_${name}`, arguments: args })
        expect(response.isError, JSON.stringify(response)).not.toBe(true)
        return JSON.parse(response.content[0].text)
      }
      let target: any
      await expect.poll(async () => {
        const context = await call('get-app-context')
        target = context.pages.find((p: any) => p.url.endsWith(route))
        return !!target
      }).toBe(true)
      const query = () => call('get-component-tree', { pageId: target.pageId })
      const tree = await query()
      if (/^(vue|nuxt)-/.test(testInfo.project.name)) {
        expect(tree.status).toBe('unsupported-framework')
        return
      }
      expect(tree.status).toBe('ok')
      expect(tree.scope).toBe('rendered-page')
      const taskList = tree.nodes.find((n: any) => n.meta.componentName === 'TaskList')
      const cards = tree.nodes.filter((n: any) => n.meta.componentName === 'TaskCard')
      expect(cards).toHaveLength(3)
      expect(cards.every((n: any) => n.parentId === taskList.id)).toBe(true)
      expect(new Set(cards.map((n: any) => n.id)).size).toBe(3)
      expect(tree.nodes.every((n: any) => !('serializedProps' in n))).toBe(true)
      expect(tree.nodes.every((n: any) => n.parentId === null || tree.nodes.some((p: any) => p.id === n.parentId))).toBe(true)
      expect(tree.nodes.some((n: any) => n.meta.componentName === 'Modal')).toBe(false)
      // The last task card is outside this short viewport, but is still rendered.
      await page.setViewportSize({ width: 900, height: 200 })
      expect((await query()).nodes.filter((n: any) => n.meta.componentName === 'TaskCard')).toHaveLength(3)
      await page.getByRole('button', { name: '+ New Task' }).click()
      let opened: any
      await expect.poll(async () => {
        opened = await query()
        return opened.nodes.some((n: any) => n.meta.componentName === 'TaskForm')
      }).toBe(true)
      const modal = opened.nodes.find((n: any) => n.meta.componentName === 'Modal')
      const form = opened.nodes.find((n: any) => n.meta.componentName === 'TaskForm')
      expect(form.parentId).toBe(modal.id)
      await page.getByRole('button', { name: 'Close modal', exact: true }).click()
      await expect.poll(async () => (await query()).nodes.some((n: any) => n.id === form.id)).toBe(false)
      const after = await query()
      expect(after.nodes.find((n: any) => n.meta.componentName === 'TaskList').id).toBe(taskList.id)
      expect(after.nodes.some((n: any) => n.meta.componentName === 'Modal')).toBe(false)
    })

    test('isolates two browser pages and rejects an instance after its page closes', async ({ page, context, request, baseURL }, testInfo) => {
      const endpoint = `${baseURL}${testInfo.project.name.startsWith('next') ? '/__devframes/storybook-devtools/mcp' : '/__storybook-devtools/mcp'}`
      const second = await context.newPage()
      await Promise.all([page.goto('/'), second.goto('/')])
      const routes = [`/mcp-first-${testInfo.testId}`, `/mcp-second-${testInfo.testId}`]
      for (const [index, tab] of [page, second].entries()) {
        await expect.poll(async () => {
          try { return await tab.evaluate(route => {
            if (!(window as any).__componentHighlighterRegistry?.size) return false
            history.replaceState(null, '', route)
            return true
          }, routes[index]!) } catch { return false }
        }).toBe(true)
      }
      const query = async () => JSON.parse((await callMcp(request, endpoint, 'tools/call', { name: 'storybook-devtools_get-app-context', arguments: {} })).content[0].text)
      let pages: any[] = []
      await expect.poll(async () => {
        pages = (await query()).pages
        return routes.every(route => pages.some(p => p.url.endsWith(route)))
      }).toBe(true)
      const first = pages.find(p => p.url.endsWith(routes[0]))
      const other = pages.find(p => p.url.endsWith(routes[1]))
      expect(first.pageId).not.toBe(other.pageId)
      await second.close()
      await expect.poll(async () => (await query()).pages.some((p: any) => p.pageId === other.pageId)).toBe(false)
      const result = await callMcp(request, endpoint, 'tools/call', { name: 'storybook-devtools_inspect-component', arguments: { pageId: other.pageId, instanceId: other.instances[0].id } })
      expect(result.isError).toBe(true)
    })
  })
}
