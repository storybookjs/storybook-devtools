import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  clickComponentHighlight,
  enableHighlighting,
  exerciseTaskFormInteractions,
  hoverComponent,
  hoverTaskListHeading,
  isHighlightActive,
  locateInstance,
  toggleHighlightVisibility,
  waitForCreateStoryRequest,
} from './highlighter-helpers'

type TestLike = {
  describe: (name: string, fn: () => void) => void
  beforeEach: (fn: (ctx: { page: Page }) => Promise<void>) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (name: string, fn: (ctx: { page: Page }) => Promise<void>): any
}

const TARGET_COMPONENT = 'TaskList'
const INTERACTION_COMPONENT = 'TaskForm'
const MULTI_INSTANCE_COMPONENT = 'Badge'

export function registerCommonHighlighterSuite(test: TestLike) {
  for (const hasStory of [false, true]) {
    test(`hover colors and label alignment with stories=${hasStory}`, async ({ page }) => {
      await page.goto('/')
      await page.waitForFunction(() => {
        const w = window as any
        return w.__componentHighlighterRegistry?.size && (w.__VITE_DEVTOOLS_CLIENT_CONTEXT__ || w.__DEVFRAME_HUB_CLIENT_CONTEXT__)?.rpc
      })
      // Control only story existence; exercise the real overlay and registry.
      await page.evaluate((hasStory) => {
        const w = window as any
        const ctx = w.__VITE_DEVTOOLS_CLIENT_CONTEXT__ || w.__DEVFRAME_HUB_CLIENT_CONTEXT__
        const original = ctx.rpc.call.bind(ctx.rpc)
        ctx.rpc.call = (method: string, ...args: unknown[]) => method === 'component-highlighter:check-story'
          ? Promise.resolve({ hasStory, storyPath: hasStory ? '/Badge.stories.tsx' : null })
          : original(method, ...args)
      }, hasStory)
      await enableHighlighting(page)
      const id = await hoverComponent(page, 'Badge')
      const box = page.locator(`[data-highlight-id="${id}"]`)
      await expect(box.locator('.ch-highlight-label')).toBeVisible()
      const color = hasStory ? 'rgb(255, 71, 133)' : 'rgb(0, 109, 235)'
      await expect(box).toHaveCSS('outline-color', color)
      await expect(box).toHaveCSS('outline-style', 'solid')
      const siblings = page.locator(`[data-highlight-id]:not([data-highlight-id="${id}"])`)
      expect(await siblings.count()).toBeGreaterThan(0)
      await expect(siblings.first()).toHaveCSS('outline-color', color)
      await expect(siblings.first()).toHaveCSS('outline-style', 'dashed')
      if (hasStory) {
        const pill = await box.locator('.ch-label-name').boundingBox()
        const rect = await box.boundingBox()
        const badge = await box.locator('.ch-label-badge').boundingBox()
        expect(pill!.x).toBeCloseTo(rect!.x, 0)
        expect(badge!.x + badge!.width).toBeLessThan(pill!.x)
        // Move the actual component to the viewport edge and re-hover.
        await page.evaluate((id) => {
          const el = (window as any).__componentHighlighterRegistry.get(id).element as HTMLElement
          el.style.position = 'fixed'
          el.style.left = '0px'
          el.style.top = '100px'
          el.style.zIndex = '999'
        }, id)
        await page.mouse.move(600, 10)
        await hoverComponent(page, 'Badge')
        await expect(box).toHaveCSS('left', '0px')
        await expect.poll(async () => (await box.locator('.ch-label-badge').boundingBox())?.x).toBe(0)
        expect((await box.locator('.ch-label-name').boundingBox())!.x).toBe(22)
      } else {
        await expect(box.locator('.ch-label-badge')).toBeHidden()
      }
    })
  }

  test.describe('common highlighter features', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/')
      await page.waitForSelector('button')
      await page.waitForTimeout(800)
      await enableHighlighting(page)
    })

    test('renders highlight container', async ({ page }) => {
      await expect(page.locator('#component-highlighter-container')).toBeVisible()
    })

    test('shows hover highlight behavior when hovering a component', async ({ page }) => {
      await hoverTaskListHeading(page)

      const hovered = page.locator('.ch-highlight-label').first()
      await expect(hovered).toBeVisible()
      await expect(hovered.locator('.ch-label-badge')).toBeHidden()
      await expect(hovered.locator('..')).toHaveCSS('outline-color', 'rgb(0, 109, 235)')
    })

    test('hide highlights hides only the selection and keeps hover/select working', async ({ page }) => {
      const boxes = page.locator('#component-highlighter-container div[data-highlight-id]')
      await clickComponentHighlight(page, TARGET_COMPONENT)
      await expect(boxes).not.toHaveCount(0)

      await toggleHighlightVisibility(page)
      await expect(boxes).toHaveCount(0)
      expect(await isHighlightActive(page)).toBe(true)
      await expect(page.locator('[data-coverage-highlight]')).toHaveCount(0)

      // Hovering a different component (outside the context menu) still
      // draws its hover highlight.
      const headerId = await hoverComponent(page, 'Header')
      await expect(boxes).toHaveCount(1)
      await expect(boxes.first()).toHaveAttribute('data-highlight-id', headerId)

      await toggleHighlightVisibility(page)
      await expect(boxes.count()).resolves.toBeGreaterThan(1)
    })

    test('locate pulses the exact selected instance, not the first match', async ({ page }) => {
      const ids = await page.evaluate((name) => {
        const registry = (window as any).__componentHighlighterRegistry as Map<
          string,
          { id: string; meta: { componentName: string } }
        >
        return Array.from(registry.values())
          .filter((i) => i.meta.componentName === name)
          .map((i) => i.id)
      }, MULTI_INSTANCE_COMPONENT)
      expect(ids.length).toBeGreaterThan(1)

      const { pulse, target, labelOpacity } = await locateInstance(
        page,
        MULTI_INSTANCE_COMPONENT,
        ids[1],
      )
      expect(target).not.toBeNull()
      expect(pulse).toEqual(target)
      expect(labelOpacity).toBe('1')
    })

    test('opens context menu on highlighted component click', async ({ page }) => {
      await clickComponentHighlight(page, TARGET_COMPONENT)

      await expect(page.locator('#open-component-btn')).toBeVisible()
      await expect(page.locator('#save-story-btn')).toBeVisible()
      await expect(page.locator('#story-name-input')).toBeVisible()
      await expect(page.locator('text=Properties')).toBeVisible()
    })

    test('supports context menu close interactions', async ({ page }) => {
      await clickComponentHighlight(page, TARGET_COMPONENT)
      await expect(page.locator('#save-story-btn')).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(page.locator('#save-story-btn')).not.toBeVisible()

      await clickComponentHighlight(page, TARGET_COMPONENT)
      await expect(page.locator('#save-story-btn')).toBeVisible()
      await page.mouse.click(10, 10)
      await expect(page.locator('#save-story-btn')).not.toBeVisible()
    })

    test('save story emits create-story request with serialized props', async ({ page }) => {
      await clickComponentHighlight(page, TARGET_COMPONENT)

      const payload = await waitForCreateStoryRequest(page, async () => {
        await page.locator('#story-name-input').fill('E2ESaveStory')
        await page.locator('#save-story-btn').click()
      })

      expect(payload.meta.componentName).toBe(TARGET_COMPONENT)
      expect(payload.storyName).toBe('E2ESaveStory')
      expect(payload.serializedProps).toBeTruthy()
      expect(payload.includePlayFunction).toBe(false)
    })

    test('save story with interactions captures TaskForm interactions', async ({ page }) => {
      await page.getByRole('button', { name: '+ New Task' }).click()
      await page.waitForTimeout(250)

      await clickComponentHighlight(page, INTERACTION_COMPONENT)
      await page.locator('#save-story-with-interactions-btn').click()

      await expect(page.locator('#component-highlighter-recording-indicator')).toBeVisible()

      await exerciseTaskFormInteractions(page)

      const payload = await waitForCreateStoryRequest(page, async () => {
        await page.locator('#recording-stop-btn').click()
      })

      expect(payload.meta.componentName).toBe(INTERACTION_COMPONENT)
      expect(payload.includePlayFunction).toBe(true)
      expect(Array.isArray(payload.playFunction)).toBe(true)
      expect(payload.playFunction.length).toBeGreaterThan(0)
    })
  })
}
