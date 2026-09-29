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

// @ts-nocheck
import * as path from 'path'
import type { types as T } from 'storybook/internal/babel'
import type { TransformFunction, TransformOptions } from '../types'
import { loadStorybookInternal } from '../../storybook-peer'

type BabelModule = typeof import('storybook/internal/babel')

// Storybook's Babel re-exports, loaded on first use through the guarded
// peer loader rather than a static import, so a missing or too-old
// `storybook` fails with the peer requirement instead of a bare module
// resolution error at host config load.
let babelModule: BabelModule | undefined
function babel(): BabelModule {
  return (babelModule ??= loadStorybookInternal<BabelModule>('babel'))
}
const t = new Proxy({} as BabelModule['types'], {
  get: (_target, key) =>
    (babel().types as unknown as Record<PropertyKey, unknown>)[key],
})
const traverse: BabelModule['traverse'] = ((...args) =>
  babel().traverse(...args)) as BabelModule['traverse']
const generate: BabelModule['generate'] = ((...args) =>
  babel().generate(...args)) as BabelModule['generate']

const parse: BabelModule['parser']['parse'] = (...args) =>
  babel().parser.parse(...args)

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
 * marker). Babel collects leading directive prologues into
 * `program.directives`, so we read it from there rather than scanning text —
 * this naturally handles either quote style and ignores `"use client"`
 * strings that appear deeper in the module.
 */
function hasUseClientDirective(ast: T.File): boolean {
  return (ast.program.directives ?? []).some(
    (d) => d.value?.value === 'use client',
  )
}

function isComponentName(name: string | undefined | null): boolean {
  return (
    !!name &&
    name[0] === name[0].toUpperCase() &&
    name[0] !== name[0].toLowerCase()
  )
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
    const ast = parse(code, {
      sourceType: 'module',
      plugins: [
        'typescript',
        'jsx',
        ['decorators', { decoratorsBeforeExport: true }],
      ],
      sourceFilename: id,
    })

    // RSC gate: in `rsc` mode, only client components (modules with a
    // `"use client"` directive) are instrumented. Server components never
    // mount a client fiber, so tagging them is useless and would pull the
    // client runtime into the server module graph. In a plain SPA (rsc off)
    // there is no directive but every component is a client component, so we
    // tag everything — hence this gate is opt-in.
    if (options.rsc && !hasUseClientDirective(ast)) {
      return undefined
    }

    let hasJsx = false
    traverse(ast, {
      JSXElement() {
        hasJsx = true
      },
      JSXFragment() {
        hasJsx = true
      },
    })

    // Top-level component declarations by name, the set of names that are
    // exported (inline, via specifier, or as default), and the default name.
    const topLevelComponents = new Set<string>()
    const exportedNames = new Set<string>()
    let defaultExportName: string | null = null

    // Non-fatal detection gaps to surface as diagnostics.
    let anonDefaultLoc: string | null = null
    const unsupportedHoc = new Map<string, string>() // name -> file:line:col
    const nodeLoc = (node: T.Node | null | undefined): string =>
      node?.loc
        ? `${id}:${node.loc.start.line}:${node.loc.start.column + 1}`
        : id

    const considerFunction = (decl: T.FunctionDeclaration) => {
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
    const considerClass = (decl: T.ClassDeclaration) => {
      const name = decl.id?.name
      if (name && isComponentName(name)) topLevelComponents.add(name)
    }

    for (const stmt of ast.program.body) {
      if (stmt.type === 'FunctionDeclaration') {
        considerFunction(stmt)
      } else if (stmt.type === 'VariableDeclaration') {
        considerVariable(stmt)
      } else if (stmt.type === 'ClassDeclaration') {
        considerClass(stmt)
      } else if (stmt.type === 'ExportNamedDeclaration') {
        if (stmt.declaration?.type === 'FunctionDeclaration') {
          considerFunction(stmt.declaration)
          if (stmt.declaration.id) exportedNames.add(stmt.declaration.id.name)
        } else if (stmt.declaration?.type === 'ClassDeclaration') {
          considerClass(stmt.declaration)
          if (stmt.declaration.id) exportedNames.add(stmt.declaration.id.name)
        } else if (stmt.declaration?.type === 'VariableDeclaration') {
          considerVariable(stmt.declaration)
          for (const d of stmt.declaration.declarations) {
            if (d.id.type === 'Identifier') exportedNames.add(d.id.name)
          }
        }
        for (const spec of stmt.specifiers ?? []) {
          if (spec.type === 'ExportSpecifier' && spec.local) {
            exportedNames.add(spec.local.name)
          }
        }
      } else if (stmt.type === 'ExportDefaultDeclaration') {
        const decl = stmt.declaration
        if (decl.type === 'FunctionDeclaration' && decl.id) {
          considerFunction(decl)
          defaultExportName = decl.id.name
        } else if (decl.type === 'ClassDeclaration' && decl.id) {
          considerClass(decl)
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
        // Anonymous default expressions are skipped: no stable binding to tag.
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

    // import { __chRegisterMeta } from 'virtual:...'
    ast.program.body.unshift(
      t.importDeclaration(
        [t.importSpecifier(t.identifier(TAG_FN), t.identifier(TAG_FN))],
        t.stringLiteral(VIRTUAL_MODULE_ID),
      ),
    )

    // Append tag statements at the end so const bindings are initialized.
    for (const [name, isDefaultExport] of componentBindings) {
      const sourceId = createHash(id + ':' + name)
      const meta = t.objectExpression([
        t.objectProperty(
          t.identifier('componentName'),
          t.stringLiteral(name),
        ),
        t.objectProperty(t.identifier('filePath'), t.stringLiteral(id)),
        t.objectProperty(
          t.identifier('relativeFilePath'),
          t.stringLiteral(relativeFilePath),
        ),
        t.objectProperty(
          t.identifier('sourceId'),
          t.stringLiteral(sourceId),
        ),
        t.objectProperty(
          t.identifier('isDefaultExport'),
          t.booleanLiteral(isDefaultExport),
        ),
      ])
      ast.program.body.push(
        t.expressionStatement(
          t.callExpression(t.identifier(TAG_FN), [
            t.identifier(name),
            meta,
          ]),
        ),
      )
    }

    const output = generate(ast, {
      sourceMaps: true,
      sourceFileName: id,
    })

    return output.code
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
