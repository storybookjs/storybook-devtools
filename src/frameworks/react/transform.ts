/**
 * React Transform
 *
 * Non-intrusive instrumentation. Instead of wrapping components in an HOC
 * (which pollutes the fiber/DOM tree and forces every component into a client
 * boundary — breaking RSC), this only appends a single idempotent metadata
 * tag per exported component:
 *
 *   __chRegisterMeta(Button, { componentName, filePath, ... })
 *
 * The tag attaches a non-enumerable symbol to the component function. The
 * runtime reads it off the live fiber tree via the React DevTools global hook.
 * The rendered tree is left completely untouched.
 *
 * Reading the module takes a parser, and Storybook's changed: Storybook 10
 * parses with Babel, Storybook 11 with OXC into ESTree nodes, through
 * `parseModule` in its csf-tools. `transform-babel.ts` and
 * `transform-estree.ts` read the same facts from either AST; everything
 * else here works on those facts and on the source text.
 */

import * as path from 'path'
import type { TransformFunction, TransformOptions } from '../types'
import { loadStorybookInternal } from '../../storybook-peer'
import { babelModuleReader } from './transform-babel'
import { estreeModuleReader } from './transform-estree'

/** What the transform needs to know about a module. */
export interface ModuleFacts {
  /** The module's directive prologue holds `"use client"`. */
  useClient: boolean
  /** The module contains JSX. */
  hasJsx: boolean
  /** Top-level component declarations, by name. */
  components: Set<string>
  /** Every name the module exports, the default export's binding included. */
  exportedNames: Set<string>
  /** The binding the module exports as default, if it is a named one. */
  defaultExportName: string | null
  /** `file:line:column` of an anonymous default-exported function. */
  anonymousDefaultLoc: string | null
  /**
   * PascalCase bindings assigned from a call that is not memo/forwardRef,
   * likely an HOC the transform can't tag, with their `file:line:column`.
   */
  unsupportedHoc: Map<string, string>
}

/** Parses a module with one Storybook's parser and reads its facts. */
export interface ModuleReader {
  read(code: string, id: string): ModuleFacts
}

let reader: ModuleReader | undefined

/**
 * The reader for the installed Storybook: ESTree when its csf-tools have
 * `parseModule`, Babel otherwise. Both readers are imported statically,
 * since the bundler transform hooks are synchronous, and load nothing
 * from `storybook` until they are called, so either imports safely on
 * the other Storybook.
 */
function moduleReader(): ModuleReader {
  return (reader ??=
    typeof loadStorybookInternal<{ parseModule?: unknown }>('csf-tools').parseModule ===
    'function'
      ? estreeModuleReader
      : babelModuleReader)
}

function createHash(data: string): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

/** Virtual module ID for React runtime */
export const VIRTUAL_MODULE_ID = 'virtual:component-highlighter/runtime'

const TAG_FN = '__chRegisterMeta'

/**
 * Transform React JSX/TSX files: collect exported component bindings and
 * append metadata tags. The component declarations themselves are never
 * modified.
 */
export const transform: TransformFunction = (
  code: string,
  id: string,
  options: TransformOptions = {},
): string | undefined => {
  try {
    const facts = moduleReader().read(code, id)

    // RSC gate: in `rsc` mode, only client components (modules with a
    // `"use client"` directive) are instrumented. Server components never
    // mount a client fiber, so tagging them is useless and would pull the
    // client runtime into the server module graph. In a plain SPA (rsc off)
    // there is no directive but every component is a client component, so we
    // tag everything — hence this gate is opt-in.
    if (options.rsc && !facts.useClient) {
      return undefined
    }

    const { hasJsx, exportedNames, defaultExportName } = facts

    // name -> isDefaultExport
    const componentBindings = new Map<string, boolean>()
    for (const name of facts.components) {
      if (exportedNames.has(name)) {
        componentBindings.set(name, name === defaultExportName)
      }
    }

    // Surface non-fatal detection gaps as diagnostics — only for files that
    // actually render JSX (component modules), so unrelated PascalCase factory
    // exports in non-component files aren't flagged.
    if (hasJsx && options.onIssue) {
      if (facts.anonymousDefaultLoc) {
        options.onIssue({
          code: 'unsupported-pattern',
          file: id,
          name: 'default',
          loc: facts.anonymousDefaultLoc,
          detail:
            'Anonymous default export can’t be detected for story generation. Give it a name, e.g. `function Foo() {}; export default Foo`.',
        })
      }
      for (const [name, loc] of facts.unsupportedHoc) {
        if (exportedNames.has(name) && !componentBindings.has(name)) {
          options.onIssue({
            code: 'unsupported-pattern',
            file: id,
            name,
            loc,
            detail: `“${name}” is assigned from a call this plugin can’t statically resolve (e.g. a custom HOC), so it can’t be tagged for story generation. Export the inner component and use it directly, or wrap it with memo()/forwardRef().`,
          })
        }
      }
    }

    if (!hasJsx || componentBindings.size === 0) {
      return undefined
    }

    const relativeFilePath = path.relative(process.cwd(), id)

    // Append the import and the tag statements after the module body: the
    // import is hoisted, the tags run once const bindings are initialized,
    // and the module's own code keeps its text and line numbers.
    //   import { __chRegisterMeta } from 'virtual:...'
    //   __chRegisterMeta(Button, { componentName: "Button", ... })
    const appended = [
      `import { ${TAG_FN} } from ${JSON.stringify(VIRTUAL_MODULE_ID)};`,
    ]
    for (const [name, isDefaultExport] of componentBindings) {
      const sourceId = createHash(id + ':' + name)
      const meta = [
        `componentName: ${JSON.stringify(name)}`,
        `filePath: ${JSON.stringify(id)}`,
        `relativeFilePath: ${JSON.stringify(relativeFilePath)}`,
        `sourceId: ${JSON.stringify(sourceId)}`,
        `isDefaultExport: ${isDefaultExport}`,
      ]
      appended.push(`${TAG_FN}(${name}, {\n  ${meta.join(',\n  ')},\n});`)
    }

    return `${code}${code.endsWith('\n') ? '' : '\n'}${appended.join('\n')}\n`
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

/** Detect if a file is a React file */
export function detectReact(code: string, id: string): boolean {
  if (!id.match(/\.(tsx|jsx)$/)) {
    return false
  }
  const hasReactImport =
    /import\s+(?:React|\{[^}]*\})\s+from\s+['"]react['"]/.test(code)
  const hasJSX = /<[A-Z][a-zA-Z]*|<[a-z]+[^>]*>/.test(code)
  return hasReactImport || hasJSX
}
