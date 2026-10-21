import { readdir, readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'

interface Program {
  body: Array<{ source?: { value?: string } | null }>
}

// Storybook 11 parses with `parseModule` from csf-tools. Storybook 10 has
// no `parseModule`; its Babel parser comes from `storybook/internal/babel`,
// which Storybook 11 removes, so it is imported only then, through a
// variable Vite does not try to resolve up front.
const csfTools: { parseModule?: (code: string, fileName: string) => { program: Program } } =
  await import('storybook/internal/csf-tools')
const babelEntry = 'storybook/internal/babel'
const parse = csfTools.parseModule ??
  ((await import(/* @vite-ignore */ babelEntry)).babelParse as (code: string) => { program: Program })

// Parsing all of `dist` takes Babel a few seconds, more under a parallel run.
it('declares the external runtime imports shipped in dist', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }))
  const missing = new Set<string>()
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) {
        await scan(file)
      } else if (file.endsWith('.mjs')) {
        const { program } = parse(await readFile(file, 'utf8'), file)
        for (const statement of program.body) {
          if (!('source' in statement)) continue
          const source = statement.source?.value
          if (!source || source.startsWith('.') || source.startsWith('virtual:') || isBuiltin(source)) continue
          const name = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]!
          if (!declared.has(name)) missing.add(name)
        }
      }
    }
  }
  await scan('dist')
  expect([...missing].sort()).toEqual([])
}, 30_000)
