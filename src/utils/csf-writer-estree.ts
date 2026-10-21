/**
 * `StoryFileEditor` for the csf-tools of storybookjs/storybook#36613
 * (Storybook 11), which hand out ESTree nodes and edit text.
 * `csf-writer-babel.ts` does the same with the Babel csf-tools.
 *
 * The file is read and edited through the `CsfFile` and its `editor`, so
 * code the writer does not touch stays as written; only the new story is
 * parsed in a `SourceEditor` of its own. Value imports are added with
 * `CsfFile.setImport`. Each commit parses and indexes the file again, so an
 * edit that leaves invalid CSF throws and the writer falls back to its text
 * splice. `storybook/internal/csf-tools` is imported lazily so it does
 * not land in Next's server webpack bundle — see `src/story-index.ts` for
 * the `webpackIgnore` reasoning.
 */
import type {
  Binding,
  CsfFile,
  CsfMutationResult,
  ESTree,
  SourceEditor,
} from 'storybook/internal/csf-tools'
import type {
  CsfWriterSyntax,
  ImportDeclarationInfo,
  ImportSpecifierInfo,
  StoryFileEditor,
} from './csf-writer'
import type { ExportStyle } from './story-generator'

type CsfTools = typeof import('storybook/internal/csf-tools')

/**
 * The variable a CSF factory file declares its meta as: `meta` in
 * `const meta = preview.meta({ ... })`. `CsfFile` has no public name for
 * it, so it is the variable the `.meta()` call around the meta's object
 * initializes, else the receiver of the first `meta.story()` story, which
 * also covers a `.meta()` call without an object literal. Undefined in a
 * CSF3 file, and in a factory file whose meta it cannot find that way.
 */
function factoryMetaName(tools: CsfTools, csf: CsfFile): string | undefined {
  const { editor } = csf
  const [meta] = csf.objects({ stories: false })
  let node = meta?.node && editor.parentOf(meta.node)
  let inMetaCall = false
  while (node && node.type !== 'VariableDeclarator') {
    inMetaCall ||= node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
      tools.isIdentifier(node.callee.property, 'meta')
    node = editor.parentOf(node)
  }
  if (inMetaCall && node?.id.type === 'Identifier') return node.id.name

  for (const story of csf.stories) {
    if (!story.factory) continue
    const declarator = editor.scopes.program.bindings.get(story.localName ?? story.exportName)?.node
    const init = declarator?.type === 'VariableDeclarator' && declarator.init
      ? tools.unwrapExpression(declarator.init)
      : undefined
    if (tools.isCsfFactoryCall(init) && init.callee.property.name === 'story') {
      return tools.csfFactoryReceiver(init).name
    }
  }
  return undefined
}

/**
 * The export style the file calls for: a `<meta>.story()` call in a CSF
 * factory file, else a CSF3 object typed like the file's existing stories —
 * the first story's annotation or `satisfies` clause, else the `Story` type
 * alias when the file declares one, else untyped.
 */
function detectExportStyle(tools: CsfTools, csf: CsfFile): ExportStyle {
  const metaName = factoryMetaName(tools, csf)
  if (metaName) return { kind: 'factory', metaName }
  if (csf.stories.some(story => story.factory)) {
    throw new Error('Cannot find the meta variable of a CSF factory file')
  }
  const { scopes } = csf.editor
  for (const story of csf.stories) {
    const declarator = scopes.program.bindings.get(story.localName ?? story.exportName)?.node
    if (declarator?.type !== 'VariableDeclarator') continue
    if (declarator.id.type === 'Identifier' && declarator.id.typeAnnotation) {
      return { kind: 'csf3', annotation: tools.textOf(declarator.id.typeAnnotation.typeAnnotation) }
    }
    if (declarator.init?.type === 'TSSatisfiesExpression') {
      return { kind: 'csf3', satisfies: tools.textOf(declarator.init.typeAnnotation) }
    }
  }
  return scopes.tsDeclarationNames.has('Story')
    ? { kind: 'csf3', annotation: 'Story' }
    : { kind: 'csf3' }
}

/**
 * Every name a file declares at the top level, imports and types included,
 * and every name it exports.
 */
function topLevelNames(tools: CsfTools, editor: SourceEditor): Set<string> {
  const names = new Set([
    ...editor.scopes.program.bindings.keys(),
    ...editor.scopes.tsDeclarationNames,
  ])
  for (const statement of editor.program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    for (const specifier of statement.specifiers) {
      names.add(tools.importedName(specifier.exported))
    }
  }
  return names
}

function importsFrom(program: ESTree.Program, source: string): ESTree.ImportDeclaration[] {
  return program.body.filter((node): node is ESTree.ImportDeclaration =>
    node.type === 'ImportDeclaration' && node.source.value === source)
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
  const isRequired = (binding: Binding) =>
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

type ImportSpecifierNode = ESTree.ImportDeclaration['specifiers'][number]

/** `name`, or `imported as name`, as `setImport` and an import clause spell it. */
function importName(imported: string, binding: string): string {
  return imported === binding ? binding : `${imported} as ${binding}`
}

/** Throws the diagnostic of a refused mutation. */
function applied(result: CsfMutationResult): void {
  if (!result.ok) throw new Error(result.diagnostic.message)
}

export async function loadCsfWriterSyntax(): Promise<CsfWriterSyntax> {
  const tools = await import(/* webpackIgnore: true */ 'storybook/internal/csf-tools')

  function open(csf: CsfFile, _code: string, fileName: string): StoryFileEditor {
    const { editor } = csf
    const declarations = new WeakMap<ImportDeclarationInfo, ESTree.ImportDeclaration>()
    const specifiers = new WeakMap<ImportSpecifierInfo, ImportSpecifierNode>()
    let snippet: ReturnType<typeof parseStorySnippet> | undefined

    const nodeOf = <K extends object, V>(map: WeakMap<K, V>, info: K): V => {
      const node = map.get(info)
      if (!node) throw new Error('Stale import info')
      return node
    }

    // Adds a value import of `imported as binding`, into the first value
    // import of `source` that can take it, else as an import of its own.
    const setImport = (source: string, imported: string, binding: string) => {
      applied(csf.setImport(
        imported === 'default' ? binding : [importName(imported, binding)],
        source,
      ))
    }

    // Each edit is committed before the next lookup, so every step reads the
    // file's imports as the previous step left them.
    return {
      topLevelNames: () => topLevelNames(tools, editor),

      exportStyle: () => detectExportStyle(tools, csf),

      importsFrom(source) {
        return importsFrom(editor.program, source).map(declaration => {
          const info: ImportDeclarationInfo = {
            typeOnly: declaration.importKind === 'type',
            hasDefault: declaration.specifiers.some(s => s.type === 'ImportDefaultSpecifier'),
            hasNamespace: declaration.specifiers.some(s => s.type === 'ImportNamespaceSpecifier'),
            specifiers: declaration.specifiers.flatMap(specifier => {
              if (specifier.type === 'ImportNamespaceSpecifier') return []
              const named = specifier.type === 'ImportSpecifier'
              const specifierInfo: ImportSpecifierInfo = {
                kind: named ? 'named' : 'default',
                imported: specifier.type === 'ImportSpecifier'
                  ? tools.importedName(specifier.imported)
                  : 'default',
                local: specifier.local.name,
                typeOnly: specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
              }
              specifiers.set(specifierInfo, specifier)
              return [specifierInfo]
            }),
          }
          declarations.set(info, declaration)
          return info
        })
      },

      // The writer only removes a type-only specifier, to promote it, and
      // `CsfFile.removeImport` leaves those alone. The commit indexes the
      // file, which fails when it re-exports the type (`export type { fn }`).
      removeSpecifier(declarationInfo, specifierInfo) {
        const declaration = nodeOf(declarations, declarationInfo)
        const specifier = nodeOf(specifiers, specifierInfo)
        const kept = declaration.specifiers.filter(s => s !== specifier)
        if (kept.length === 0) {
          tools.removeStatement(editor, declaration)
        } else {
          tools.setImportSpecifiers(editor, declaration, kept)
        }
        editor.commit()
      },

      addSpecifier(declarationInfo, imported, binding) {
        const target = nodeOf(declarations, declarationInfo)
        if (!declarationInfo.typeOnly) return setImport(target.source.value, imported, binding)
        tools.setImportSpecifiers(
          editor,
          target,
          target.specifiers,
          imported === 'default' ? { default: binding } : { named: [importName(imported, binding)] },
        )
        editor.commit()
      },

      addImport(source, imported, binding, typeOnly) {
        if (!typeOnly) return setImport(source, imported, binding)
        const clause = imported === 'default' ? binding : `{ ${importName(imported, binding)} }`
        tools.insertAfterImports(
          editor,
          `import type ${clause} from ${tools.printString(source, editor.quote)}${editor.semicolons ? ';' : ''}`,
        )
        editor.commit()
      },

      parseStory(source, requiredNames) {
        snippet = parseStorySnippet(tools, source, requiredNames, fileName)
        return snippet.bindings
      },

      print(aliases) {
        if (!snippet) throw new Error('parseStory must run before print')
        const story = snippet.rename(aliases).trim()
        const stories = csf.stories.length

        // The story goes after everything else in the file, trailing comments
        // included, a blank line apart.
        const contentEnd = editor.code.trimEnd().length
        editor.edits.remove(contentEnd, editor.code.length)
        editor.edits.append(`${contentEnd > 0 ? '\n\n' : ''}${story}\n`)
        // Throws when the result does not parse or is not valid CSF.
        editor.commit()
        // A factory file skips an export that is not a factory story.
        if (csf.stories.length <= stories) throw new Error('The appended export is not indexed as a story')
        return editor.toString()
      },
    }
  }

  return { open }
}
