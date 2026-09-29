import type { test as testBase, expect as expectBase } from '@playwright/test'

/**
 * Opens the real DevTools dock panel (the `storybook-devtools` iframe dock)
 * and asserts the panel SPA actually renders and receives synced data —
 * the seam every window-global-driven suite skips.
 */
export function registerPanelRenderSuite(
  test: typeof testBase,
  expect: typeof expectBase,
  opts: { componentName: string },
) {
  test.describe('storybook panel render', () => {
    test('first highlighter dock click activates, closes, and reactivates', async ({ page }) => {
      test.setTimeout(120_000)
      const duplicateRpcWarnings: string[] = []
      page.on('console', message => {
        if (message.text().includes('DF0021')) duplicateRpcWarnings.push(message.text())
      })
      await page.goto('/')
      await page.request.get('/__devframes/__connection.json').catch(() => {})
      const dock = page.locator('devframes-dock-embedded button[aria-label="Component Highlighter"]')
      await dock.waitFor({ state: 'attached', timeout: 90_000 })
      for (const enabled of [true, false, true, false]) {
        await dock.dispatchEvent('click')
        await expect.poll(() => page.evaluate(() =>
          (window as any).__componentHighlighterIsActive?.() ?? false,
        )).toBe(enabled)
        if (enabled) {
          await page.getByRole('heading', { name: 'All Tasks' }).hover()
          await expect(page.locator('#component-highlighter-container [data-highlight-id]').first()).toBeVisible()
        }
      }
      expect(duplicateRpcWarnings).toEqual([])
    })

    test('panel renders and coverage lists a component from the page', async ({
      page,
    }) => {
      test.setTimeout(120_000)
      await page.goto('/')
      // Compile-on-demand hosts (next dev) build the hub route on first
      // hit — warm it so the dock's embedded script can connect promptly.
      await page
        .request.get('/__devframes/__connection.json')
        .catch(() => {})

      // Playwright CSS locators pierce the dock's open shadow root.
      // The collapsed dock expands on hover and its container intercepts
      // real pointer events, so dispatch the click straight to the button.
      const dockBtn = page.locator(
        'devframes-dock-embedded button[aria-label="Storybook"]',
      )
      // next's dev server compiles routes lazily on first hit — allow for it.
      await dockBtn.waitFor({ state: 'attached', timeout: 90_000 })
      await dockBtn.dispatchEvent('click')

      const panel = page.frameLocator('devframes-dock-embedded iframe')

      // The panel SPA booted: its rail rendered (fails on stale/unserved assets).
      await expect(panel.locator('.rail-btn').first()).toBeVisible({
        timeout: 15_000,
      })

      // Documentation belongs on About, and the rail uses the monochrome icon.
      await expect(panel.locator('.rail-btn[title="Open Storybook docs"]')).toHaveCount(0)
      await expect(panel.locator('.rail-btn[data-tab="storybook"] svg path')).toHaveAttribute('fill', 'currentColor')
      await panel.locator('.rail-btn[title="About"]').click()
      const docsUrl = await page.evaluate(async () => {
        const w = window as any
        const ctx = w.__VITE_DEVTOOLS_CLIENT_CONTEXT__ || w.__DEVFRAME_HUB_CLIENT_CONTEXT__
        return (await ctx.rpc.call('component-highlighter:get-config')).storybookDocsUrl
      })
      await expect(panel.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', docsUrl)

      // Coverage requires the full pipeline: transform tracking on the
      // server, registry sync from the app page, and the get-coverage RPC.
      await panel.locator('.rail-btn[title="Coverage"]').click()
      await expect(panel.locator('#pane-coverage')).toContainText(
        opts.componentName,
        { timeout: 20_000 },
      )
      const search = panel.getByRole('searchbox', { name: 'Find components' })
      await search.fill('no-component-matches-this')
      await expect(panel.getByText('No matching components')).toBeVisible()
      await search.fill(opts.componentName)
      await expect(panel.locator('.cov-item')).toHaveCount(1)
      const row = panel.locator('.cov-item')
      await expect(row.locator('.cov-warning-icon, .cov-check-icon')).toHaveCount(0)
      await expect(row.getByRole('button', { name: /More actions/ })).toBeVisible()
      await expect(row.locator('.cov-primary-action')).toHaveText(/Create story|View stories/)
      await row.getByRole('button', { name: `Inspect ${opts.componentName}`, exact: true }).click()
      await expect(panel.getByRole('tab', { name: 'Properties', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(panel.locator('#hl-properties-panel')).toBeVisible()
      await expect(panel.locator('.hl-story-name-row')).toBeHidden()
      await panel.getByRole('tab', { name: /^Stories/ }).click()
      await expect(panel.locator('.hl-story-name-row')).toBeVisible()
      await expect(panel.locator('#hl-properties-panel')).toBeHidden()
      await panel.getByRole('tab', { name: /^Stories/ }).press('Home')
      await expect(panel.getByRole('tab', { name: 'Properties', exact: true })).toBeFocused()
      await panel.getByRole('tab', { name: 'Properties', exact: true }).press('End')
      await expect(panel.getByRole('tab', { name: /^Stories/ })).toHaveAttribute('aria-selected', 'true')
      // Search state survives leaving and returning to Coverage.
      await panel.locator('.rail-btn[title="Coverage"]').click()
      await expect(search).toHaveValue(opts.componentName)
      await search.fill('')

      await page.evaluate(async () => {
        const w = window as any
        const ctx = w.__VITE_DEVTOOLS_CLIENT_CONTEXT__ || w.__DEVFRAME_HUB_CLIENT_CONTEXT__
        await ctx.rpc.call('component-highlighter:notify', { message: 'Design notification check', level: 'success' })
      })
      const toast = page.locator('devframes-dock-embedded .z-dock-toast > div').filter({ hasText: 'Design notification check' })
      await expect(toast).toBeVisible()
      await expect(toast).toHaveCSS('background-color', 'rgba(26, 57, 77, 0.97)')
      await expect(toast.locator('.font-medium')).toHaveCSS('font-size', '12px')
      await page.emulateMedia({ colorScheme: 'dark' })
      await expect(toast).toHaveCSS('background-color', 'rgba(238, 243, 246, 0.97)')
      await page.emulateMedia({ colorScheme: 'light' })
      await toast.locator('button').last().click()
      await expect(toast).toHaveCount(0)

      await panel.locator('.rail-btn[title="Component Highlighter"]').click()
      await page.waitForFunction(() => (window as any).__componentHighlighterIsActive?.())
      await page.evaluate((name) => {
        const w = window as any
        const instance = [...w.__componentHighlighterRegistry.values()].find((i: any) => i.meta.componentName === name)
        w.__componentHighlighterSelectById(instance.id)
      }, opts.componentName)
      await expect(panel.getByTitle('Open component in editor', { exact: true })).toBeVisible()
      await panel.locator('.hl-hdr-actions').getByTitle('More actions').click()
      await expect(panel.locator('.act-popover')).not.toContainText('Open component in editor')
    })
  })
}
