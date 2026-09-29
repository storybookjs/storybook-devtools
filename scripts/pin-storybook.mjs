#!/usr/bin/env node
/**
 * Re-pins every exact `storybook` / `@storybook/*` version the workspace
 * uses (root devDependency and all playgrounds) to another Storybook version,
 * so the same test suites can run against another major. It does not touch
 * the lockfile: follow it with `pnpm install --no-frozen-lockfile`.
 *
 * Usage: node scripts/pin-storybook.mjs <version>
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2]
if (!target || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) {
  console.error('Usage: node scripts/pin-storybook.mjs <exact storybook version>')
  process.exit(1)
}

const root = new URL('..', import.meta.url).pathname
const manifests = [
  join(root, 'package.json'),
  ...readdirSync(join(root, 'playground'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'playground', entry.name, 'package.json'))
    .filter((file) => {
      try {
        readFileSync(file)
        return true
      } catch {
        return false
      }
    }),
]

const current = JSON.parse(readFileSync(manifests[0], 'utf8')).devDependencies.storybook
const isStorybookPackage = (name) => name === 'storybook' || name.startsWith('@storybook/')

for (const file of manifests) {
  const source = readFileSync(file, 'utf8')
  const manifest = JSON.parse(source)
  let changed = false
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (isStorybookPackage(name) && version === current) {
        manifest[field][name] = target
        changed = true
      }
    }
  }
  if (changed) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
console.log(`Pinned Storybook ${current} -> ${target}`)
