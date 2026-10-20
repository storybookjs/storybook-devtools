/**
 * `StoryFileEditor` for the csf-tools of storybookjs/storybook#36613
 * (Storybook 11), which hand out ESTree nodes and edit text.
 * `csf-writer-babel.ts` does the same with the Babel csf-tools.
 *
 * `CsfFile` supplies the file's stories and type annotations. The edits are
 * text edits in a `SourceEditor` of the same source, so code the writer
 * does not touch stays as written. That editor is not the `CsfFile`'s, so a
 * commit between import edits only parses the file again: it does not
 * index it as CSF, which a file can briefly fail while a type import is
 * promoted. `storybook/internal/csf-tools` is imported lazily so it does
 * not land in Next's server webpack bundle — see `src/story-index.ts` for
 * the `webpackIgnore` reasoning.
 */
import type { Binding, CsfFile, ESTree, SourceEditor } from 'storybook/internal/csf-tools'
import type {
  CsfWriterSyntax,
  ImportDeclarationInfo,
  ImportSpecifierInfo,
  StoryFileEditor,
} from './csf-writer'
import type { ExportStyle } from './story-generator'

type CsfTools = typeof import('storybook/internal/csf-tools')

/**
 * The CSF3 export style of a parsed CSF file, typed like its existing
 * stories — the first story's annotation or `satisfies` clause, else the
 * `Story` type alias when the file declares one, else untyped.
 */
function detectCsf3Style(csf: CsfFile): ExportStyle {
  for (const story of Object.values(csf._storyExports)) {
    if (story.type !== 'VariableDeclarator') continue
    if (story.id.type === 'Identifier' && story.id.typeAnnotation) {
      return { kind: 'csf3', annotation: csf._editor.source(story.id.typeAnnotation.typeAnnotation) }
    }
    if (story.init?.type === 'TSSatisfiesExpression') {
      return { kind: 'csf3', satisfies: csf._editor.source(story.init.typeAnnotation) }
    }
  }
  const declaresStoryType = csf._program.body.some(statement => {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    return (node?.type === 'TSTypeAliasDeclaration' || node?.type === 'TSInterfaceDeclaration') &&
      node.id.name === 'Story'
  })
  return declaresStoryType ? { kind: 'csf3', annotation: 'Story' } : { kind: 'csf3' }
}

/**
 * Every name a file declares at the top level, imports and types included,
 * and every name it exports.
 */
function topLevelNames(editor: SourceEditor): Set<string> {
  const names = new Set(editor.scopes.program.bindings.keys())
  for (const statement of editor.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (
      declaration?.type === 'TSTypeAliasDeclaration' ||
      declaration?.type === 'TSInterfaceDeclaration' ||
      declaration?.type === 'TSEnumDeclaration'
    ) {
      names.add(declaration.id.name)
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

export async function loadCsfWriterSyntax(): Promise<CsfWriterSyntax> {
  const tools = await import(/* webpackIgnore: true */ 'storybook/internal/csf-tools')

  function open(csf: CsfFile, existingCode: string, fileName: string): StoryFileEditor {
    const editor = new tools.SourceEditor(existingCode, fileName)
    const declarations = new WeakMap<ImportDeclarationInfo, ESTree.ImportDeclaration>()
    const specifiers = new WeakMap<ImportSpecifierInfo, ImportSpecifierNode>()
    let snippet: ReturnType<typeof parseStorySnippet> | undefined

    const nodeOf = <K extends object, V>(map: WeakMap<K, V>, info: K): V => {
      const node = map.get(info)
      if (!node) throw new Error('Stale import info')
      return node
    }

    // Each edit is committed before the next lookup, so every step reads the
    // file's imports as the previous step left them.
    const addToImports = (
      target: ESTree.ImportDeclaration,
      imported: string,
      binding: string,
    ) => {
      const named = imported === binding ? binding : `${imported} as ${binding}`
      tools.setImportSpecifiers(
        editor,
        target,
        target.specifiers,
        imported === 'default' ? { default: binding } : { named: [named] },
      )
      editor.commit()
    }

    return {
      topLevelNames: () => topLevelNames(editor),

      csf3Style: () => detectCsf3Style(csf),

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
                  ? (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value)
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
        addToImports(nodeOf(declarations, declarationInfo), imported, binding)
      },

      addImport(source, imported, binding, typeOnly) {
        const named = imported === binding ? binding : `${imported} as ${binding}`
        const clause = imported === 'default' ? binding : `{ ${named} }`
        tools.insertAfterImports(
          editor,
          `import ${typeOnly ? 'type ' : ''}${clause} from ${tools.printString(source, editor.quote)};`,
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

        // The story goes after everything else in the file, trailing comments
        // included, a blank line apart.
        const contentEnd = editor.code.trimEnd().length
        editor.edits.remove(contentEnd, editor.code.length)
        editor.edits.append(`${contentEnd > 0 ? '\n\n' : ''}${story}\n`)
        // Throws when the result does not parse.
        editor.commit()
        return editor.toString()
      },
    }
  }

  return { open }
}
