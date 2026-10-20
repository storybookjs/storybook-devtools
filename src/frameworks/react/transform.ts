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
 */

import * as path from 'path'
import type { ESTree as T } from 'storybook/internal/csf-tools'
import type { TransformFunction, TransformOptions } from '../types'
import { loadStorybookInternal } from '../../storybook-peer'

type CsfTools = typeof import('storybook/internal/csf-tools')

// Storybook's csf-tools, loaded on first use through the guarded peer loader
// rather than a static import, so a missing or too-old `storybook` fails with
// the peer requirement instead of a bare module resolution error at host
// config load.
let csfTools: CsfTools | undefined
function tools(): CsfTools {
  return (csfTools ??= loadStorybookInternal<CsfTools>('csf-tools'))
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
 * Detect a module-level `"use client"` directive (the RSC client-boundary
 * marker). The parser marks the statements of the leading directive prologue
 * with their `directive` text, so we read it from there rather than scanning
 * text — this naturally handles either quote style and ignores `"use client"`
 * strings that appear deeper in the module.
 */
function hasUseClientDirective(program: T.Program): boolean {
  for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || statement.directive == null) {
      return false
    }
    if (statement.directive === 'use client') return true
  }
  return false
}

/** `file:line:column` of an offset into `code`, both 1-based. */
function locationIn(id: string, code: string, offset: number): string {
  const before = code.slice(0, offset)
  const line = before.split('\n').length
  const column = offset - (before.lastIndexOf('\n') + 1) + 1
  return `${id}:${line}:${column}`
}

function isComponentName(name: string | undefined | null): boolean {
  const first = name?.[0]
  return !!first && first === first.toUpperCase() && first !== first.toLowerCase()
}

function isMemoOrForwardRef(node: T.Expression | null | undefined): boolean {
  if (!node || node.type !== 'CallExpression') return false
  const callee = node.callee
  // Bare form: memo(...) / forwardRef(...)
  if (
    callee.type === 'Identifier' &&
    (callee.name === 'memo' || callee.name === 'forwardRef')
  ) {
    return true
  }
  // Member form: React.memo(...) / React.forwardRef(...)
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    (callee.property.name === 'memo' || callee.property.name === 'forwardRef')
  ) {
    return true
  }
  return false
}

function isComponentInit(node: T.Expression | null | undefined): boolean {
  if (!node) return false
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    isMemoOrForwardRef(node)
  )
}

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
    // Offsets index `parsedCode`, which has its line endings normalized.
    const { program, code: parsedCode } = tools().parseModule(code, id)

    // RSC gate: in `rsc` mode, only client components (modules with a
    // `"use client"` directive) are instrumented. Server components never
    // mount a client fiber, so tagging them is useless and would pull the
    // client runtime into the server module graph. In a plain SPA (rsc off)
    // there is no directive but every component is a client component, so we
    // tag everything — hence this gate is opt-in.
    if (options.rsc && !hasUseClientDirective(program)) {
      return undefined
    }

    let hasJsx = false
    tools().walk(program, (node) => {
      if (node.type === 'JSXElement' || node.type === 'JSXFragment') hasJsx = true
      return !hasJsx
    })

    // Top-level component declarations by name, the set of names that are
    // exported (inline, via specifier, or as default), and the default name.
    const topLevelComponents = new Set<string>()
    const exportedNames = new Set<string>()
    let defaultExportName: string | null = null

    // Non-fatal detection gaps to surface as diagnostics.
    let anonDefaultLoc: string | null = null
    const unsupportedHoc = new Map<string, string>() // name -> file:line:col
    const nodeLoc = (node: T.Node): string => locationIn(id, parsedCode, node.start)

    const considerDeclaration = (decl: T.Function | T.Class) => {
      const name = decl.id?.name
      if (name && isComponentName(name)) topLevelComponents.add(name)
    }
    const considerVariable = (varDecl: T.VariableDeclaration) => {
      for (const d of varDecl.declarations) {
        if (d.id.type !== 'Identifier' || !isComponentName(d.id.name)) continue
        if (isComponentInit(d.init)) {
          topLevelComponents.add(d.id.name)
        } else if (
          d.init &&
          d.init.type === 'CallExpression' &&
          !isMemoOrForwardRef(d.init)
        ) {
          // PascalCase `X = someCall(...)` that isn't memo/forwardRef — likely
          // an unrecognized HOC wrapper we can't statically tag.
          unsupportedHoc.set(d.id.name, nodeLoc(d.init))
        }
      }
    }

    for (const stmt of program.body) {
      if (stmt.type === 'FunctionDeclaration' || stmt.type === 'ClassDeclaration') {
        considerDeclaration(stmt)
      } else if (stmt.type === 'VariableDeclaration') {
        considerVariable(stmt)
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (
          stmt.declaration?.type === 'FunctionDeclaration' ||
          stmt.declaration?.type === 'ClassDeclaration'
        ) {
          considerDeclaration(stmt.declaration)
          if (stmt.declaration.id) exportedNames.add(stmt.declaration.id.name)
        } else if (stmt.declaration?.type === 'VariableDeclaration') {
          considerVariable(stmt.declaration)
          for (const d of stmt.declaration.declarations) {
            if (d.id.type === 'Identifier') exportedNames.add(d.id.name)
          }
        }
        for (const spec of stmt.specifiers) {
          if (spec.local.type === 'Identifier') exportedNames.add(spec.local.name)
        }
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        const decl = stmt.declaration
        if (
          (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') &&
          decl.id
        ) {
          considerDeclaration(decl)
          defaultExportName = decl.id.name
        } else if (decl.type === 'Identifier') {
          defaultExportName = decl.name
        } else if (
          decl.type === 'ArrowFunctionExpression' ||
          decl.type === 'FunctionExpression'
        ) {
          // `export default () => …` / `export default function () {}` —
          // anonymous, no stable binding to tag.
          anonDefaultLoc = nodeLoc(decl)
        }
      }
    }

    if (defaultExportName) exportedNames.add(defaultExportName)

    // name -> isDefaultExport
    const componentBindings = new Map<string, boolean>()
    for (const name of topLevelComponents) {
      if (exportedNames.has(name)) {
        componentBindings.set(name, name === defaultExportName)
      }
    }

    // Surface non-fatal detection gaps as diagnostics — only for files that
    // actually render JSX (component modules), so unrelated PascalCase factory
    // exports in non-component files aren't flagged.
    if (hasJsx && options.onIssue) {
      if (anonDefaultLoc) {
        options.onIssue({
          code: 'unsupported-pattern',
          file: id,
          name: 'default',
          loc: anonDefaultLoc,
          detail:
            'Anonymous default export can’t be detected for story generation. Give it a name, e.g. `function Foo() {}; export default Foo`.',
        })
      }
      for (const [name, loc] of unsupportedHoc) {
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
