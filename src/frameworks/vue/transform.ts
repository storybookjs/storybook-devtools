/**
 * Vue Transform — non-intrusive.
 *
 * Vue components are detected at runtime via the Vue DevTools global hook
 * (see src/frameworks/vue/devtools-hook.ts + runtime-module.ts), using Vue's
 * native `instance.type.__file` / `__name` for source identity. This transform
 * does not reconstruct the SFC or wrap components. It prepends a runtime
 * import and source registration to the existing `<script setup>` (or
 * `<script>`) block. The runtime accepts only registered source paths, so
 * dependency-owned DevTools components cannot pollute the app registry. Nothing else in the SFC is touched —
 * the original script body, template, styles, and custom blocks are preserved
 * byte-for-byte. All script blocks are preserved, including non-`setup`
 * `<script>` blocks.
 *
 * Returning the (minimally) edited source (rather than `undefined`) also keeps
 * the plugin's coverage tracking working, which keys off a truthy transform
 * result.
 */

import { parse as parseVue } from '@vue/compiler-sfc'
import type { TransformFunction } from '../types'

/**
 * Virtual module ID for Vue runtime
 */
export const VIRTUAL_MODULE_ID = 'virtual:component-highlighter/vue-runtime'

/**
 * The named import that loads the Vue runtime and registers accepted sources. Idempotent: we skip
 * the edit if it is already present (avoids double-insertion on re-transform).
 */
const RUNTIME_IMPORT = `import { registerComponentSource as __chRegisterSource } from '${VIRTUAL_MODULE_ID}';`

/**
 * Transform Vue SFC files: prepend a runtime import and source registration
 * to the script block. No SFC reconstruction.
 */
export const transform: TransformFunction = (
  code: string,
  id: string,
  options = {},
): string | undefined => {
  try {
    // Already instrumented (e.g. re-transform / HMR) — leave as-is.
    if (code.includes(VIRTUAL_MODULE_ID)) {
      return undefined
    }

    const { descriptor } = parseVue(code, { filename: id })

    // Only instrument components that have a script block. The block's
    // `loc.start.offset` points at the first character of the block's *inner*
    // content (immediately after the opening tag), so inserting there leaves
    // the tag, its attributes, the template, styles, and any other blocks
    // untouched. Prefer `<script setup>`; fall back to a plain `<script>`.
    const scriptBlock = descriptor.scriptSetup ?? descriptor.script
    if (!scriptBlock) {
      return undefined
    }

    const insertAt = scriptBlock.loc.start.offset
    const sourceRegistration = `${RUNTIME_IMPORT}__chRegisterSource(${JSON.stringify(id.replace(/\\/g, '/'))});`
    const transformed =
      code.slice(0, insertAt) + sourceRegistration + code.slice(insertAt)

    return transformed
  } catch (error) {
    const detail = (error as { message?: string })?.message || String(error)
    // Prefer a structured diagnostic (the plugin routes it to ctx.diagnostics);
    // fall back to console when the transform runs standalone (e.g. tests).
    if (options.onIssue) {
      options.onIssue({ code: 'transform-failed', file: id, detail })
    } else {
      console.warn(`[component-highlighter] Failed to transform ${id}:`, error)
    }
    return undefined
  }
}

/**
 * Detect if a file is a Vue file
 */
export function detectVue(code: string, id: string): boolean {
  // Check file extension
  if (!id.endsWith('.vue')) {
    return false
  }

  // Must have template or script
  return code.includes('<template') || code.includes('<script')
}
