// `tsc --noEmit` for the installed Storybook. The plugin reads syntax with
// Storybook's Babel (`src/**/*-babel.ts`: Storybook 10, and 11 prereleases
// without storybookjs/storybook#36613) or with its ESTree csf-tools
// (`src/**/*-estree.ts`). Only one of the two has its types installed, so
// the other one's diagnostics are left out, picked the way the plugin picks
// at runtime: by whether csf-tools have `parseModule`.
import ts from 'typescript'

const csfTools = await import('storybook/internal/csf-tools')
const installed = typeof csfTools.parseModule === 'function' ? 'estree' : 'babel'
const other = installed === 'estree' ? 'babel' : 'estree'
const skipped = new RegExp(`/src/.*-${other}\\.ts$`)

const config = ts.getParsedCommandLineOfConfigFile(
  'tsconfig.json',
  { noEmit: true },
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  },
)
const program = ts.createProgram({ rootNames: config.fileNames, options: config.options })
const diagnostics = [
  ...config.errors,
  ...ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => !diagnostic.file || !skipped.test(diagnostic.file.fileName)),
]

const paths = {
  babel: 'the Babel path (csf-tools without `parseModule`)',
  estree: 'the ESTree path (csf-tools with `parseModule`)',
}
console.info(`Type-checking ${paths[installed]}; skipping src/**/*-${other}.ts.`)
if (diagnostics.length > 0) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }),
  )
  process.exit(1)
}
