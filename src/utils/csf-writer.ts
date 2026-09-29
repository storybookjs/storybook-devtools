/**
 * File-level mutation for generated stories: dedupes the export name against
 * what a story file already declares, merges the imports the new story needs,
 * and appends the story — on the CSF AST via `storybook/internal/csf-tools`
 * rather than by splicing strings.
 *
 * Only the *file* half lives here. Turning live props into story source
 * (`generateArgsContent`, `formatPropValue`, JSX/slot handling) stays in
 * `story-generator.ts`: csf-tools has no equivalent, its `save-story` flow
 * serialises already-typed args rather than arbitrary runtime values.
 *
 * `storybook/internal/csf-tools` and `storybook/internal/babel` are both
 * imported lazily so neither lands in Next's server webpack bundle — see
 * `src/story-index.ts` for the `webpackIgnore` reasoning. They also have to
 * come from the same module instance: csf-tools prints the file with recast,
 * which reprints only nodes it recognises as unchanged and asserts on the
 * rest, so an AST assembled from a bundled Babel copy and printed by the
 * native one fails the whole AST path.
 */
import type { types as t } from 'storybook/internal/babel'
import { escapeRegex } from './story-generator'

type BabelTypes = typeof t

export interface CsfImportRequest {
  /** Module specifier, e.g. `storybook/test` or `./Button`. */
  source: string
  /** Named specifiers to ensure, e.g. `['fn', 'within']`. */
  specifiers?: string[]
  /** Default import binding, e.g. `Button`. */
  defaultSpecifier?: string
  typeOnly?: boolean
}

export interface CsfWriteRequest {
  /** Current content of the story file being appended to. */
  existingCode: string
  /** Path of the story file, used for CSF diagnostics and formatting. */
  fileName: string
  /** Rendered `export const <desiredExportName>: Story = { ... };` block. */
  storyExportSource: string
  desiredExportName: string
  requiredImports: CsfImportRequest[]
}

export interface CsfWriteResult {
  code: string
  /** The export name actually used, after deduplication. */
  exportName: string
  /**
   * Why the CSF AST path was abandoned for the regex splice. Absent when
   * the story was appended on the AST.
   */
  fallbackReason?: string
}

/**
 * Recast (the AST path) and the regex fallback both work in LF and only
 * emit '\n'. Convert back to '\r\n' when the original file used it, without
 * doubling any '\r\n' the printer already reproduced verbatim from source.
 */
function restoreCrlf(code: string, originalCode: string): string {
  if (!originalCode.includes('\r\n')) return code
  return code.replace(/\r?\n/g, '\r\n')
}

/** Pick the quote style recast should use for nodes it has to print fresh. */
function detectQuoteStyle(code: string): 'single' | 'double' {
  const single = (code.match(/from '[^']*'/g) ?? []).length
  const double = (code.match(/from "[^"]*"/g) ?? []).length
  return double > single ? 'double' : 'single'
}

function uniqueExportName(taken: Set<string>, desired: string): string {
  if (!taken.has(desired)) return desired
  let counter = 2
  while (taken.has(`${desired}${counter}`)) counter++
  return `${desired}${counter}`
}

/** Every top-level binding a file already declares, imports included. */
function collectTopLevelBindings(t: BabelTypes, program: t.Program): Set<string> {
  const names = new Set<string>()
  const addPattern = (node: t.Node): void => {
    for (const name of Object.keys(t.getBindingIdentifiers(node))) names.add(name)
  }

  for (const statement of program.body) {
    const declaration = t.isExportNamedDeclaration(statement)
      ? statement.declaration
      : statement

    if (t.isVariableDeclaration(declaration)) {
      for (const declarator of declaration.declarations) addPattern(declarator.id)
    } else if (
      t.isFunctionDeclaration(declaration) ||
      t.isClassDeclaration(declaration) ||
      t.isTSTypeAliasDeclaration(declaration) ||
      t.isTSInterfaceDeclaration(declaration) ||
      t.isTSEnumDeclaration(declaration)
    ) {
      if (declaration.id) addPattern(declaration.id)
    } else if (t.isImportDeclaration(statement)) {
      for (const specifier of statement.specifiers) addPattern(specifier.local)
    }

    if (t.isExportNamedDeclaration(statement)) {
      for (const specifier of statement.specifiers) {
        if (t.isExportSpecifier(specifier)) addPattern(specifier.exported)
      }
    }
  }

  return names
}

/** Resolve imports by exported symbol; reuse aliases and promote type bindings. */
function mergeImport(
  t: BabelTypes,
  program: t.Program,
  request: CsfImportRequest,
  taken: Set<string>,
  snippetBindings: Set<string>,
): Map<string, string> {
  const aliases = new Map<string, string>()
  const requested = [
    ...(request.defaultSpecifier ? [{ imported: 'default', local: request.defaultSpecifier }] : []),
    ...(request.specifiers ?? []).map(name => ({ imported: name, local: name })),
  ]
  for (const { imported, local } of requested) {
    const imports = program.body.filter((node): node is t.ImportDeclaration =>
      t.isImportDeclaration(node) && node.source.value === request.source)
    const candidates = imports.flatMap(declaration => declaration.specifiers
      .filter(specifier => imported === 'default'
        ? t.isImportDefaultSpecifier(specifier)
        : t.isImportSpecifier(specifier) &&
          (t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value) === imported)
      .map(specifier => ({ declaration, specifier })))
    const isType = ({ declaration, specifier }: typeof candidates[number]) =>
      declaration.importKind === 'type' ||
      (t.isImportSpecifier(specifier) && specifier.importKind === 'type')
    const reusable = candidates.filter(candidate =>
      !snippetBindings.has(candidate.specifier.local.name))
    const existing = reusable.find(candidate => !isType(candidate)) ?? reusable[0]
    if (existing && (request.typeOnly || !isType(existing))) {
      aliases.set(local, existing.specifier.local.name)
      continue
    }

    // A type-only binding of the same symbol can serve both uses once
    // promoted. Leave other specifiers in the original type declaration.
    const binding = existing?.specifier.local.name ?? uniqueExportName(taken, local)
    if (existing) {
      const declaration = existing.declaration
      declaration.specifiers = declaration.specifiers.filter(s => s !== existing.specifier)
      if (declaration.specifiers.length === 0) {
        program.body.splice(program.body.indexOf(declaration), 1)
      }
    }
    taken.add(binding)
    aliases.set(local, binding)
    const specifier = imported === 'default'
      ? t.importDefaultSpecifier(t.identifier(binding))
      : t.importSpecifier(t.identifier(binding), t.identifier(imported))
    const target = program.body.find((node): node is t.ImportDeclaration =>
      t.isImportDeclaration(node) && node.source.value === request.source &&
      (node.importKind === 'type') === !!request.typeOnly &&
      !node.specifiers.some(s => t.isImportNamespaceSpecifier(s)) &&
      (imported !== 'default' || !node.specifiers.some(s => t.isImportDefaultSpecifier(s))))
    if (target) {
      if (imported === 'default') target.specifiers.unshift(specifier)
      else target.specifiers.push(specifier)
    } else {
      const declaration = t.importDeclaration([specifier], t.stringLiteral(request.source))
      if (request.typeOnly) declaration.importKind = 'type'
      insertImport(t, program, declaration)
    }
  }
  return aliases
}

function insertImport(
  t: BabelTypes,
  program: t.Program,
  declaration: t.ImportDeclaration,
): void {
  let lastImport = -1
  program.body.forEach((node, index) => {
    if (t.isImportDeclaration(node)) lastImport = index
  })
  program.body.splice(lastImport + 1, 0, declaration)
}

/** Rename the single declarator/function the snippet exports. */
function renameExport(
  t: BabelTypes,
  program: t.Program,
  from: string,
  to: string,
): void {
  if (from === to) return
  for (const statement of program.body) {
    if (!t.isExportNamedDeclaration(statement)) continue
    const declaration = statement.declaration
    if (t.isVariableDeclaration(declaration)) {
      for (const declarator of declaration.declarations) {
        if (t.isIdentifier(declarator.id) && declarator.id.name === from) {
          // Renaming in place keeps the identifier's type annotation
          // (`: Story`); replacing the node would drop it. Recast reprints
          // only the identifier, so the initialiser's generated args/JSX
          // survive verbatim.
          declarator.id.name = to
          return
        }
      }
    }
  }
}

/**
 * Append `storyExportSource` to `existingCode`, returning the full file
 * content and the export name that was actually used.
 */
export async function writeStoryIntoCsf(
  request: CsfWriteRequest,
): Promise<CsfWriteResult> {
  const { existingCode, fileName, desiredExportName } = request

  try {
    const [{ loadCsf, printCsf }, { babelParse, types: t, traverse }] = await Promise.all([
      import(/* webpackIgnore: true */ 'storybook/internal/csf-tools'),
      import(/* webpackIgnore: true */ 'storybook/internal/babel'),
    ])
    const csf = loadCsf(existingCode, {
      makeTitle: (userTitle: string) => userTitle || 'Auto',
      fileName,
    }).parse()

    const program = csf._ast.program
    const taken = collectTopLevelBindings(t, program)
    for (const name of Object.keys(csf._storyExports)) taken.add(name)
    const requiredNames = request.requiredImports.flatMap(imp => [
      ...(imp.specifiers ?? []), ...(imp.defaultSpecifier ? [imp.defaultSpecifier] : []),
    ])
    const exportName = uniqueExportName(new Set([...taken, ...requiredNames]), desiredExportName)

    // Keep snippet line numbers for recast's inter-statement spacing.
    const snippet = babelParse(`\n\n${request.storyExportSource.trimStart()}`)
    renameExport(t, snippet.program, desiredExportName, exportName)
    const snippetBindings = new Set<string>()
    traverse(snippet, {
      Scope(scopePath) {
        for (const name of Object.keys(scopePath.scope.bindings)) {
          snippetBindings.add(name)
          taken.add(name)
        }
      },
    })
    const aliases = new Map<string, string>()
    for (const importRequest of request.requiredImports) {
      for (const [name, binding] of mergeImport(t, program, importRequest, taken, snippetBindings)) {
        aliases.set(name, binding)
      }
    }
    traverse(snippet, {
      ReferencedIdentifier(identifierPath) {
        const name = identifierPath.node.name
        const binding = aliases.get(name)
        if (!binding || binding === name || identifierPath.scope.hasBinding(name)) return
        if (identifierPath.parentPath.isObjectProperty() && identifierPath.parentPath.node.shorthand) {
          identifierPath.parentPath.node.shorthand = false
        }
        identifierPath.node.name = binding
      },
    })
    program.body.push(...snippet.program.body)

    const { code } = printCsf(csf, { quote: detectQuoteStyle(existingCode) })
    babelParse(code)
    const withTrailingNewline = code.endsWith('\n') ? code : `${code}\n`
    return {
      code: restoreCrlf(withTrailingNewline, existingCode),
      exportName,
    }
  } catch (error) {
    const result = appendWithRegex(request)
    return {
      ...result,
      fallbackReason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Text-splicing append, used when a story file can't be parsed as CSF (no
 * default export, syntax the CSF parser rejects). Keeps a partially valid file
 * appendable instead of failing the whole story creation.
 */
function appendWithRegex(
  request: CsfWriteRequest,
): Pick<CsfWriteResult, 'code' | 'exportName'> {
  const { existingCode: code, desiredExportName, storyExportSource } = request

  const taken = new Set<string>()
  const storyExportRegex = /export\s+const\s+(\w+)\s*[=:]/g
  let match
  while ((match = storyExportRegex.exec(code)) !== null) {
    if (match[1]) taken.add(match[1])
  }
  const exportName = uniqueExportName(taken, desiredExportName)

  let updated = code
  const insertAfterImports = (statement: string): void => {
    const lastImportMatch = updated.match(
      /^(import\s+.+from\s+['"][^'"]+['"];?\s*\n)+/m,
    )
    if (!lastImportMatch) return
    const insertPos = lastImportMatch.index! + lastImportMatch[0].length
    updated =
      updated.slice(0, insertPos) + statement + updated.slice(insertPos)
  }

  for (const importRequest of request.requiredImports) {
    const { source, specifiers = [], defaultSpecifier } = importRequest
    const namedRegex = new RegExp(
      `import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${escapeRegex(source)}['"]`,
    )
    const namedMatch = updated.match(namedRegex)

    if (specifiers.length > 0) {
      if (namedMatch && namedMatch[1]) {
        const declared = namedMatch[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const merged = [...new Set([...declared, ...specifiers])]
        if (merged.length !== declared.length) {
          updated = updated.replace(
            namedMatch[0],
            `import { ${merged.join(', ')} } from '${source}'`,
          )
        }
      } else {
        insertAfterImports(
          `import ${importRequest.typeOnly ? 'type ' : ''}{ ${specifiers.join(', ')} } from '${source}';\n`,
        )
      }
    }

    if (defaultSpecifier && !new RegExp(
      `import\\s+${escapeRegex(defaultSpecifier)}\\s*(,|from)`,
    ).test(updated)) {
      insertAfterImports(`import ${defaultSpecifier} from '${source}';\n`)
    }
  }

  const story = storyExportSource.replace(
    `export const ${desiredExportName}`,
    `export const ${exportName}`,
  )

  return {
    code: restoreCrlf(`${updated.trimEnd()}\n\n${story.trim()}\n`, code),
    exportName,
  }
}

/**
 * Run the user project's prettier over generated story content. A no-op
 * returning `content` unchanged when prettier isn't installed or the project
 * has no prettier/editorconfig config.
 */
export async function formatStoryFile(
  filePath: string,
  content: string,
): Promise<string> {
  try {
    const { formatFileContent } = await import(
      /* webpackIgnore: true */ 'storybook/internal/common'
    )
    return await formatFileContent(filePath, content)
  } catch {
    return content
  }
}
