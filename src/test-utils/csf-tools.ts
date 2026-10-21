import { describe } from 'vitest'

/**
 * The csf-tools generation of the installed Storybook, picked the way the
 * plugin picks it: ESTree when csf-tools have `parseModule`
 * (storybookjs/storybook#36613), Babel otherwise (Storybook 10, and 11
 * prereleases without #36613).
 */
const csfTools = (await import('storybook/internal/csf-tools')) as {
  parseModule?: (code: string, fileName?: string) => unknown
  babelParse?: (code: string) => unknown
}

// `in` rather than a property read: a `vi.mock` of csf-tools throws on
// reading an export it does not define.
export const csfToolsGeneration: 'babel' | 'estree' =
  'parseModule' in csfTools && typeof csfTools.parseModule === 'function'
    ? 'estree'
    : 'babel'

/** Throws when `code` is not a module the installed Storybook can parse. */
export function parseWithStorybook(code: string, fileName: string): void {
  if (csfToolsGeneration === 'estree') csfTools.parseModule!(code, fileName)
  else csfTools.babelParse!(code)
}

const needs = {
  babel: 'the Babel csf-tools: Storybook 10, or 11 without #36613',
  estree: 'the ESTree csf-tools of storybookjs/storybook#36613',
}

/**
 * `describe` for tests of one generation's output; skipped, with the reason
 * in its name, on the other.
 */
export function describeFor(
  generation: 'babel' | 'estree',
  name: string,
  fn: () => void,
): void {
  if (generation === csfToolsGeneration) describe(name, fn)
  else describe.skip(`${name} (needs ${needs[generation]})`, fn)
}

/**
 * The one difference between the two story writers' output: recast, on the
 * Babel path, puts a blank line before an import it adds below the others.
 * Returns `code` without that blank line, and whether it was there, so a
 * test can keep one snapshot for both paths and check the blank line
 * against the installed path.
 */
export function withoutAddedImportGap(code: string): { code: string; gap: boolean } {
  const gap = /^(import .*\n)\n(?=import )/m
  return { code: code.replace(gap, '$1'), gap: gap.test(code) }
}
