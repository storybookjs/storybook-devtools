import { describe, it, expect } from 'vitest'
import { transform, detectVue, VIRTUAL_MODULE_ID } from './transform'

// The Vue transform is non-intrusive: it does NOT reconstruct the SFC or inject
// wrappers. A source allowlist keeps dependency components out; detection uses the
// Vue DevTools global hook (devtools-hook.ts + runtime-module.ts). The transform
// performs exactly one minimal, idempotent edit — prepending a single
// runtime import and source registration to the SFC's script block so
// the runtime is loaded into the page. Everything else is preserved verbatim.

const RUNTIME_IMPORT = `import { registerComponentSource as __chRegisterSource } from '${VIRTUAL_MODULE_ID}';`

describe('Vue transform (non-intrusive)', () => {
  describe('runtime import injection', () => {
    it('registers the source and imports the runtime into <script setup>', () => {
      const code = `<script setup lang="ts">
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <div>{{ count }}</div>
</template>
`
      const result = transform(code, '/src/components/Counter.vue')

      expect(result).toBeDefined()
      expect(result).toContain(RUNTIME_IMPORT)
      expect(result).toContain('__chRegisterSource("/src/components/Counter.vue");')
      // No component metadata object or wrapping composable.
      expect(result).not.toContain('withComponentHighlighter')
      expect(result).not.toContain('__componentMeta')
    })

    it('injects into a plain <script> block (Options API)', () => {
      const code = `<script>
export default {
  name: 'MyComponent',
  data() {
    return { msg: 'hello' }
  }
}
</script>

<template>
  <div>{{ msg }}</div>
</template>
`
      const result = transform(code, '/src/components/MyComponent.vue')

      expect(result).toBeDefined()
      expect(result).toContain(RUNTIME_IMPORT)
      // The Options-API script body is preserved (previously it was dropped by
      // the SFC reconstruction).
      expect(result).toContain("name: 'MyComponent'")
      expect(result).toContain("return { msg: 'hello' }")
    })

    it('does not transform a file without a script block', () => {
      const code = `<template>
  <div>static content</div>
</template>
`
      const result = transform(code, '/src/components/Static.vue')

      expect(result).toBeUndefined()
    })

    it('is idempotent — does not inject twice on re-transform', () => {
      const code = `<script setup lang="ts">
const x = 1
</script>

<template>
  <div>{{ x }}</div>
</template>
`
      const first = transform(code, '/src/components/Once.vue')
      expect(first).toBeDefined()
      expect(first!.split(VIRTUAL_MODULE_ID).length - 1).toBe(1)

      // Feeding the already-transformed output back in is a no-op.
      const second = transform(first!, '/src/components/Once.vue')
      expect(second).toBeUndefined()
    })
  })

  describe('SFC preservation (no reconstruction)', () => {
    it('preserves existing <script setup> content verbatim', () => {
      const code = `<script setup lang="ts">
import { ref, computed } from 'vue'
import MyChild from './MyChild.vue'

const count = ref(0)
const doubled = computed(() => count.value * 2)
</script>

<template>
  <div>{{ doubled }}</div>
</template>
`
      const result = transform(code, '/src/components/Parent.vue')

      expect(result).toBeDefined()
      expect(result).toContain("import { ref, computed } from 'vue'")
      expect(result).toContain("import MyChild from './MyChild.vue'")
      expect(result).toContain('const count = ref(0)')
      expect(result).toContain('const doubled = computed')
      // The opening tag (including lang) is untouched.
      expect(result).toContain('<script setup lang="ts">')
    })

    it('preserves a dual <script> + <script setup> SFC (both blocks kept)', () => {
      const code = `<script lang="ts">
export const SHARED = 'shared-const'
export default { name: 'DualScript' }
</script>

<script setup lang="ts">
import { ref } from 'vue'
const n = ref(1)
</script>

<template>
  <div>{{ n }}</div>
</template>
`
      const result = transform(code, '/src/components/DualScript.vue')

      expect(result).toBeDefined()
      expect(result).toContain(RUNTIME_IMPORT)
      // The non-setup <script> block is NOT dropped (the old reconstruction
      // silently lost it).
      expect(result).toContain("export const SHARED = 'shared-const'")
      expect(result).toContain("export default { name: 'DualScript' }")
      // The setup block survives too.
      expect(result).toContain('const n = ref(1)')
    })

    it('does not modify lang or add a TS lang attr to a JS <script setup>', () => {
      const code = `<script setup>
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <div>{{ count }}</div>
</template>
`
      const result = transform(code, '/src/components/JsComp.vue')

      expect(result).toBeDefined()
      expect(result).toContain('<script setup>')
      // The old transform forced lang="ts"; we must not.
      expect(result).not.toContain('lang="ts"')
    })

    it('preserves template content', () => {
      const code = `<script setup lang="ts">
const msg = 'hello'
</script>

<template>
  <div class="container">
    <h1>{{ msg }}</h1>
    <slot />
  </div>
</template>
`
      const result = transform(code, '/src/components/Layout.vue')

      expect(result).toBeDefined()
      expect(result).toContain('<div class="container">')
      expect(result).toContain('<h1>{{ msg }}</h1>')
      expect(result).toContain('<slot />')
    })

    it('preserves scoped styles, lang, and multiple style blocks', () => {
      const code = `<script setup lang="ts">
const x = 1
</script>

<template>
  <div class="box">styled</div>
</template>

<style lang="scss" scoped>
.box { color: blue; }
</style>

<style>
.global { color: red; }
</style>
`
      const result = transform(code, '/src/components/Styled.vue')

      expect(result).toBeDefined()
      // Style blocks are passed through untouched (offsets/attrs preserved),
      // unlike the old reconstruction which re-serialized them.
      expect(result).toContain('<style lang="scss" scoped>')
      expect(result).toContain('.box { color: blue; }')
      expect(result).toContain('.global { color: red; }')
    })

    it('only adds source registration — the rest of the file is byte-identical', () => {
      const code = `<script setup lang="ts">
const x = 1
</script>

<template>
  <div>{{ x }}</div>
</template>
`
      const result = transform(code, '/src/components/Exact.vue')
      expect(result).toBeDefined()
      // Removing the injected import and registration restores the source
      // exactly (proves no other byte was touched).
      expect(result!.replace(RUNTIME_IMPORT + '__chRegisterSource("/src/components/Exact.vue");', '')).toBe(code)
    })
  })

  describe('error handling', () => {
    it('returns undefined for non-SFC content (no script block)', () => {
      const code = 'this is not a valid vue file'
      const result = transform(code, '/src/components/Invalid.vue')
      expect(result).toBeUndefined()
    })
  })
})

describe('detectVue', () => {
  it('detects .vue files with template', () => {
    expect(
      detectVue('<template><div>test</div></template>', '/src/App.vue'),
    ).toBe(true)
  })

  it('detects .vue files with script', () => {
    expect(detectVue('<script>export default {}</script>', '/src/App.vue')).toBe(
      true,
    )
  })

  it('does not detect non-.vue files', () => {
    expect(
      detectVue('<template><div>test</div></template>', '/src/App.tsx'),
    ).toBe(false)
  })

  it('does not detect .vue files without template or script', () => {
    expect(detectVue('/* just a comment */', '/src/App.vue')).toBe(false)
  })
})
