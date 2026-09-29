import { test, expect, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { loadCsf } from 'storybook/internal/csf-tools'

async function rpc(page: Page, method: string, ...args: unknown[]) {
  return page.evaluate(async ({ method, args }) => {
    const ctx = (window as any).__VITE_DEVTOOLS_CLIENT_CONTEXT__ ||
      (window as any).__DEVFRAME_HUB_CLIENT_CONTEXT__
    return ctx.rpc.call(method, ...args)
  }, { method, args })
}

test('panel launch, real story writes and preview', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const host = testInfo.project.name.replace('-chromium', '')
  const cwd = path.resolve('playground', host)
  const vue = host === 'vue' || host === 'nuxt'
  const componentDir = host === 'next' ? 'app/components'
    : host === 'nuxt' ? 'components' : 'src/components'
  const component = path.join(cwd, componentDir, `Button.${vue ? 'vue' : 'tsx'}`)
  const story = component.replace(/\.(vue|tsx)$/, `.stories.${vue ? 'ts' : 'tsx'}`)
  // Exercise both new-file and append paths, restoring the exact original.
  const original = fs.existsSync(story) ? fs.readFileSync(story) : undefined
  if (original) {
    const backup = testInfo.outputPath('original-story')
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.writeFileSync(backup, original)
  }
  const componentPath = fs.realpathSync(component)
  let launched = false
  try {
    fs.rmSync(story, { force: true })
    await page.goto('/')
    await page.request.get('/__devframes/__connection.json').catch(() => {})
    const dock = page.locator('devframes-dock-embedded button[aria-label="Storybook"]')
    await dock.waitFor({ state: 'attached', timeout: 90_000 })
    await dock.dispatchEvent('click')
    const panel = page.frameLocator('devframes-dock-embedded iframe')
    await expect(panel.locator('.rail-btn').first()).toBeVisible({ timeout: 20_000 })

    const data = {
      meta: {
        componentName: 'Button',
        filePath: componentPath,
        relativeFilePath: path.relative(cwd, componentPath),
        sourceId: 'peer-review',
        isDefaultExport: vue,
      },
      serializedProps: vue
        ? { variant: 'primary', 'slot:default': 'Peer review' }
        : { children: 'Peer review' },
      skipNavigation: true,
    }
    await rpc(page, 'component-highlighter:create-story', {
      ...data, storyName: 'Plain',
    })
    expect(fs.existsSync(story)).toBe(true)
    await rpc(page, 'component-highlighter:create-story', {
      ...data, storyName: 'Recorded',
      playImports: ["import { expect, userEvent, within } from 'storybook/test';"],
      playFunction: ['play: async ({ canvasElement }) => {',
        '  const canvas = within(canvasElement);',
        "  await userEvent.click(canvas.getByRole('button'));",
        "  await expect(canvas.getByRole('button')).toBeVisible();",
        "  canvasElement.setAttribute('data-peer-review-play', 'passed');", '}'],
    })
    const source = fs.readFileSync(story, 'utf8')
    const csf = loadCsf(source, {
      fileName: story, makeTitle: title => title || 'Review',
    }).parse()
    expect(Object.keys(csf._storyExports)).toEqual(['Plain', 'Recorded'])
    const framework = host === 'next' ? '@storybook/nextjs'
      : host === 'rsbuild' ? 'storybook-react-rsbuild'
      : vue ? '@storybook/vue3-vite' : '@storybook/react-vite'
    expect(source).toContain(`from '${framework}'`)
    expect(await rpc(page, 'component-highlighter:check-story', { componentPath })).toMatchObject({ hasStory: true })

    // Only take ownership of the process started by this test.
    expect(await rpc(page, 'component-highlighter:storybook-status')).toMatchObject({ running: false })
    await panel.locator('#sb-start-btn').click()
    launched = true
    if (host === 'react18') {
      // This playground deliberately has no Storybook project.
      await expect(panel.locator('#sb-retry-btn')).toBeVisible({ timeout: 60_000 })
      await expect(panel.locator('#sb-error-btn')).toBeVisible()
      await panel.locator('#sb-retry-btn').click()
      await expect(panel.locator('#sb-retry-btn')).toBeVisible({ timeout: 60_000 })
      return
    }
    await expect(panel.locator('.sb-iframe')).toBeVisible({ timeout: 120_000 })
    const indexResponse = await page.request.get('http://localhost:6006/index.json')
    expect(indexResponse.ok()).toBe(true)
    const index = await indexResponse.json()
    const entries = Object.values(index.entries) as Array<{
      id: string; importPath: string; name: string
    }>
    const recorded = entries.find(entry =>
      entry.importPath.includes('Button.stories') && entry.name === 'Recorded')
    expect(recorded).toBeTruthy()
    const preview = await page.context().newPage()
    await preview.goto(`http://localhost:6006/iframe.html?id=${recorded!.id}&viewMode=story`)
    await expect(preview.getByRole('button', {
      name: 'Peer review', exact: true,
    })).toBeVisible({ timeout: 60_000 })
    await expect(preview.locator('#storybook-root')).toHaveAttribute(
      'data-peer-review-play', 'passed', { timeout: 15_000 },
    )
    await preview.close()

    // External deletion must be visible even outside the app import graph.
    fs.unlinkSync(story)
    expect(await rpc(page, 'component-highlighter:check-story', { componentPath })).toMatchObject({ hasStory: false })
  } finally {
    try {
      if (launched) {
        await rpc(page, 'hub:terminals:terminate', 'storybook-dev')
        await expect.poll(async () => {
          try {
            return (await page.request.get('http://localhost:6006', { timeout: 1000 })).ok()
          } catch {
            return false
          }
        }, { timeout: 15_000 }).toBe(false)
      }
    } finally {
      if (original) fs.writeFileSync(story, original)
      else fs.rmSync(story, { force: true })
    }
  }
})
