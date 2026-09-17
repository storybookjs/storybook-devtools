import type { DevframeNodeContext } from 'devframe'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { CreateStorybookDevframeDeps } from './context'
import { queryRuntimePages, registerRuntimeTools } from './agent'

export const AGENT_MCP_PATH = '/__storybook-devtools/mcp'
export interface RuntimeAgentOptions { token: string }

/** Isolate the public agent surface from the hub's terminals, actions and state.
 * The tools close over the live host context; no second registry is created. */
export async function createRuntimeMcp(ctx: DevframeNodeContext, deps: CreateStorybookDevframeDeps, options: RuntimeAgentOptions) {
  if (typeof options.token !== 'string' || !options.token.trim()) {
    throw new Error('Runtime MCP requires a non-empty bearer token.')
  }
  const [{ createHostContext }, { createMcpFetchHandler }] = await Promise.all([
    import(/* webpackIgnore: true */ 'devframe/node'),
    import(/* webpackIgnore: true */ 'devframe/adapters/mcp'),
  ])
  const agentContext = await createHostContext({ cwd: ctx.cwd, mode: 'dev', host: ctx.host })
  registerRuntimeTools(agentContext, {
    cwd: deps.storyIndexService.cwd, storybookUrl: deps.storybookUrl,
    getPages: query => queryRuntimePages(ctx, query),
    getIndex: () => deps.storyIndexService.getIndex(),
  })
  return createMcpFetchHandler(agentContext, {
    serverName: 'storybook-devtools-runtime', serverVersion: '0.0.0', exposeSharedState: false, authorization: options.token,
  })
}

export type RuntimeMcp = Awaited<ReturnType<typeof createRuntimeMcp>>

/** Connect middleware used by Vite (including Nuxt) and Rsbuild. */
export function runtimeMcpMiddleware(getMcp: () => Promise<RuntimeMcp>) {
  return async (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    if (req.url?.split('?')[0] !== AGENT_MCP_PATH) return next()
    // The installed Devframe adapter checks Origin, but does not check the
    // socket peer. Do not expose runtime data to a LAN peer forging Origin.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      res.writeHead(403).end('Local connections only')
      return
    }
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const data = Buffer.from(chunk)
        size += data.length
        if (size > 16_384) { res.writeHead(413).end('Request too large'); return }
        chunks.push(data)
      }
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      const response = await (await getMcp()).fetch(new Request(`http://localhost${AGENT_MCP_PATH}`, {
        method: req.method ?? 'POST', headers,
        ...(['GET', 'HEAD'].includes(req.method ?? '') ? {} : { body: Buffer.concat(chunks) }),
      }))
      res.statusCode = response.status
      response.headers.forEach((value, key) => res.setHeader(key, value))
      if (response.body) Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
      else res.end()
    } catch (error) { next(error) }
  }
}
