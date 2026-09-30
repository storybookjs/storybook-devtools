import { readdir, readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { babelParse } from 'storybook/internal/babel'

it('installs the MCP implementation required by the devframe adapter', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const devframe = JSON.parse(await readFile('node_modules/devframe/package.json', 'utf8'))
  // devframe/adapters/mcp re-exports this optional peer. A consumer using
  // Next or Rsbuild must not depend on Vite's workspace hoisting to load it.
  expect(pkg.dependencies['@devframes/agentic']).toBe(devframe.peerDependencies['@devframes/agentic'])
})

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
        const ast = babelParse(await readFile(file, 'utf8'))
        for (const statement of ast.program.body) {
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
})
