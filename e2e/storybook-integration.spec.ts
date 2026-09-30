import { test, expect, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { expectPreviewFormat, expectStoryFileFormat, expectedStoryFormat } from './story-format-helpers'

const storybookUrl = process.env.STORYBOOK_E2E_URL || 'http://localhost:6006'

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

    await panel.locator('.rail-btn[title="Coverage"]').click()
    await panel.getByRole('searchbox', { name: 'Find components' }).fill('Button')
    await expect(panel.getByRole('button', { name: 'Create story for Button', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Generate all', exact: true })).toBeVisible()
    await panel.locator('.rail-btn[title="Storybook"]').click()

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
    const batch = await rpc(page, 'component-highlighter:create-stories', [
      { ...data, storyName: 'Batch one' },
      { ...data, storyName: 'Batch two' },
    ])
    expect(batch).toEqual({ created: 2, failed: 0 })
    const toasts = page.locator('devframes-dock-embedded .z-dock-toast > div')
    await expect(toasts.filter({ hasText: 'Created 2 stories' })).toHaveCount(1)
    await expect(toasts.filter({ hasText: /BatchOne|BatchTwo/ })).toHaveCount(0)
    const source = fs.readFileSync(story, 'utf8')
    const format = expectedStoryFormat(host)
    expectPreviewFormat(cwd, format)
    expectStoryFileFormat(source, story, format, ['Plain', 'Recorded', 'BatchOne', 'BatchTwo'])
    if (format === 'factory') {
      expect(source).toContain("import preview from '../../.storybook/preview';")
    } else {
      const framework = host === 'next' ? '@storybook/nextjs'
        : host === 'rsbuild' ? 'storybook-react-rsbuild'
        : vue ? '@storybook/vue3-vite' : '@storybook/react-vite'
      expect(source).toContain(`from '${framework}'`)
    }
    expect(await rpc(page, 'component-highlighter:check-story', { componentPath })).toMatchObject({ hasStory: true })

    // Include a real docs entry to exercise the inspector's lazy Docs pane.
    fs.writeFileSync(story, source.replace(/component: Button,?/, "component: Button, tags: ['autodocs'],"))

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
    const indexResponse = await page.request.get(`${storybookUrl}/index.json`)
    expect(indexResponse.ok()).toBe(true)
    const index = await indexResponse.json()
    const entries = Object.values(index.entries) as Array<{
      id: string; type: string; importPath: string; name: string
    }>
    const buttonStories = entries.filter(entry =>
      entry.type === 'story' && entry.importPath.includes('Button.stories'))
    expect(buttonStories.map(entry => entry.name).sort()).toEqual(
      ['Batch One', 'Batch Two', 'Plain', 'Recorded'])
    const recorded = buttonStories.find(entry => entry.name === 'Recorded')
    expect(recorded).toBeTruthy()
    const preview = await page.context().newPage()
    await preview.goto(`${storybookUrl}/iframe.html?id=${recorded!.id}&viewMode=story`)
    await expect(preview.getByRole('button', {
      name: 'Peer review', exact: true,
    })).toBeVisible({ timeout: 60_000 })
    await expect(preview.locator('#storybook-root')).toHaveAttribute(
      'data-peer-review-play', 'passed', { timeout: 15_000 },
    )
    await preview.close()

    // Inspector tabs share one story draft and creation action.
    await panel.locator('.rail-btn[title="Coverage"]').click()
    await panel.getByRole('searchbox', { name: 'Find components' }).fill('Button')
    await panel.getByRole('button', { name: 'View stories for Button', exact: true }).click()
    await expect(panel.getByRole('tab', { name: /^Stories/ })).toHaveAttribute('aria-selected', 'true')
    await panel.getByRole('tab', { name: 'Properties', exact: true }).click()
    const selection = await page.evaluate(() => {
      const entries = [...(window as any).__componentHighlighterRegistry.values()]
      const entry = entries.find((entry: any) => entry.meta.componentName === 'Button')
      return { id: entry.id, meta: entry.meta, serializedProps: entry.serializedProps, isConnected: true }
    })
    await rpc(page, 'component-highlighter:select-component', selection)
    await expect(panel.getByRole('tab', { name: 'Properties', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.locator('.hl-docs-iframe')).toHaveCount(0)
    await panel.getByRole('tab', { name: 'Docs', exact: true }).click()
    const docs = panel.locator('.hl-docs-iframe')
    await expect(docs).toBeVisible()
    await expect(docs).toHaveAttribute('src', /viewMode=docs&id=/)
    await docs.evaluate(el => el.setAttribute('data-preserved', 'true'))
    await panel.getByRole('tab', { name: /^Stories/ }).click()
    await expect(docs).toBeHidden()
    const nameInput = panel.getByRole('textbox', { name: 'Story name' })
    await nameInput.fill('Unsaved draft')
    await panel.getByRole('tab', { name: 'Properties', exact: true }).click()
    // A props refresh must retain pane state and avoid replacing loaded iframes.
    await rpc(page, 'component-highlighter:select-component', {
      ...selection, serializedProps: { ...selection.serializedProps, designCheck: 'updated' },
    })
    await expect(panel.locator('#hl-properties-panel')).toContainText('designCheck')
    await expect(nameInput).toHaveValue('Unsaved draft')
    await expect(panel.getByRole('button', { name: 'Create story', exact: true })).toBeVisible()
    await panel.getByRole('tab', { name: 'Docs', exact: true }).click()
    await expect(docs).toBeVisible()
    await expect(docs).toHaveAttribute('data-preserved', 'true')
    await expect(nameInput).toHaveValue('Unsaved draft')
    await panel.getByRole('tab', { name: /^Stories/ }).click()
    await expect(nameInput).toHaveValue('Unsaved draft')
    await expect(panel.locator('#hl-properties-panel')).toBeHidden()
    // Edit a live prop and save directly from Properties, without switching tabs.
    await panel.getByRole('tab', { name: 'Properties', exact: true }).click()
    const editedVariant = selection.serializedProps.variant === 'primary' ? 'secondary' : 'primary'
    await panel.getByTitle('Edit variant live', { exact: true }).click()
    await panel.locator('.hl-prop-edit-form input').fill(editedVariant)
    await panel.locator('.hl-prop-edit-save').click()
    await expect.poll(() => page.evaluate((id) =>
      (window as any).__componentHighlighterRegistry.get(id)?.serializedProps.variant,
    selection.id)).toBe(editedVariant)
    await expect(panel.getByTitle('Reset variant to original', { exact: true })).toBeVisible()
    await expect(nameInput).toHaveValue('Unsaved draft')
    await nameInput.fill('Edited from properties')
    await panel.getByRole('button', { name: 'Create story', exact: true }).click()
    await expect.poll(() => fs.readFileSync(story, 'utf8')).toContain('export const EditedFromProperties')
    expect(fs.readFileSync(story, 'utf8').split('export const EditedFromProperties')[1]).toMatch(new RegExp(`variant:\\s*["']${editedVariant}["']`))
    await expect(panel.getByRole('tab', { name: 'Properties', exact: true })).toHaveAttribute('aria-selected', 'true')
    // A new instance resets to Properties, with unavailable Docs omitted.
    await rpc(page, 'component-highlighter:select-component', {
      ...selection, id: 'no-docs-selection',
      meta: { ...selection.meta, componentName: 'NoDocs', filePath: '/NoDocs.tsx', relativeFilePath: 'NoDocs.tsx' },
    })
    await expect(panel.getByRole('tab', { name: 'Properties', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(panel.getByRole('tab', { name: 'Docs', exact: true })).toHaveCount(0)
    await expect(panel.getByRole('tab', { name: /^Stories/ })).toBeVisible()

    // External deletion must be visible even outside the app import graph.
    fs.unlinkSync(story)
    expect(await rpc(page, 'component-highlighter:check-story', { componentPath })).toMatchObject({ hasStory: false })
  } finally {
    try {
      if (launched) {
        await rpc(page, 'hub:terminals:terminate', 'storybook-dev')
        await expect.poll(async () => {
          try {
            return (await page.request.get(storybookUrl, { timeout: 1000 })).ok()
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
