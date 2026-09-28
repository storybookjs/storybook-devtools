import { test, expect } from '@playwright/test'
import { registerCommonHighlighterSuite } from './common-highlighter-suite'
import { registerHighlightPanelStateSuite } from './common-highlight-panel-state-suite'
import { registerLivePropEditSuite } from './common-live-prop-edit-suite'
import { registerListenersReplaySuite } from './common-listeners-replay-suite'
import { registerPanelRenderSuite } from './common-panel-render-suite'
import { registerSsrSuite } from './common-ssr-suite'

type RegistrySnapshot = {
  size: number
  uniqueNames: string[]
  hasUnknownFilePath: boolean
}

async function getRegistrySnapshot(page: Parameters<typeof test>[0]['page']) {
  return page.evaluate(() => {
    const registry = (window as any).__componentHighlighterRegistry as
      | Map<string, { meta?: { componentName?: string; filePath?: string } }>
      | undefined

    if (!registry) return null

    const entries = Array.from(registry.values())
    const uniqueNames = Array.from(
      new Set(entries.map((entry) => entry.meta?.componentName || 'Unknown')),
    ).sort()

    const hasUnknownFilePath = entries.some((entry) => {
      const filePath = entry.meta?.filePath || ''
      return filePath === 'unknown' || filePath.trim() === ''
    })

    const snapshot: RegistrySnapshot = {
      size: registry.size,
      uniqueNames,
      hasUnknownFilePath,
    }

    return snapshot
  })
}

test.describe('Nuxt SSR playground detection coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('button')
    await page.waitForTimeout(1000)
  })

  test('renders server HTML before hydration', async ({ request }) => {
    const response = await request.get('/')
    expect(response.ok()).toBe(true)

    const html = await response.text()
    expect(html).toContain('TaskFlow Nuxt SSR')
    expect(html).toContain('Review component highlighter PR')
    expect(html).toContain('/__devtools/embedded.js')
  })

  test('injects the Vite DevTools dock with Storybook tools', async ({
    page,
  }) => {
    await expect
      .poll(
        async () => {
          return page.evaluate(async () => {
            const dock = document.querySelector('devframes-dock-embedded') as
              | (HTMLElement & { shadowRoot?: ShadowRoot })
              | null
            const shadow = dock?.shadowRoot
            const html = shadow?.innerHTML || ''
            const importsResponse = await fetch(
              '/__devtools-client-imports.js',
            )
            const imports = importsResponse.ok
              ? await importsResponse.text()
              : ''

            return {
              hasDock: Boolean(dock),
              hasUnauthorized: html.includes('Unauthorized'),
              hasStorybookIcon:
                html.includes('FF4785') || html.includes('%23FF4785'),
              hasComponentHighlighterImport: imports.includes(
                'action:component-highlighter',
              ),
              hasMultipleDockButtons:
                (shadow?.querySelectorAll('button').length || 0) >= 3,
            }
          })
        },
        // Nuxt's dev server and the DevTools client bundle compile lazily on
        // first hit — allow more than the default 5s poll window for a cold
        // start (mirrors the 90s wait in common-panel-render-suite.ts).
        { timeout: 90_000 },
      )
      .toEqual({
        hasDock: true,
        hasUnauthorized: false,
        hasStorybookIcon: true,
        hasComponentHighlighterImport: true,
        hasMultipleDockButtons: true,
      })
  })

  test('detects expected baseline components after hydration', async ({
    page,
  }) => {
    const snapshot = await getRegistrySnapshot(page)

    expect(snapshot).toBeTruthy()
    expect(snapshot?.hasUnknownFilePath).toBe(false)
    expect(snapshot?.uniqueNames).toEqual(
      expect.arrayContaining([
        'Header',
        'TaskList',
        'TaskCard',
        'Button',
        'Badge',
        'Modal',
      ]),
    )
  })

  test('tracks modal form components when modal opens', async ({ page }) => {
    await page.getByRole('button', { name: '+ New Task' }).click()
    await page.waitForTimeout(500)

    const snapshot = await getRegistrySnapshot(page)

    expect(snapshot).toBeTruthy()
    expect(snapshot?.hasUnknownFilePath).toBe(false)
    expect(snapshot?.uniqueNames).toEqual(
      expect.arrayContaining(['TaskForm', 'Input', 'Select']),
    )
  })
})

registerCommonHighlighterSuite(test as any)
registerHighlightPanelStateSuite(test as any)
registerLivePropEditSuite(test as any, {
  dataTypeTargets: [
    {
      componentName: 'Header',
      path: ['title'],
      payload: { kind: 'string', text: 'E2E Title' },
      probe: { selector: '.header-title', contains: 'E2E Title' },
    },
    {
      componentName: 'TaskList',
      path: ['count'],
      payload: { kind: 'number', text: '777' },
      probe: { selector: '.task-list-count', contains: '777' },
    },
    {
      componentName: 'TaskCard',
      path: ['task', 'title'],
      payload: { kind: 'json', text: '"E2E Task Title"' },
      probe: { selector: '.task-card-title', contains: 'E2E Task Title' },
    },
  ],
})
registerListenersReplaySuite(test as any)
registerPanelRenderSuite(test as any, expect as any, { componentName: 'TaskCard' })
registerSsrSuite(test as any, expect as any, {
  componentName: 'HydrationInfo',
  selector: '.hydration-info',
  markerText: 'Server-rendered at',
})
