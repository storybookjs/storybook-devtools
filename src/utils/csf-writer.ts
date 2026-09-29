/**
 * File-level mutation for generated stories: dedupes the export name against
 * what a story file already declares, merges the imports the new story needs,
 * and appends the story — on the CSF AST via `storybook/internal/csf-tools`
 * rather than by splicing strings.
 *
 * The appended export follows the *file's* format, whatever the project's
 * preview says: `export const X = <meta>.story({...})` in a CSF factory
 * file (using that file's own meta variable), and a CSF3 object export in
 * a CSF3 file, typed the way its existing stories are. A file never ends up
 * with both, which `CsfFile` rejects as a mixed-factory error.
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
import { escapeRegex, renderStoryExport, type ExportStyle } from './story-generator'

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
  /**
   * Object literal of the story, e.g. `{ args: { label: 'Go' } }`. The
   * writer wraps it in the export the target file's format calls for.
   */
  storyObjectSource: string
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
 * The line ending a file uses: CRLF when most of its line breaks are CRLF,
 * LF otherwise. Printers disagree on their default (recast uses `os.EOL` on
 * Storybook 10 and always LF on Storybook 11), so the output is normalised
 * to the existing file's style rather than to whatever the printer emitted.
 */
function detectLineEnding(code: string): '\r\n' | '\n' {
  const crlf = (code.match(/\r\n/g) ?? []).length
  const lf = (code.match(/\n/g) ?? []).length - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** Rewrite every line break in `code` to `lineEnding`. */
function normalizeLineEndings(code: string, lineEnding: '\r\n' | '\n'): string {
  return code.replace(/\r?\n/g, lineEnding)
}

/** Pick the quote style recast should use for nodes it has to print fresh. */
function detectQuoteStyle(code: string): 'single' | 'double' {
  const single = (code.match(/from '[^']*'/g) ?? []).length
  const double = (code.match(/from "[^"]*"/g) ?? []).length
  return double > single ? 'double' : 'single'
}

/**
 * The export style of a parsed CSF file: factory when `CsfFile` recognised a
 * `preview.meta(...)` call, otherwise CSF3 typed like its existing stories —
 * the first story's annotation or `satisfies` clause, else the `Story` type
 * alias when the file declares one, else untyped.
 */
function detectExportStyle(
  t: BabelTypes,
  csf: {
    _metaIsFactory?: boolean | undefined
    _metaVariableName?: string | undefined
    _storyExports: Record<string, t.Node>
    _ast: { program: t.Program }
  },
  code: string,
): ExportStyle {
  if (csf._metaIsFactory) {
    return { kind: 'factory', metaName: csf._metaVariableName ?? 'meta' }
  }
  // Recast parses line-ending-normalised text, so node offsets index the LF
  // form of the source.
  const lfCode = code.replace(/\r\n/g, '\n')
  const sourceOf = (node: t.Node): string | undefined =>
    node.start != null && node.end != null ? lfCode.slice(node.start, node.end) : undefined
  for (const story of Object.values(csf._storyExports)) {
    if (!t.isVariableDeclarator(story)) continue
    const annotation = t.isIdentifier(story.id) && t.isTSTypeAnnotation(story.id.typeAnnotation)
      ? sourceOf(story.id.typeAnnotation.typeAnnotation)
      : undefined
    if (annotation) return { kind: 'csf3', annotation }
    if (t.isTSSatisfiesExpression(story.init)) {
      const satisfies = sourceOf(story.init.typeAnnotation)
      if (satisfies) return { kind: 'csf3', satisfies }
    }
  }
  const declaresStoryType = csf._ast.program.body.some(statement => {
    const node = t.isExportNamedDeclaration(statement) ? statement.declaration : statement
    return (t.isTSTypeAliasDeclaration(node) || t.isTSInterfaceDeclaration(node)) &&
      node.id.name === 'Story'
  })
  return declaresStoryType ? { kind: 'csf3', annotation: 'Story' } : { kind: 'csf3' }
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
 * Append the story to `existingCode`, returning the full file
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
    const style = detectExportStyle(t, csf, existingCode)
    const snippet = babelParse(
      `\n\n${renderStoryExport(style, desiredExportName, request.storyObjectSource)}`,
    )
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

    const lineEnding = detectLineEnding(existingCode)
    const { code } = printCsf(csf, {
      quote: detectQuoteStyle(existingCode),
      lineTerminator: lineEnding,
    })
    babelParse(code)
    const withTrailingNewline = code.endsWith('\n') ? code : `${code}\n`
    return {
      code: normalizeLineEndings(withTrailingNewline, lineEnding),
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
  const { existingCode: code, desiredExportName, storyObjectSource } = request

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

  // Last-resort text detection of a factory file (`const meta =
  // preview.meta(`): the export must match the file's format even when
  // `CsfFile` could not parse it.
  const factoryMeta = code.match(/\b(?:const|let)\s+(\w+)\s*=\s*\w+[^\n;]*?\.meta\s*\(/)
  const style: ExportStyle = factoryMeta?.[1]
    ? { kind: 'factory', metaName: factoryMeta[1] }
    : { kind: 'csf3', annotation: 'Story' }
  const story = renderStoryExport(style, exportName, storyObjectSource)

  return {
    code: normalizeLineEndings(
      `${updated.trimEnd()}\n\n${story.trim()}\n`,
      detectLineEnding(code),
    ),
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
