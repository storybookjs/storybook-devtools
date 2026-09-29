import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { enableHighlighting, hoverTaskListHeading } from './highlighter-helpers'

type TestLike = {
  describe: (name: string, fn: () => void) => void
  beforeEach: (fn: (ctx: { page: Page }) => Promise<void>) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (name: string, fn: (ctx: { page: Page }) => Promise<void>): any
}

type ReplaySnapshot = {
  size: number
  uniqueNames: string[]
}

async function getRegistrySnapshot(page: Page): Promise<ReplaySnapshot | null> {
  return page.evaluate(() => {
    const registry = (window as any).__componentHighlighterRegistry as
      | Map<string, { meta?: { componentName?: string } }>
      | undefined
    if (!registry) return null
    const names = new Set<string>()
    for (const entry of registry.values()) {
      names.add(entry.meta?.componentName || 'Unknown')
    }
    return { size: registry.size, uniqueNames: Array.from(names).sort() }
  })
}

/**
 * In a consuming app the client listeners module loads via the async DevTools
 * client — AFTER the framework's first commit — so the runtime's initial
 * `component-highlighter:register` events fire with nobody listening. The
 * replay handshake recovers those: listeners.ts dispatches
 * `component-highlighter:listeners-ready` once attached, and each runtime
 * replays its registry (`onListenersReady` in src/runtime-helpers.ts).
 *
 * The playgrounds import listeners eagerly (deterministic E2E activation), so
 * the race itself can't be reproduced here. Instead these tests simulate its
 * observable effect — a client registry that missed the initial register
 * events — by clearing it, then re-running the handshake and asserting full
 * recovery.
 */
export function registerListenersReplaySuite(test: TestLike) {
  test.describe('listeners-ready registry replay', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await page.waitForSelector('button')
      await page.waitForTimeout(800)
    })

    test('replays the runtime registry when listeners announce readiness', async ({
      page,
    }) => {
      const before = await getRegistrySnapshot(page)
      expect(before).toBeTruthy()
      expect(before!.size).toBeGreaterThan(0)

      const clearedSize = await page.evaluate(() => {
        const registry = (window as any).__componentHighlighterRegistry as Map<
          string,
          unknown
        >
        registry.clear()
        return registry.size
      })
      expect(clearedSize).toBe(0)

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('component-highlighter:listeners-ready'),
        )
      })

      const after = await getRegistrySnapshot(page)
      expect(after).toBeTruthy()
      expect(after!.size).toBe(before!.size)
      expect(after!.uniqueNames).toEqual(before!.uniqueNames)
    })

    test('highlighting works on replayed instances', async ({ page }) => {
      await page.evaluate(() => {
        const registry = (window as any).__componentHighlighterRegistry as Map<
          string,
          unknown
        >
        registry.clear()
        window.dispatchEvent(
          new CustomEvent('component-highlighter:listeners-ready'),
        )
      })

      await enableHighlighting(page)
      await hoverTaskListHeading(page)

      const label = page.locator('.ch-highlight-label').first()
      await expect(label).toBeVisible()
      // Replay must restore the outline regardless of locally generated stories.
      await expect(label.locator('..')).toHaveCSS('outline-style', 'solid')
    })
  })
}
