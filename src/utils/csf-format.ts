/**
 * Which story format a Storybook project writes: CSF3 object exports, or CSF
 * factories (`preview.meta(...)` / `meta.story(...)`).
 *
 * A project is on factories when its `.storybook/preview` imports
 * `definePreview` from a storybook package — the same test Storybook's own
 * "create new story file" flow applies (`isCsfFactoryPreview`), including
 * falling back to CSF3 whenever the preview cannot be read or parsed. The
 * preview import a factory story file needs follows that flow too: the
 * `#.storybook/preview` subpath import when a `package.json` between the
 * config directory and the project root declares `imports`, otherwise a
 * relative path without extension.
 *
 * Only the format of a *new* story file is decided here. Appending to an
 * existing file follows that file's own format (`src/utils/csf-writer.ts`).
 *
 * `storybook/internal/*` is loaded lazily with `webpackIgnore`, never at
 * module top level — see `src/storybook-project.ts`.
 */
import * as fs from 'fs'
import * as path from 'path'
import { resolveProjectRootSync } from '../storybook-project'

export type StoryFormat =
  | { kind: 'csf3' }
  | {
      kind: 'factory'
      /** Module specifier of the preview, as written in `import preview from '…'`. */
      previewImport: string
    }

/**
 * Storybook renderers this tool generates factory stories for. Other
 * renderers (or a project whose renderer is unknown) keep CSF3.
 */
const FACTORY_RENDERERS = new Set(['react', 'vue3'])

/**
 * Absolute path of the project's preview file when it is a CSF factory
 * preview, otherwise `undefined`. Never throws: a missing config directory,
 * a missing preview file, or a preview that fails to parse all mean CSF3.
 */
export async function findFactoryPreview(
  configDir: string,
): Promise<string | undefined> {
  try {
    const [{ findConfigFile }, { loadConfig, isCsfFactoryPreview }] =
      await Promise.all([
        import(/* webpackIgnore: true */ 'storybook/internal/common'),
        import(/* webpackIgnore: true */ 'storybook/internal/csf-tools'),
      ])
    const previewPath = findConfigFile('preview', configDir)
    if (!previewPath) return undefined
    const content = await fs.promises.readFile(previewPath, 'utf-8')
    return isCsfFactoryPreview(loadConfig(content)) ? previewPath : undefined
  } catch {
    return undefined
  }
}

/** Whether a `package.json` from `configDir` up to the project root declares `imports`. */
function hasSubpathImports(configDir: string): boolean {
  const root = resolveProjectRootSync()
  let dir = path.resolve(configDir)
  for (;;) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'),
      ) as { imports?: unknown }
      if (manifest.imports) return true
    } catch {
      // No readable package.json in this directory; keep walking up.
    }
    const parent = path.dirname(dir)
    if (dir === root || parent === dir) return false
    dir = parent
  }
}

function toPreviewImport(
  previewPath: string,
  configDir: string,
  storyFilePath: string,
): string {
  if (hasSubpathImports(configDir)) return '#.storybook/preview'
  const relative = path
    .relative(path.dirname(storyFilePath), previewPath)
    .replace(/\.(ts|js|mts|cts|tsx|jsx)$/, '')
    .split(path.sep)
    .join('/')
  // `.storybook/preview` also starts with a dot but is a bare specifier.
  return relative.startsWith('./') || relative.startsWith('../')
    ? relative
    : `./${relative}`
}

/**
 * The format for a new story file at `storyFilePath` in the project whose
 * Storybook config lives in `configDir` (omitted when the project has no
 * Storybook config).
 */
export async function resolveStoryFormat(options: {
  configDir?: string | undefined
  renderer?: string | undefined
  storyFilePath: string
}): Promise<StoryFormat> {
  const { configDir, renderer, storyFilePath } = options
  if (!configDir) return { kind: 'csf3' }
  if (renderer && !FACTORY_RENDERERS.has(renderer)) return { kind: 'csf3' }
  const previewPath = await findFactoryPreview(configDir)
  if (!previewPath) return { kind: 'csf3' }
  return {
    kind: 'factory',
    previewImport: toPreviewImport(previewPath, configDir, storyFilePath),
  }
}
