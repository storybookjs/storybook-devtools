/**
 * Reads a React module's facts (`ModuleFacts` in `transform.ts`) with
 * `parseModule` and `walk` from the csf-tools of
 * storybookjs/storybook#36613 (Storybook 11), which parse with OXC into
 * ESTree nodes. `transform-babel.ts` reads the same facts with Babel.
 */

import type { ESTree as T } from 'storybook/internal/csf-tools'
import type { ModuleFacts, ModuleReader } from './transform'
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

function read(code: string, id: string): ModuleFacts {
  // Offsets index `parsedCode`, which has its line endings normalized.
  const { program, code: parsedCode } = tools().parseModule(code, id)

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
  // `file:line:column`, both 1-based; `locationOf` gives a 0-based column.
  const nodeLoc = (node: T.Node): string => {
    const { line, column } = tools().locationOf(parsedCode, node.start, node.end).start
    return `${id}:${line}:${column + 1}`
  }

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

  return {
    useClient: hasUseClientDirective(program),
    hasJsx,
    components: topLevelComponents,
    exportedNames,
    defaultExportName,
    anonymousDefaultLoc: anonDefaultLoc,
    unsupportedHoc,
  }
}

export const estreeModuleReader: ModuleReader = { read }
