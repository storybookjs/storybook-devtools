/**
 * `StoryFileEditor` for the Babel csf-tools of Storybook 10 (and of 11
 * prereleases without storybookjs/storybook#36613): edits the Babel AST of
 * `csf._ast` and prints it with `printCsf`, which reprints through recast.
 * #36613 removes `storybook/internal/babel`; `csf-writer-estree.ts` does
 * the same there. This file can go when the plugin drops Storybook 10.
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
import type { CsfFile } from 'storybook/internal/csf-tools'
import type {
  CsfWriterSyntax,
  ImportDeclarationInfo,
  ImportSpecifierInfo,
  StoryFileEditor,
} from './csf-writer'
import type { ExportStyle } from './story-generator'

type BabelTypes = typeof t
type BabelModule = typeof import('storybook/internal/babel')

/** Pick the quote style recast should use for nodes it has to print fresh. */
function detectQuoteStyle(code: string): 'single' | 'double' {
  const single = (code.match(/from '[^']*'/g) ?? []).length
  const double = (code.match(/from "[^"]*"/g) ?? []).length
  return double > single ? 'double' : 'single'
}

/**
 * The CSF3 export style of a parsed CSF file, typed like its existing
 * stories — the first story's annotation or `satisfies` clause, else the
 * `Story` type alias when the file declares one, else untyped.
 */
function detectCsf3Style(
  t: BabelTypes,
  csf: {
    _storyExports: Record<string, t.Node>
    _ast: { program: t.Program }
  },
  code: string,
): ExportStyle {
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

// A variable, not a literal: a bundler that builds the plugin from source,
// such as Vite bundling a playground's config, resolves a literal `import()`
// up front and fails on a Storybook without this subpath.
const BABEL_ENTRY = 'storybook/internal/babel'

export async function loadCsfWriterSyntax(): Promise<CsfWriterSyntax> {
  const [{ printCsf }, { babelParse, types: t, traverse }] = await Promise.all([
    import(/* webpackIgnore: true */ 'storybook/internal/csf-tools'),
    import(/* webpackIgnore: true */ /* @vite-ignore */ BABEL_ENTRY) as Promise<BabelModule>,
  ])

  function open(
    csf: CsfFile,
    existingCode: string,
    _fileName: string,
    lineEnding: '\r\n' | '\n',
  ): StoryFileEditor {
    const program = csf._ast.program
    const declarations = new WeakMap<ImportDeclarationInfo, t.ImportDeclaration>()
    const specifiers = new WeakMap<ImportSpecifierInfo, t.ImportDeclaration['specifiers'][number]>()
    let snippet: t.File | undefined

    const nodeOf = <K extends object, V>(map: WeakMap<K, V>, info: K): V => {
      const node = map.get(info)
      if (!node) throw new Error('Stale import info')
      return node
    }

    return {
      topLevelNames: () => collectTopLevelBindings(t, program),

      exportStyle: () => csf._metaIsFactory
        ? { kind: 'factory', metaName: csf._metaVariableName ?? 'meta' }
        : detectCsf3Style(t, csf, existingCode),

      importsFrom(source) {
        return program.body
          .filter((node): node is t.ImportDeclaration =>
            t.isImportDeclaration(node) && node.source.value === source)
          .map(declaration => {
            const info: ImportDeclarationInfo = {
              typeOnly: declaration.importKind === 'type',
              hasDefault: declaration.specifiers.some(s => t.isImportDefaultSpecifier(s)),
              hasNamespace: declaration.specifiers.some(s => t.isImportNamespaceSpecifier(s)),
              specifiers: declaration.specifiers.flatMap(specifier => {
                if (t.isImportNamespaceSpecifier(specifier)) return []
                const named = t.isImportSpecifier(specifier)
                const specifierInfo: ImportSpecifierInfo = {
                  kind: named ? 'named' : 'default',
                  imported: named
                    ? (t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value)
                    : 'default',
                  local: specifier.local.name,
                  typeOnly: named && specifier.importKind === 'type',
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
        declaration.specifiers = declaration.specifiers.filter(s => s !== specifier)
        if (declaration.specifiers.length === 0) {
          program.body.splice(program.body.indexOf(declaration), 1)
        }
      },

      addSpecifier(declarationInfo, imported, binding) {
        const target = nodeOf(declarations, declarationInfo)
        const specifier = imported === 'default'
          ? t.importDefaultSpecifier(t.identifier(binding))
          : t.importSpecifier(t.identifier(binding), t.identifier(imported))
        if (imported === 'default') target.specifiers.unshift(specifier)
        else target.specifiers.push(specifier)
      },

      addImport(source, imported, binding, typeOnly) {
        const specifier = imported === 'default'
          ? t.importDefaultSpecifier(t.identifier(binding))
          : t.importSpecifier(t.identifier(binding), t.identifier(imported))
        const declaration = t.importDeclaration([specifier], t.stringLiteral(source))
        if (typeOnly) declaration.importKind = 'type'
        insertImport(t, program, declaration)
      },

      parseStory(source) {
        // Keep snippet line numbers for recast's inter-statement spacing.
        const parsed = babelParse(`\n\n${source}`)
        snippet = parsed
        const bindings = new Set<string>()
        traverse(parsed, {
          Scope(scopePath) {
            for (const name of Object.keys(scopePath.scope.bindings)) bindings.add(name)
          },
        })
        return bindings
      },

      print(aliases) {
        if (!snippet) throw new Error('parseStory must run before print')
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

        const { code } = printCsf(csf, {
          quote: detectQuoteStyle(existingCode),
          lineTerminator: lineEnding,
        })
        babelParse(code)
        return code.endsWith('\n') ? code : `${code}\n`
      },
    }
  }

  return { open }
}
