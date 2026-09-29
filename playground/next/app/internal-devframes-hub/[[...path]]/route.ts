import { createStorybookDevtoolsRoute } from '@storybook/experimental-devtools/next'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const route = createStorybookDevtoolsRoute({
  // E2E must not require interactive Vite DevTools authorization.
  auth: false,
  storybookUrl: process.env.STORYBOOK_E2E_URL || 'http://localhost:6006',
  agent: { token: process.env['STORYBOOK_DEVTOOLS_MCP_TOKEN'] ?? 'playground-only' },
  // No pinned port: the auto-allocator probes a free port and the connection
  // meta advertises whatever was bound, so concurrent playgrounds cannot
  // collide — a pinned port fails loudly instead when another sidecar wins.
  // Matches `next dev -H 127.0.0.1` — 'localhost' can resolve to the IPv6
  // loopback, which the browser's explicit ws://127.0.0.1 target can't reach.
  host: '127.0.0.1',
})

export const { GET, POST, DELETE } = route
