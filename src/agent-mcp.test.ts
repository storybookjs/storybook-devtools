import { describe, expect, it } from 'vitest'
import { createHostContext } from 'devframe/node'
import { createRuntimeMcp } from './agent-mcp'
import type { CreateStorybookDevframeDeps } from './context'

describe('runtime MCP boundary', () => {
  it.each([undefined, 'test-token'])('isolates hub tools and state with optional token %s', async (token) => {
    const ctx = await createHostContext({
      cwd: '/app', mode: 'dev',
      host: { mountStatic() {}, resolveOrigin: () => 'http://localhost', getStorageDir: () => '/tmp' },
    })
    ctx.agent.registerTool({ id: 'terminal:exec', description: 'Must not be exposed', handler: () => 'unsafe' })
    await ctx.rpc.sharedState.get('private', { initialValue: { secret: 'not agent context' } })
    const deps = {
      storybookUrl: 'http://localhost:6006',
      storyIndexService: { cwd: '/app', getIndex: async () => ({ v: 5, entries: {}, source: 'storybook' }) },
    } as unknown as CreateStorybookDevframeDeps
    await expect(createRuntimeMcp(ctx, deps, { token: ' ' })).rejects.toThrow('non-empty')
    const mcp = token ? await createRuntimeMcp(ctx, deps, { token }) : await createRuntimeMcp(ctx, deps)
    const request = (method: string, auth = token ? `Bearer ${token}` : '', origin = 'http://localhost') => mcp.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: { ...(auth ? { Authorization: auth } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    }))
    try {
      if (token) {
        expect((await request('tools/list', '')).status).toBe(401)
        expect((await request('tools/list', 'Bearer wrong')).status).toBe(401)
      }
      expect((await request('tools/list', 'Bearer test-token', 'https://untrusted.example')).status).toBe(403)
      expect((await request('tools/list', '', '')).status).toBe(403)
      const response = await request('tools/list')
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).toContain('storybook-devtools_get-app-context')
      expect(text).not.toContain('terminal')
      expect(text).not.toContain('devframe_state_read')
      expect(await (await request('resources/list')).text()).not.toContain('private')
    } finally { await mcp.dispose() }
  })
})
