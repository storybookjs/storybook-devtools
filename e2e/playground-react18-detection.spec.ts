import { registerAgentSuite } from './common-agent-suite'
import { test, expect } from '@playwright/test'
import { registerCommonHighlighterSuite } from './common-highlighter-suite'
import { registerHighlightPanelStateSuite } from './common-highlight-panel-state-suite'
import { registerLivePropEditSuite } from './common-live-prop-edit-suite'
import { registerListenersReplaySuite } from './common-listeners-replay-suite'

/**
 * React 18 parity suite.
 *
 * React 18 is a required supported version. This runs the full shared
 * highlighter functionality against a React-18-pinned playground (port 5175),
 * plus React-18-specific detection + prop-serialization fidelity assertions.
 *
 * The serialization-fidelity tests guard the cross-version regression where a
 * React-19-pinned `react-element-to-jsx-string` rejected React 18 elements and
 * silently degraded props to `{/* Failed to serialize *​/}` (fixed via
 * `resolve.dedupe` of react/react-dom in the plugin).
 */

type RegistrySnapshot = {
  size: number
  uniqueNames: string[]
  hasUnknownFilePath: boolean
  byName: Record<string, number>
}

async function getRegistrySnapshot(page: Parameters<typeof test>[0]['page']) {
  return page.evaluate(() => {
    const registry = (window as any).__componentHighlighterRegistry as
      | Map<string, { meta?: { componentName?: string; filePath?: string } }>
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

test.describe('React 18 playground detection coverage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForSelector('button')
    await page.waitForTimeout(1000)
  })

  test('detects the expected component set (incl. all authoring patterns) on initial render', async ({
    page,
  }) => {
    const snapshot = await getRegistrySnapshot(page)

    expect(snapshot).toBeTruthy()
    expect(snapshot?.hasUnknownFilePath).toBe(false)
    // Same shared src as playground/react (symlinked). See
    // docs/REACT_PATTERNS.md for the supported/unsupported pattern matrix.
    expect(snapshot?.uniqueNames).toEqual([
      'App',
      'Badge',
      'Button',
      'DefaultBanner',
      'Disclosure',
      'FancyField',
      'GenericList',
      'Header',
      'IconChip',
      'LegacyCounter',
      'MemoForwardInput',
      'MemoStat',
      'Modal',
      'PatternShowcase',
      'PropZoo',
      'ReactMemoCard',
      'TaskCard',
      'TaskList',
    ])
    // Supported-pattern regression guards (class + React.memo member form
    // are the newly-added transform capabilities).
    expect(snapshot?.uniqueNames).toEqual(
      expect.arrayContaining([
        'LegacyCounter',
        'ReactMemoCard',
        'MemoStat',
        'FancyField',
        'MemoForwardInput',
        'DefaultBanner',
        'IconChip',
        'GenericList',
        'Disclosure',
        'PropZoo',
      ]),
    )
    // Unsupported demonstrators must be absent.
    expect(snapshot?.uniqueNames).not.toContain('FramedNote')
    expect(snapshot?.uniqueNames).not.toContain('AnonWidget')
    expect(snapshot?.uniqueNames).not.toContain('Summary')
    expect(snapshot?.uniqueNames).not.toContain('Panel')
    expect(snapshot?.byName.TaskCard).toBeGreaterThanOrEqual(3)
    expect(snapshot?.byName.Button).toBeGreaterThanOrEqual(1)
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
    // playground/react18/src is a symlink to the canonical playground/react/src
    // (single source of truth). Vite resolves symlinks to the real path, so we
    // assert the correct real component file rather than a playground-specific
    // prefix — the guarantee that matters is "real source, not 'unknown'".
    expect(meta?.filePath).toContain('/src/components/TaskList.tsx')
    expect(meta?.filePath).not.toBe('unknown')
    expect((meta?.filePath || '').trim()).not.toBe('')
  })

  test('serializes JSX children with real source (no degraded fallback)', async ({
    page,
  }) => {
    // Force the lazy serialization gate open (same hook DevTools triggers).
    await page.evaluate(() => {
      ;(window as any).__componentHighlighterActivateTracking?.()
    })
    await page.waitForTimeout(500)

    const result = await page.evaluate(() => {
      const registry = (window as any).__componentHighlighterRegistry as
        | Map<
            string,
            {
              meta?: { componentName?: string }
              serializedProps?: Record<string, any>
            }
          >
        | undefined
      if (!registry) return null

      const entries = Array.from(registry.values())
      const taskList = entries.find(
        (e) => e.meta?.componentName === 'TaskList',
      )
      const children = taskList?.serializedProps?.children

      // Scan EVERY serialized prop across the whole registry for the
      // degraded-serialization marker.
      let degradedCount = 0
      for (const e of entries) {
        const sp = e.serializedProps || {}
        const json = JSON.stringify(sp)
        if (json && json.includes('Failed to serialize')) degradedCount++
      }

      return {
        hasTaskList: !!taskList,
        childrenIsJSX: !!children && children.__isJSX === true,
        childrenSource:
          children && typeof children.source === 'string'
            ? children.source
            : null,
        degradedCount,
      }
    })

    expect(result).toBeTruthy()
    expect(result?.hasTaskList).toBe(true)
    // No component anywhere fell back to the degraded marker on React 18.
    expect(result?.degradedCount).toBe(0)
    // TaskList children are the real JSX (3 TaskCards + a Button).
    expect(result?.childrenIsJSX).toBe(true)
    expect(result?.childrenSource).toContain('TaskCard')
    expect(result?.childrenSource).toContain('Button')
    expect(result?.childrenSource).not.toContain('Failed to serialize')
  })

  test('serializes non-plain object props (Map) as a read-only marker', async ({
    page,
  }) => {
    await page.evaluate(() => {
      ;(window as any).__componentHighlighterActivateTracking?.()
    })
    await page.waitForTimeout(500)

    const lookup = await page.evaluate(() => {
      const registry = (window as any).__componentHighlighterRegistry as
        | Map<string, { meta?: { componentName?: string }; serializedProps?: Record<string, any> }>
        | undefined
      if (!registry) return null
      const propZoo = Array.from(registry.values()).find(
        (e) => e.meta?.componentName === 'PropZoo',
      )
      return propZoo?.serializedProps?.lookup ?? null
    })

    // PropZoo receives `lookup={new Map(...)}`. A Map can't be round-tripped to
    // a story arg, so the serializer emits a marker instead of leaking the live
    // object onto the wire.
    expect(lookup).toEqual({ __isObject: true, name: 'Map' })
  })
})

registerCommonHighlighterSuite(test as any)
registerHighlightPanelStateSuite(test as any)
registerLivePropEditSuite(test as any)
registerListenersReplaySuite(test as any)

registerAgentSuite()
