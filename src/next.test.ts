import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  composeNextHookScript,
  createStorybookDevtoolsRoute,
  getNextDevToolsHookScript,
  nextFramework,
  PersistedComponentMap,
  resolveNextOptions,
  withStorybookDevtools,
  type NextConfigWebpackShape,
} from './next'
import { getDevToolsHookScript } from './frameworks/react/devtools-hook'
import * as sidecarPorts from './sidecar-port'

interface WebpackConfig {
  plugins?: unknown[]
}

interface WebpackContext {
  dev: boolean
  isServer: boolean
  nextRuntime?: string
}

function callWebpack(
  nextConfig: NextConfigWebpackShape,
  context: WebpackContext,
  config: WebpackConfig = {},
): WebpackConfig {
  if (typeof nextConfig.webpack !== 'function') {
    throw new Error('expected withStorybookDevtools to set a webpack() fn')
  }
  return nextConfig.webpack(config, context) as WebpackConfig
}

describe('nextFramework', () => {
  it('does not expose runtime MCP in production even when opted in', async () => {
    const previous = process.env['NODE_ENV']
    const allocatePort = vi.spyOn(sidecarPorts, 'resolveDualStackSidecarPort').mockResolvedValue(19880)
    process.env['NODE_ENV'] = 'production'
    try {
      const route = createStorybookDevtoolsRoute({ agent: { token: 'test' } })
      const response = await route.POST(new Request('http://localhost/__devframes/storybook-devtools/mcp', { method: 'POST' }))
      expect(response.status).toBe(404)
      expect(allocatePort).not.toHaveBeenCalled()
    } finally {
      allocatePort.mockRestore()
      if (previous === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = previous
    }
  })
  it('uses @storybook/nextjs for story generation', () => {
    expect(nextFramework.storybookFramework).toBe('@storybook/nextjs')
    expect(nextFramework.name).toBe('react')
  })
})

describe('resolveNextOptions', () => {
  it('applies documented defaults', () => {
    const resolved = resolveNextOptions({})
    expect(resolved.rsc).toBe(true)
    expect(resolved.mountEmbeddedDock).toBe(true)
    expect(resolved.base).toBe('/__devframes/')
    expect(resolved.storybookUrl).toBe('http://localhost:6006')
    expect(resolved.writeStoryFiles).toBe(true)
    expect(resolved.devtoolsDockId).toBe('component-highlighter')
    expect(Array.isArray(resolved.entry)).toBe(true)
    expect(resolved.entry).not.toHaveLength(0)
  })

  it('lets user options override every default', () => {
    const resolved = resolveNextOptions({
      rsc: false,
      mountEmbeddedDock: false,
      base: 'custom-base',
      storybookUrl: 'http://localhost:9009',
      writeStoryFiles: false,
      devtoolsDockId: 'my-dock',
      entry: '**/my-entry.js',
    })
    expect(resolved.rsc).toBe(false)
    expect(resolved.mountEmbeddedDock).toBe(false)
    // normalizeHubBase adds leading/trailing slashes.
    expect(resolved.base).toBe('/custom-base/')
    expect(resolved.storybookUrl).toBe('http://localhost:9009')
    expect(resolved.writeStoryFiles).toBe(false)
    expect(resolved.devtoolsDockId).toBe('my-dock')
    expect(resolved.entry).toBe('**/my-entry.js')
  })
})

describe('composeNextHookScript / getNextDevToolsHookScript', () => {
  it('always includes the react devtools-hook script', () => {
    const script = composeNextHookScript({
      base: '/__devframes/',
      mountEmbeddedDock: false,
    })
    expect(script).toBe(getDevToolsHookScript())
  })

  it('appends an embedded-dock mount script when enabled', () => {
    const script = composeNextHookScript({
      base: '/__devframes/',
      mountEmbeddedDock: true,
    })
    expect(script).toContain(getDevToolsHookScript())
    expect(script).toContain('__REACT_DEVTOOLS_GLOBAL_HOOK__')
    expect(script).toContain('/__devframes/embedded.js')
    expect(script).toContain("document.createElement('script')")
    expect(script).toContain("document.head.appendChild(s)")
    // Deferred past window load — mounting mid-hydration makes React 19
    // report an attribute mismatch on <html> when the dock styles it.
    expect(script).toContain("window.addEventListener('load'")
  })

  it('omits the embedded-dock mount script when disabled', () => {
    const script = composeNextHookScript({
      base: '/__devframes/',
      mountEmbeddedDock: false,
    })
    expect(script).not.toContain('embedded.js')
  })

  it('getNextDevToolsHookScript matches the composed body used for entry injection', () => {
    const script = getNextDevToolsHookScript({ base: '/__devframes/' })
    expect(script).toBe(
      composeNextHookScript({ base: '/__devframes/', mountEmbeddedDock: true }),
    )
  })
})

describe('withStorybookDevtools', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('pushes the component-highlighter plugin only for the dev client compilation', () => {
    const configure = withStorybookDevtools()
    const nextConfig = configure({})

    const clientDev = callWebpack(nextConfig, { dev: true, isServer: false })
    // The component-highlighter unplugin plugin, plus the webpack5
    // "virtual:" scheme-compat plugin it needs (see createVirtualSchemeWebpackPlugin).
    expect(clientDev.plugins).toHaveLength(2)

    const serverDev = callWebpack(nextConfig, { dev: true, isServer: true })
    expect(serverDev.plugins ?? []).toHaveLength(0)

    const clientProd = callWebpack(nextConfig, { dev: false, isServer: false })
    expect(clientProd.plugins ?? []).toHaveLength(0)

    const edgeDev = callWebpack(nextConfig, {
      dev: true,
      isServer: false,
      nextRuntime: 'edge',
    })
    expect(edgeDev.plugins ?? []).toHaveLength(0)
  })

  it('still invokes the user-supplied webpack callback', () => {
    const userWebpack = vi.fn((config: WebpackConfig) => ({
      ...config,
      plugins: [...(config.plugins ?? []), 'user-plugin'],
    }))
    const configure = withStorybookDevtools()
    const nextConfig = configure({ webpack: userWebpack })

    const result = callWebpack(nextConfig, { dev: true, isServer: false })

    expect(userWebpack).toHaveBeenCalledTimes(1)
    expect(result.plugins).toContain('user-plugin')
    expect(result.plugins).toHaveLength(3)
  })

  it('extends serverExternalPackages without clobbering user entries', () => {
    const configure = withStorybookDevtools()
    const nextConfig = configure({ serverExternalPackages: ['my-own-package'] })

    expect(nextConfig.serverExternalPackages).toContain('my-own-package')
    expect(nextConfig.serverExternalPackages).toContain(
      '@storybook/experimental-devtools',
    )
    expect(nextConfig.serverExternalPackages).toContain('devframe')
    expect(nextConfig.serverExternalPackages).toContain('@devframes/next')
    expect(nextConfig.serverExternalPackages).toContain('@devframes/hub')
    expect(nextConfig.serverExternalPackages).toContain('@devframes/hub-ui')
  })

  it('prints one warning under Turbopack and never throws', () => {
    vi.stubEnv('TURBOPACK', '1')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => withStorybookDevtools()).not.toThrow()

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Turbopack')
    warnSpy.mockRestore()
  })

  it('does not warn when Turbopack is not active', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withStorybookDevtools()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('PersistedComponentMap', () => {
  it('merges the persisted manifest into a warm-boot flush instead of clobbering it', async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ch-manifest-')),
      'coverage-manifest.json',
    )
    const flush = () => new Promise((r) => setTimeout(r, 300))

    // Cold boot: every component transforms.
    const cold = new PersistedComponentMap(file)
    cold.set('Button', '/app/Button.tsx')
    cold.set('Header', '/app/Header.tsx')
    await flush()

    // Warm boot (fresh process, warm webpack cache): only the edited
    // component re-transforms.
    const warm = new PersistedComponentMap(file)
    warm.set('HydrationInfo', '/app/HydrationInfo.tsx')
    await flush()

    const persisted = new Map(
      JSON.parse(fs.readFileSync(file, 'utf-8')) as [string, string][],
    )
    expect(persisted.get('Button')).toBe('/app/Button.tsx')
    expect(persisted.get('Header')).toBe('/app/Header.tsx')
    expect(persisted.get('HydrationInfo')).toBe('/app/HydrationInfo.tsx')

    // Readers see the merged view too.
    expect(new Map(warm).size).toBe(3)
  })
})
