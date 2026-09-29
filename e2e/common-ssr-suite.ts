import type { test as testBase, expect as expectBase } from '@playwright/test'

export type SsrSuiteOptions = {
  /**
   * Component that renders server-computed data (the playground's
   * `HydrationInfo`) — asserted present in the raw SSR payload and in the
   * highlighter registry after hydration.
   */
  componentName: string
  /** CSS class the component renders, checked in the raw HTML payload. */
  selector: string
  /** Stable text the component renders, checked before and after hydration. */
  markerText: string
}

/**
 * SSR + hydration integrity for hosts that server-render the app (Next.js
 * App Router, Nuxt): the component's markup must already be in the raw HTML
 * payload, hydration must complete without mismatch errors while
 * instrumentation is active, and the hydrated instance must register with
 * the highlighter.
 */
export function registerSsrSuite(
  test: typeof testBase,
  expect: typeof expectBase,
  options: SsrSuiteOptions,
) {
  const { componentName, selector, markerText } = options

  test.describe('SSR + hydration', () => {
    test('raw server HTML contains the SSR-data component markup', async ({
      request,
    }) => {
      const response = await request.get('/')
      expect(response.ok()).toBe(true)

      const html = await response.text()
      // The rendered attribute form — a bare class-name substring would also
      // match Next's inline RSC flight payload, which is not rendered markup.
      expect(html).toContain(`class="${selector.replace(/^\./, '')}"`)
      expect(html).toContain(markerText)
    })

    test('hydrates without mismatch or highlighter errors and registers the component', async ({
      page,
    }) => {
      const hydrationErrors: string[] = []
      const isHydrationError = (text: string) =>
        /hydrat|did not match|mismatch|component-highlighter/i.test(text)
      page.on('console', (msg) => {
        if (msg.type() === 'error' && isHydrationError(msg.text())) {
          hydrationErrors.push(msg.text())
        }
      })
      page.on('pageerror', (err) => {
        if (isHydrationError(String(err))) {
          hydrationErrors.push(String(err))
        }
      })

      await page.goto('/')
      await page.waitForSelector(selector)
      // Let hydration and the highlighter's initial fiber/instance walk settle.
      await page.waitForTimeout(1500)

      expect(hydrationErrors).toEqual([])

      // The server-rendered content survived hydration.
      await expect(page.locator(selector)).toContainText(markerText)

      // The hydrated instance is tracked by the highlighter.
      const registered = await page.evaluate((name) => {
        const registry = (
          window as unknown as {
            __componentHighlighterRegistry?: Map<
              string,
              { meta?: { componentName?: string } }
            >
          }
        ).__componentHighlighterRegistry
        if (!registry) return false
        return Array.from(registry.values()).some(
          (entry) => entry.meta?.componentName === name,
        )
      }, componentName)
      expect(registered).toBe(true)
    })
  })
}
