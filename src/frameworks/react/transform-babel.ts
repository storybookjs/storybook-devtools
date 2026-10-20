/**
 * Reads a React module's facts (`ModuleFacts` in `transform.ts`) with the
 * Babel parser of Storybook 10. Storybook 11 removes
 * `storybook/internal/babel`; `transform-estree.ts` reads the same facts
 * there. This file can go when the plugin drops Storybook 10.
 */

// @ts-nocheck
import type { types as T } from 'storybook/internal/babel'
import type { ModuleFacts, ModuleReader } from './transform'
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
const traverse: BabelModule['traverse'] = ((...args) =>
  babel().traverse(...args)) as BabelModule['traverse']

const parse: BabelModule['parser']['parse'] = (...args) =>
  babel().parser.parse(...args)

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

function read(code: string, id: string): ModuleFacts {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: [
      'typescript',
      'jsx',
      ['decorators', { decoratorsBeforeExport: true }],
    ],
    sourceFilename: id,
  })

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

  return {
    useClient: hasUseClientDirective(ast),
    hasJsx,
    components: topLevelComponents,
    exportedNames,
    defaultExportName,
    anonymousDefaultLoc: anonDefaultLoc,
    unsupportedHoc,
  }
}

export const babelModuleReader: ModuleReader = { read }
