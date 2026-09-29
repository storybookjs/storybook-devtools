/**
 * Serves the story index everything server-side matches against: coverage's
 * "does this component have a story" decision (`src/coverage-dashboard.ts`)
 * and the overlay's `check-story` affordance.
 *
 * Two strategies behind one `getIndex()`:
 * - a real Storybook index built from the user's `stories` globs
 *   (`StoryIndexGenerator`), which respects custom titles and stories living
 *   outside the component's own directory;
 * - a scan for story files under `cwd`, synthesised into entries carrying
 *   their `importPath`, used when there is no Storybook project to build a
 *   generator from. `getIndex()` therefore always resolves to an index and
 *   callers never carry a "no index" branch.
 *
 * `storybook/internal/core-server`, `storybook/internal/common` and
 * `storybook/internal/csf-tools` are large; they are loaded lazily on the
 * first `getIndex()` call, never at module top level — same discipline as
 * `storybook-project.ts`.
 */
import * as path from 'path'
import { readFile, readdir, realpath, stat } from 'fs/promises'
import type { IndexerOptions } from 'storybook/internal/types'
import type { StoryIndexGenerator } from 'storybook/internal/core-server'
import {
  resolveStorybookProject,
  invalidateStorybookProject,
  type StorybookProjectInfo,
} from './storybook-project'
import type { StoryIndexEntryLike } from './utils/story-matching'
import { CSF_STORY_FILE_PATTERN } from './utils/story-files'

export interface StoryIndex {
  v: number
  entries: Record<string, StoryIndexEntryLike>
}

export interface StoryIndexServiceOptions {
  cwd: string
  logDebug: (...args: unknown[]) => void
}

export interface StoryIndexService {
  /** The root every entry's `importPath`/`componentPath` is relative to. */
  readonly cwd: string
  /**
   * The user's resolved Storybook project info, or `null` when the project
   * has no Storybook config. Kicked off at construction, awaited by the
   * handlers that need it (story generation, the docs URL).
   */
  readonly project: Promise<StorybookProjectInfo | null>
  /**
   * Returns the current story index, building or rebuilding it as needed.
   * Serves the last index the generator produced (or, with no generator,
   * synthesised scan entries) rather than resolving to nothing.
   */
  getIndex(): Promise<StoryIndex>
  /**
   * Marks the index stale so the next `getIndex()` call rebuilds it.
   * `filePath` narrows the rebuild to one story file when the generator is
   * already built; omit it to force a full rebuild. Pass `removed: true`
   * when the file no longer exists so its entries are dropped instead of
   * re-read — re-reading a missing file fails the whole index cycle and the
   * stale entries would survive.
   */
  invalidate(filePath?: string, options?: { removed?: boolean }): void
}

/** Directories the fallback scan never descends into. */
const SCAN_IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
])

/**
 * Lazily builds and memoises a `StoryIndexGenerator` for `options.cwd`'s
 * Storybook project. One instance per host (Vite/Rsbuild/Next) — see
 * `src/context.ts` and each host's setup.
 */
export function createStoryIndexService(
  options: StoryIndexServiceOptions,
): StoryIndexService {
  const { cwd, logDebug } = options
  // Reassigned on a full rebuild — see `invalidate()` below — so a fixed or
  // newly-added `.storybook` config is picked up without a process restart.
  let project = resolveStorybookProject(cwd, logDebug)

  let generatorPromise: Promise<StoryIndexGenerator | undefined> | undefined
  let generatorMissing = false
  /** Story files to invalidate on the next `getIndex()`, keyed to whether each was removed. */
  let pending = new Map<string, boolean>()
  let fileStamps = new Map<string, string>()
  let inFlight: Promise<StoryIndex> | undefined
  let lastIndex: StoryIndex | undefined
  let lastIndexError: string | undefined

  async function snapshotFiles(
    generator: StoryIndexGenerator,
  ): Promise<Map<string, string>> {
    const { StoryIndexGenerator: Generator } = await import(
      /* webpackIgnore: true */ 'storybook/internal/core-server'
    )
    Generator.clearFindMatchingFilesCache()
    const matches = await Generator.findMatchingFilesForSpecifiers(
      generator.specifiers, cwd, true,
    )
    const files = [
      ...new Set(matches.flatMap(([, entries]) => Object.keys(entries))),
    ]
    const stamps = new Map<string, string>()
    await Promise.all(files.map(async (file) => {
      try {
        const info = await stat(file)
        stamps.set(file, `${info.mtimeMs}:${info.ctimeMs}:${info.size}`)
      } catch {
        // A file can disappear between the glob and stat calls.
      }
    }))
    return stamps
  }

  async function buildGenerator(): Promise<StoryIndexGenerator | undefined> {
    const projectInfo = await project
    if (!projectInfo) return undefined

    try {
      const [
        { StoryIndexGenerator: StoryIndexGeneratorClass },
        { normalizeStories },
        { loadCsf },
      ] =
        await Promise.all([
          // `webpackIgnore` keeps these off Next's server webpack bundle —
          // without it, a string-literal dynamic import is still
          // statically bundled (not just lazily run), and `csf-tools`
          // transitively pulls in `oxc-resolver`'s native `.node` binding,
          // which webpack can't parse as a module and fails the build.
          // Harmless elsewhere: Vite/Rollup don't recognize the comment
          // and just run a normal dynamic import.
          import(/* webpackIgnore: true */ 'storybook/internal/core-server'),
          import(/* webpackIgnore: true */ 'storybook/internal/common'),
          import(/* webpackIgnore: true */ 'storybook/internal/csf-tools'),
        ])

      const workingDir = cwd
      const configDir = projectInfo.configDir
      const specs = normalizeStories(projectInfo.storiesGlobs, {
        configDir,
        workingDir,
      })

      // Storybook's own CSF indexer lives in an unexported preset, so
      // driving `StoryIndexGenerator` from outside its dev-server bootstrap
      // means supplying an equivalent one.
      const csfIndexer = {
        test: CSF_STORY_FILE_PATTERN,
        createIndex: async (fileName: string, opts: IndexerOptions) =>
          loadCsf(await readFile(fileName, 'utf8'), {
            ...opts,
            fileName,
          }).parse().indexInputs,
      }

      // `StoryIndexGenerator.findMatchingFilesCache` is a static Map shared
      // by every instance in the process, keyed on the stories specifier and
      // working dir — not on the instance. A second service built in the
      // same process (a dev-server restart, or a second host/context) would
      // otherwise inherit the first instance's file list, missing any story
      // file created or deleted in between.
      StoryIndexGeneratorClass.clearFindMatchingFilesCache()

      const gen = new StoryIndexGeneratorClass(specs, {
        workingDir,
        configDir,
        indexers: [csfIndexer],
        docs: {},
      })
      fileStamps = await snapshotFiles(gen)
      await gen.initialize()
      return gen
    } catch (error) {
      logDebug(
        '[story-index] Failed to build the Storybook story index generator:',
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    }
  }

  async function ensureGenerator(): Promise<StoryIndexGenerator | undefined> {
    generatorPromise ??= buildGenerator()
    const generator = await generatorPromise
    generatorMissing = !generator
    return generator
  }

  function toImportPath(filePath: string): string {
    const rel = path.isAbsolute(filePath)
      ? path.relative(cwd, filePath)
      : filePath
    const posixRel = rel.split(path.sep).join('/')
    return posixRel.startsWith('.') ? posixRel : `./${posixRel}`
  }

  /**
   * Entries synthesised from a story-file scan under `cwd`. They carry only
   * `importPath`: `findStoryCandidates` matches those against a component
   * by path base and by file name, which covers both a story beside its
   * component and one in a stories directory. A synthesised `componentPath`
   * would instead decide membership outright, so a same-named file next to
   * the story could hide a real match.
   */
  async function scanIndex(): Promise<StoryIndex> {
    const entries: Record<string, StoryIndexEntryLike> = {}

    const visited = new Set<string>()
    const walk = async (dir: string): Promise<void> => {
      let contents
      try {
        const physicalPath = await realpath(dir)
        if (visited.has(physicalPath)) return
        visited.add(physicalPath)
        contents = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of contents) {
        if (item.name.startsWith('.')) continue
        const full = path.join(dir, item.name)
        const isDirectory = item.isDirectory() ||
          (item.isSymbolicLink() && await stat(full).then(
            info => info.isDirectory(),
            () => false,
          ))
        if (isDirectory) {
          if (SCAN_IGNORED_DIRS.has(item.name)) continue
          await walk(full)
          continue
        }
        if (!CSF_STORY_FILE_PATTERN.test(item.name)) continue

        const importPath = toImportPath(full)
        const id = `${importPath
          .replace(/^\.\//, '')
          .replace(/[^a-zA-Z0-9]+/g, '-')
          .toLowerCase()}--story`

        entries[id] = { id, type: 'story', importPath }
      }
    }

    await walk(cwd)
    return { v: 5, entries }
  }

  return {
    cwd,
    get project() {
      return project
    },
    getIndex() {
      // Coverage and check-story can request the same index concurrently.
      inFlight ??= readIndex().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    invalidate(filePath?: string, options?: { removed?: boolean }) {
      if (!filePath || generatorMissing) {
        generatorPromise = undefined
        fileStamps = new Map()
        pending = new Map()
        lastIndex = undefined
        invalidateStorybookProject(cwd)
        project = resolveStorybookProject(cwd, logDebug)
        return
      }
      pending.set(filePath, options?.removed ?? false)
    },
  }

  async function readIndex(): Promise<StoryIndex> {
    const generator = await ensureGenerator()
    if (!generator) return scanIndex()

    // webpack/rspack only watch app dependencies, and Next's route runs
    // separately from its compiler. Check the actual Storybook globs on
    // requests so external story edits work on every host without timers.
    const current = await snapshotFiles(generator)
    for (const [file, stamp] of current) {
      if (fileStamps.get(file) !== stamp) pending.set(file, false)
    }
    for (const file of fileStamps.keys()) {
      if (!current.has(file)) pending.set(file, true)
    }
    fileStamps = current
    for (const [filePath, removed] of pending) {
      generator.invalidate(toImportPath(filePath), removed)
    }
    pending = new Map()

    try {
      lastIndex = (await generator.getIndex()) as StoryIndex
      lastIndexError = undefined
      return lastIndex
    } catch (error) {
      // `getIndex()` throws `MultipleIndexingError` when ANY indexed file
      // failed to parse — it does not return a partial index with just
      // the bad file skipped, so one broken CSF file takes down the whole
      // index for this cycle. Serve the last index the generator produced
      // (which may be stale until every file parses); a
      // fixed file recovers on the next invalidate()+getIndex() cycle.
      // The same failure repeats on every watch event, so log it only
      // when the message changes.
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastIndexError) {
        lastIndexError = message
        logDebug('[story-index] getIndex() failed:', message)
      }
      return lastIndex ?? scanIndex()
    }
  }
}
