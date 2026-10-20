import { describe } from 'vitest'

/**
 * The csf-tools generation of the installed Storybook, picked the way the
 * plugin picks it: ESTree when csf-tools have `parseModule` (Storybook 11),
 * Babel otherwise (Storybook 10).
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
  babel: 'the Babel csf-tools of Storybook 10',
  estree: 'the ESTree csf-tools of Storybook 11',
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
