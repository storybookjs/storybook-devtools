import { describe, expect, it } from 'vitest'
import { normalizeRuntimeImports } from './normalize-runtime-imports'

const HELPER_ID = 'virtual:component-highlighter/runtime-helpers'

describe('normalizeRuntimeImports', () => {
  it('removes the public base from source-file imports before import-analysis runs again', () => {
    const code = 'import { serialize } from "/_nuxt/@fs/project/src/vnode-to-template.ts?t=123";'
    expect(normalizeRuntimeImports(code, '/_nuxt/')).toBe(
      'import { serialize } from "/@fs/project/src/vnode-to-template.ts?t=123";',
    )
    expect(normalizeRuntimeImports(code, '/other/')).toBe(code)
  })

  it('restores the bare virtual id with default base "/"', () => {
    const code = `import { a } from "/@id/__x00__${HELPER_ID}";`
    expect(normalizeRuntimeImports(code, '/')).toBe(
      `import { a } from "${HELPER_ID}";`,
    )
  })

  it('restores the bare virtual id under a non-root base (Nuxt "/_nuxt/")', () => {
    const code = `import { a } from "/_nuxt/@id/__x00__${HELPER_ID}";`
    expect(normalizeRuntimeImports(code, '/_nuxt/')).toBe(
      `import { a } from "${HELPER_ID}";`,
    )
  })

  it('strips HMR timestamp queries', () => {
    const code = `import { a } from "/_nuxt/@id/__x00__${HELPER_ID}?t=1712345678";`
    expect(normalizeRuntimeImports(code, '/_nuxt/')).toBe(
      `import { a } from "${HELPER_ID}";`,
    )
  })

  it('leaves already-bare ids untouched', () => {
    const code = `import { a } from "${HELPER_ID}";`
    expect(normalizeRuntimeImports(code, '/_nuxt/')).toBe(code)
  })

  it('replaces every occurrence', () => {
    const code = [
      `import { a } from "/@id/__x00__${HELPER_ID}";`,
      `import { b } from "/@id/__x00__${HELPER_ID}?t=123";`,
    ].join('\n')
    expect(normalizeRuntimeImports(code, '/')).toBe(
      [
        `import { a } from "${HELPER_ID}";`,
        `import { b } from "${HELPER_ID}";`,
      ].join('\n'),
    )
  })
})
