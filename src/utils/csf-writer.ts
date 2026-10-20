/**
 * File-level mutation for generated stories: dedupes the export name against
 * what a story file already declares, merges the imports the new story needs,
 * and appends the story — through the csf-tools source editor of
 * `storybook/internal/csf-tools` rather than by splicing strings.
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
 * `CsfFile` validates the file and supplies its stories, meta and export
 * style; the edits are text edits in a `SourceEditor` of the same source, so
 * code the writer does not touch stays as written (line endings aside: a
 * file with mixed endings comes back with its majority ending).
 * `storybook/internal/csf-tools` is imported lazily so it does not land in
 * Next's server webpack bundle — see `src/story-index.ts` for the
 * `webpackIgnore` reasoning.
 */
import type { CsfFile, ESTree, ESTreeNode, SourceEditor } from 'storybook/internal/csf-tools'
import { escapeRegex, renderStoryExport, type ExportStyle } from './story-generator'

type CsfTools = typeof import('storybook/internal/csf-tools')

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
 * LF otherwise. `SourceEditor` ends every line like the file's first one, so a
 * file with mixed endings is normalised to its majority style here instead.
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

/** The quote character for the source of an import the writer adds. */
function detectQuote(code: string): "'" | '"' {
  const single = (code.match(/from '[^']*'/g) ?? []).length
  const double = (code.match(/from "[^"]*"/g) ?? []).length
  return double > single ? '"' : "'"
}

type ImportSpecifier = ESTree.ImportDeclaration['specifiers'][number]

/**
 * The export style of a parsed CSF file: factory when `CsfFile` recognised a
 * `preview.meta(...)` call, otherwise CSF3 typed like its existing stories —
 * the first story's annotation or `satisfies` clause, else the `Story` type
 * alias when the file declares one, else untyped.
 */
function detectExportStyle(csf: CsfFile): ExportStyle {
  if (csf._metaIsFactory) {
    return { kind: 'factory', metaName: csf._metaVariableName ?? 'meta' }
  }
  const sourceOf = (node: ESTreeNode): string => csf._editor.source(node)
  for (const story of Object.values(csf._storyExports)) {
    if (story.type !== 'VariableDeclarator') continue
    const annotation = story.id.type === 'Identifier' && story.id.typeAnnotation
      ? sourceOf(story.id.typeAnnotation.typeAnnotation)
      : undefined
    if (annotation) return { kind: 'csf3', annotation }
    if (story.init?.type === 'TSSatisfiesExpression') {
      const satisfies = sourceOf(story.init.typeAnnotation)
      if (satisfies) return { kind: 'csf3', satisfies }
    }
  }
  const declaresStoryType = csf._program.body.some(statement => {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    return (node?.type === 'TSTypeAliasDeclaration' || node?.type === 'TSInterfaceDeclaration') &&
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

/** Every name a binding pattern declares, e.g. `a` and `b` in `{ a, b: [b] }`. */
function addPatternNames(names: Set<string>, node: ESTreeNode | null | undefined): void {
  if (!node) return
  switch (node.type) {
    case 'Identifier':
      names.add(node.name)
      break
    case 'ObjectPattern':
      for (const property of node.properties) {
        addPatternNames(names, property.type === 'RestElement' ? property.argument : property.value)
      }
      break
    case 'ArrayPattern':
      for (const element of node.elements) addPatternNames(names, element)
      break
    case 'AssignmentPattern':
      addPatternNames(names, node.left)
      break
    case 'RestElement':
      addPatternNames(names, node.argument)
      break
  }
}

/** Every top-level binding a file already declares, imports included. */
function collectTopLevelBindings(program: ESTree.Program): Set<string> {
  const names = new Set<string>()

  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration'
      ? statement.declaration
      : statement

    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) addPatternNames(names, declarator.id)
    } else if (
      declaration?.type === 'FunctionDeclaration' ||
      declaration?.type === 'ClassDeclaration' ||
      declaration?.type === 'TSTypeAliasDeclaration' ||
      declaration?.type === 'TSInterfaceDeclaration' ||
      declaration?.type === 'TSEnumDeclaration'
    ) {
      if (declaration.id) names.add(declaration.id.name)
    } else if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) names.add(specifier.local.name)
    }

    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of statement.specifiers) {
        if (specifier.exported.type === 'Identifier') names.add(specifier.exported.name)
      }
    }
  }

  return names
}

function importsFrom(program: ESTree.Program, source: string): ESTree.ImportDeclaration[] {
  return program.body.filter((node): node is ESTree.ImportDeclaration =>
    node.type === 'ImportDeclaration' && node.source.value === source)
}

/**
 * Resolve imports by exported symbol; reuse aliases and promote type bindings.
 * Each change is committed before the next lookup, so every step reads the
 * file's imports as the previous step left them. The editor is not the
 * `CsfFile`'s, so a commit only parses the file again: it does not index it
 * as CSF, which a file can briefly fail while a type import is promoted.
 */
function mergeImport(
  tools: CsfTools,
  editor: SourceEditor,
  request: CsfImportRequest,
  taken: Set<string>,
  snippetBindings: Set<string>,
  quote: "'" | '"',
): Map<string, string> {
  const aliases = new Map<string, string>()
  const requested = [
    ...(request.defaultSpecifier ? [{ imported: 'default', local: request.defaultSpecifier }] : []),
    ...(request.specifiers ?? []).map(name => ({ imported: name, local: name })),
  ]
  for (const { imported, local } of requested) {
    const candidates = importsFrom(editor.program, request.source).flatMap(declaration =>
      declaration.specifiers
        .filter(specifier => imported === 'default'
          ? specifier.type === 'ImportDefaultSpecifier'
          : specifier.type === 'ImportSpecifier' &&
            (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === imported)
        .map(specifier => ({ declaration, specifier })))
    const isType = ({ declaration, specifier }: typeof candidates[number]) =>
      declaration.importKind === 'type' ||
      (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
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
      const { declaration } = existing
      const kept = declaration.specifiers.filter((s: ImportSpecifier) => s !== existing.specifier)
      if (kept.length === 0) {
        tools.removeStatement(editor, declaration)
      } else {
        tools.setImportSpecifiers(editor, declaration, kept)
      }
      editor.commit()
    }
    taken.add(binding)
    aliases.set(local, binding)
    const named = imported === binding ? binding : `${imported} as ${binding}`
    const target = importsFrom(editor.program, request.source).find(node =>
      (node.importKind === 'type') === !!request.typeOnly &&
      !node.specifiers.some((s: ImportSpecifier) => s.type === 'ImportNamespaceSpecifier') &&
      (imported !== 'default' || !node.specifiers.some((s: ImportSpecifier) => s.type === 'ImportDefaultSpecifier')))
    if (target) {
      tools.setImportSpecifiers(
        editor,
        target,
        target.specifiers,
        imported === 'default' ? { default: binding } : { named: [named] },
      )
    } else {
      const clause = imported === 'default' ? binding : `{ ${named} }`
      tools.insertAfterImports(
        editor,
        `import ${request.typeOnly ? 'type ' : ''}${clause} from ${tools.printString(request.source, quote)};`,
      )
    }
    editor.commit()
  }
  return aliases
}

// Source of the import that declares the required names in the parsed story
// snippet, so their references in it resolve to one binding each. It is never
// written to the file.
const SNIPPET_IMPORT_SOURCE = 'storybook-devtools:required-imports'

/**
 * The new story's source, parsed on its own with the required import names
 * declared above it. `bindings` holds every name the story itself declares,
 * at any depth; `rename` points the story's references to required imports at
 * the bindings the file provides, skipping references a local shadows.
 */
function parseStorySnippet(
  tools: CsfTools,
  storySource: string,
  requiredNames: string[],
  fileName: string,
) {
  const prefix = requiredNames.length > 0
    ? `import { ${requiredNames.join(', ')} } from '${SNIPPET_IMPORT_SOURCE}';\n`
    : ''
  const snippet = new tools.SourceEditor(`${prefix}${storySource}`, fileName)
  const declaration = prefix ? snippet.program.body[0] : undefined
  const isRequired = (binding: { declaration?: ESTreeNode }) =>
    !!declaration && binding.declaration === declaration

  const bindings = new Set<string>()
  const { scopes } = snippet
  tools.walk(snippet.program, node => {
    for (const binding of scopes.scopeOf(node).bindings.values()) {
      if (!isRequired(binding)) bindings.add(binding.name)
    }
  })

  const rename = (aliases: Map<string, string>): string => {
    for (const binding of scopes.program.bindings.values()) {
      const target = aliases.get(binding.name)
      if (!isRequired(binding) || !target || target === binding.name) continue
      for (const reference of binding.references) {
        if (reference.type !== 'Identifier' && reference.type !== 'JSXIdentifier') continue
        const parent = snippet.parentOf(reference)
        const shorthand = parent?.type === 'Property' && parent.shorthand && parent.value === reference
        snippet.edits.overwrite(
          reference.start,
          reference.end,
          shorthand ? `${binding.name}: ${target}` : target,
        )
      }
    }
    return snippet.edits.toString().slice(prefix.length)
  }

  return { bindings, rename }
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
    const tools = await import(/* webpackIgnore: true */ 'storybook/internal/csf-tools')
    const csf = tools.loadCsf(existingCode, {
      makeTitle: (userTitle: string) => userTitle || 'Auto',
      fileName,
    }).parse()

    const taken = collectTopLevelBindings(csf._program)
    for (const name of Object.keys(csf._storyExports)) taken.add(name)
    const requiredNames = [...new Set(request.requiredImports.flatMap(imp => [
      ...(imp.specifiers ?? []), ...(imp.defaultSpecifier ? [imp.defaultSpecifier] : []),
    ]))]
    const exportName = uniqueExportName(new Set([...taken, ...requiredNames]), desiredExportName)

    const style = detectExportStyle(csf)
    const snippet = parseStorySnippet(
      tools,
      renderStoryExport(style, exportName, request.storyObjectSource),
      requiredNames,
      fileName,
    )
    for (const name of snippet.bindings) taken.add(name)
    const quote = detectQuote(existingCode)
    const editor = new tools.SourceEditor(existingCode, fileName)
    const aliases = new Map<string, string>()
    for (const importRequest of request.requiredImports) {
      for (const [name, binding] of mergeImport(tools, editor, importRequest, taken, snippet.bindings, quote)) {
        aliases.set(name, binding)
      }
    }
    const story = snippet.rename(aliases).trim()

    // The story goes after everything else in the file, trailing comments
    // included, a blank line apart.
    const { code: current, edits } = editor
    const contentEnd = current.trimEnd().length
    const appended = `${contentEnd > 0 ? '\n\n' : ''}${story}\n`
    if (contentEnd < current.length) {
      edits.overwrite(contentEnd, current.length, appended)
    } else {
      edits.append(appended)
    }
    // Throws when the result does not parse.
    editor.commit()

    const code = editor.toString()
    const withTrailingNewline = code.endsWith('\n') ? code : `${code}\n`
    return {
      code: normalizeLineEndings(withTrailingNewline, detectLineEnding(existingCode)),
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
