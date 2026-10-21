/**
 * File-level mutation for generated stories: dedupes the export name against
 * what a story file already declares, merges the imports the new story needs,
 * and appends the story.
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
 * `loadCsf().parse()` validates the file on every supported Storybook.
 * Reading the file's syntax, its story format included, and editing it
 * differs: Storybook 10 (and 11 prereleases without
 * storybookjs/storybook#36613) hands out Babel nodes and prints with
 * recast; with #36613 csf-tools hand out ESTree nodes and edit text. Those steps
 * sit behind `StoryFileEditor`, implemented by `csf-writer-babel.ts` and
 * `csf-writer-estree.ts`; the rules for names and imports are written once
 * here. A file `CsfFile` rejects falls back to a regex splice.
 *
 * `storybook/internal/csf-tools` is imported lazily so it does not land in
 * Next's server webpack bundle — see `src/story-index.ts` for the
 * `webpackIgnore` reasoning. The editors import their Storybook modules the
 * same way.
 */
import type { CsfFile } from 'storybook/internal/csf-tools'
import { escapeRegex, renderStoryExport, type ExportStyle } from './story-generator'

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

/** One specifier of an import declaration; namespace specifiers excluded. */
export interface ImportSpecifierInfo {
  /** `default` for `import X from`, `named` for `import { a as X } from`. */
  readonly kind: 'default' | 'named'
  /** The exported name it imports: `default` for a default specifier. */
  readonly imported: string
  /** The local binding. */
  readonly local: string
  /** An inline `type` specifier, `import { type X } from`. */
  readonly typeOnly: boolean
}

/** One import declaration of a story file, as the import rules read it. */
export interface ImportDeclarationInfo {
  /** `import type { ... } from`. */
  readonly typeOnly: boolean
  readonly hasDefault: boolean
  readonly hasNamespace: boolean
  readonly specifiers: readonly ImportSpecifierInfo[]
}

/**
 * The syntax-level reads and edits of one story file. Import lookups
 * reflect every edit made before them; `ImportDeclarationInfo` and
 * `ImportSpecifierInfo` values are only valid until the next edit.
 */
export interface StoryFileEditor {
  /**
   * Every name the file declares at the top level, imports and types
   * included, and every name it exports.
   */
  topLevelNames(): Set<string>
  /**
   * The export the file's format calls for: a `<meta>.story()` call in a
   * CSF factory file, else a CSF3 object typed like the file's stories —
   * the first story's annotation or `satisfies` clause, else the `Story`
   * type alias when the file declares one, else untyped.
   */
  exportStyle(): ExportStyle
  /** The import declarations of `source`, in file order. */
  importsFrom(source: string): ImportDeclarationInfo[]
  /** Removes `specifier`, and its declaration once that is empty. */
  removeSpecifier(declaration: ImportDeclarationInfo, specifier: ImportSpecifierInfo): void
  /**
   * Adds `imported as local` (or a default `local`) to `declaration`. An
   * editor whose csf-tools pick the import to extend themselves may add it
   * to another import of the same module.
   */
  addSpecifier(declaration: ImportDeclarationInfo, imported: string, local: string): void
  /** Adds an import of `imported as local` below the file's imports. */
  addImport(source: string, imported: string, local: string, typeOnly: boolean): void
  /**
   * Parses the new story's source on its own and returns every name it
   * declares, at any depth. `requiredNames` are the names it may take
   * from the required imports.
   */
  parseStory(source: string, requiredNames: string[]): Set<string>
  /**
   * Points the story's references to required imports at the bindings in
   * `aliases`, skipping references a local shadows, appends the story and
   * returns the file. Throws when the result does not parse.
   */
  print(aliases: Map<string, string>): string
}

/** The `StoryFileEditor` of one csf-tools generation. */
export interface CsfWriterSyntax {
  open(csf: CsfFile, code: string, fileName: string, lineEnding: '\r\n' | '\n'): StoryFileEditor
}

let syntax: Promise<CsfWriterSyntax> | undefined

/**
 * The editor for the installed Storybook: ESTree when its csf-tools have
 * `parseModule`, Babel otherwise. Each is imported only on the Storybook
 * it is written for: with storybookjs/storybook#36613
 * `storybook/internal/babel` does not resolve, and without it the ESTree
 * csf-tools API is missing. A failed load is not kept, so the next write
 * tries again.
 */
function csfWriterSyntax(): Promise<CsfWriterSyntax> {
  syntax ??= (async () => {
    const csfTools = await import(/* webpackIgnore: true */ 'storybook/internal/csf-tools')
    const editor = typeof (csfTools as { parseModule?: unknown }).parseModule === 'function'
      ? await import('./csf-writer-estree')
      : await import('./csf-writer-babel')
    return editor.loadCsfWriterSyntax()
  })()
  syntax.catch(() => {
    syntax = undefined
  })
  return syntax
}

/**
 * The line ending a file uses: CRLF when most of its line breaks are CRLF,
 * LF otherwise. Neither editor keeps a file's line endings on its own
 * (recast prints with one terminator, `SourceEditor` ends every line like
 * the file's first one), so the output is normalised to the majority.
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

function uniqueExportName(taken: Set<string>, desired: string): string {
  if (!taken.has(desired)) return desired
  let counter = 2
  while (taken.has(`${desired}${counter}`)) counter++
  return `${desired}${counter}`
}

/** Resolve imports by exported symbol; reuse aliases and promote type bindings. */
function mergeImport(
  file: StoryFileEditor,
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
    const candidates = file.importsFrom(request.source).flatMap(declaration =>
      declaration.specifiers
        .filter(specifier => imported === 'default'
          ? specifier.kind === 'default'
          : specifier.kind === 'named' && specifier.imported === imported)
        .map(specifier => ({ declaration, specifier })))
    const isType = ({ declaration, specifier }: typeof candidates[number]) =>
      declaration.typeOnly || specifier.typeOnly
    const reusable = candidates.filter(candidate =>
      !snippetBindings.has(candidate.specifier.local))
    const existing = reusable.find(candidate => !isType(candidate)) ?? reusable[0]
    if (existing && (request.typeOnly || !isType(existing))) {
      aliases.set(local, existing.specifier.local)
      continue
    }

    // A type-only binding of the same symbol can serve both uses once
    // promoted. Leave other specifiers in the original type declaration.
    const binding = existing?.specifier.local ?? uniqueExportName(taken, local)
    if (existing) file.removeSpecifier(existing.declaration, existing.specifier)
    taken.add(binding)
    aliases.set(local, binding)
    const target = file.importsFrom(request.source).find(declaration =>
      declaration.typeOnly === !!request.typeOnly &&
      !declaration.hasNamespace &&
      (imported !== 'default' || !declaration.hasDefault))
    if (target) {
      file.addSpecifier(target, imported, binding)
    } else {
      file.addImport(request.source, imported, binding, !!request.typeOnly)
    }
  }
  return aliases
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
    const [{ loadCsf }, { open }] = await Promise.all([
      import(/* webpackIgnore: true */ 'storybook/internal/csf-tools'),
      csfWriterSyntax(),
    ])
    const csf = loadCsf(existingCode, {
      makeTitle: (userTitle: string) => userTitle || 'Auto',
      fileName,
    }).parse()

    const lineEnding = detectLineEnding(existingCode)
    const file = open(csf, existingCode, fileName, lineEnding)
    const taken = file.topLevelNames()
    const requiredNames = [...new Set(request.requiredImports.flatMap(imp => [
      ...(imp.specifiers ?? []), ...(imp.defaultSpecifier ? [imp.defaultSpecifier] : []),
    ]))]
    const exportName = uniqueExportName(new Set([...taken, ...requiredNames]), desiredExportName)

    const snippetBindings = file.parseStory(
      renderStoryExport(file.exportStyle(), exportName, request.storyObjectSource),
      requiredNames,
    )
    for (const name of snippetBindings) taken.add(name)
    const aliases = new Map<string, string>()
    for (const importRequest of request.requiredImports) {
      for (const [name, binding] of mergeImport(file, importRequest, taken, snippetBindings)) {
        aliases.set(name, binding)
      }
    }

    return {
      code: normalizeLineEndings(file.print(aliases), lineEnding),
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

  // The splice adds a value import next to a type-only one of the same
  // name, which declares it twice. Refuse instead of writing that file.
  for (const { specifiers = [], defaultSpecifier, typeOnly } of request.requiredImports) {
    if (typeOnly) continue
    for (const name of [...specifiers, ...(defaultSpecifier ? [defaultSpecifier] : [])]) {
      const typeImport = new RegExp(
        `import\\s+type\\s+(?:${escapeRegex(name)}\\b|\\{[^}]*\\b${escapeRegex(name)}\\b)` +
          `|\\btype\\s+${escapeRegex(name)}\\s*[,}]`,
      )
      if (typeImport.test(code)) {
        throw new Error(
          `Could not add the story to ${request.fileName}: the file imports \`${name}\` as a type, ` +
            'and the story needs it as a value. Import it as a value and save the story again.',
        )
      }
    }
  }

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
