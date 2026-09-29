import { test, expect, type Page } from '@playwright/test'
import { registerCommonHighlighterSuite } from './common-highlighter-suite'
import { registerHighlightPanelStateSuite } from './common-highlight-panel-state-suite'
import { registerLivePropEditSuite } from './common-live-prop-edit-suite'
import { registerListenersReplaySuite } from './common-listeners-replay-suite'
import { registerSsrSuite } from './common-ssr-suite'
import { registerPanelRenderSuite } from './common-panel-render-suite'

type RegistrySnapshot = {
  size: number
  uniqueNames: string[]
  hasUnknownFilePath: boolean
  byName: Record<string, number>
}

async function getRegistrySnapshot(page: Page) {
  return page.evaluate(() => {
    const registry = (window as any).__componentHighlighterRegistry as
      | Map<
          string,
          {
            meta?: { componentName?: string; filePath?: string }
          }
        >
      | undefined

    if (!registry) return null

    const entries = Array.from(registry.values())
    const byName: Record<string, number> = {}

    for (const entry of entries) {
      const name = entry.meta?.componentName || 'Unknown'
      byName[name] = (byName[name] || 0) + 1
    }

    const uniqueNames = Object.keys(byName).sort()
    const hasUnknownFilePath = entries.some((entry) => {
      const filePath = entry.meta?.filePath || ''
      return filePath === 'unknown' || filePath.trim() === ''
    })

    const snapshot: RegistrySnapshot = {
      size: registry.size,
      uniqueNames,
      hasUnknownFilePath,
      byName,
    }

    return snapshot
  })
}

test.describe('Next.js playground detection coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('button')
    await expect.poll(() => getRegistrySnapshot(page), { timeout: 15_000 }).toMatchObject({
      uniqueNames: expect.arrayContaining(['ClientApp', 'HydrationInfo']),
    })
  })

  test('detects the expected client-component set on initial render', async ({
    page,
  }) => {
    const snapshot = await getRegistrySnapshot(page)

    expect(snapshot).toBeTruthy()
    expect(snapshot?.hasUnknownFilePath).toBe(false)

    expect(snapshot?.uniqueNames).toEqual([
      'Badge',
      'Button',
      'ClientApp',
      'Header',
      'HydrationInfo',
      'Modal',
      'TaskCard',
      'TaskList',
    ])

    expect(snapshot?.byName.TaskCard).toBeGreaterThanOrEqual(3)
    expect(snapshot?.byName.Button).toBeGreaterThanOrEqual(1)
  })

  test('the server component never appears in the registry (RSC boundary)', async ({
    page,
  }) => {
    const snapshot = await getRegistrySnapshot(page)
    expect(snapshot?.uniqueNames).not.toContain('ServerInfo')

    // It did render — server-only content, proving it's a real RSC render,
    // not just an absent/broken import.
    const serverInfoText = await page
      .locator('.server-info')
      .textContent()
    expect(serverInfoText).toContain('Server component')
  })

  test('tracks modal subtree components after opening the task form', async ({
    page,
  }) => {
    await page.getByRole('button', { name: '+ New Task' }).click()
    await page.waitForTimeout(500)

    const snapshot = await getRegistrySnapshot(page)

    expect(snapshot).toBeTruthy()
    expect(snapshot?.hasUnknownFilePath).toBe(false)
    expect(snapshot?.uniqueNames).toEqual(
      expect.arrayContaining(['TaskForm', 'Input', 'Select']),
    )
  })

  test('uses real source metadata for TaskList (no unknown path)', async ({
    page,
  }) => {
    const meta = await page.evaluate(() => {
      const registry = (window as any).__componentHighlighterRegistry as
        | Map<string, { meta?: { componentName?: string; filePath?: string } }>
        | undefined

      if (!registry) return null

      const taskList = Array.from(registry.values()).find(
        (entry) => entry.meta?.componentName === 'TaskList',
      )

      return taskList?.meta || null
    })

    expect(meta).toBeTruthy()
    expect(meta?.filePath).toContain('/playground/next/app/components/TaskList.tsx')
    expect(meta?.filePath).not.toBe('unknown')
  })
})

registerCommonHighlighterSuite(test as any)
registerHighlightPanelStateSuite(test as any)
registerLivePropEditSuite(test as any, {
  // The Next playground has no PropZoo; TaskCard's `task` object covers the
  // json kind via a NESTED path.
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
      payload: { kind: 'json', text: '"Edited via E2E"' },
      probe: { selector: '.task-card-title', contains: 'Edited via E2E' },
    },
  ],
})
registerListenersReplaySuite(test as any)
registerSsrSuite(test as any, expect as any, {
  componentName: 'HydrationInfo',
  selector: '.hydration-info',
  markerText: 'initially server-rendered at',
})
registerPanelRenderSuite(test as any, expect as any, { componentName: 'TaskCard' })
