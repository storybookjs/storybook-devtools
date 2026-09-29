/**
 * Single definition of "this file is a story file", shared by every place
 * that needs one: the unplugin's instrumentation `exclude` globs and its
 * `watchChange` invalidation filter (`src/unplugin.ts`), and the CSF
 * indexer's `test` regex plus the fallback scan (`src/story-index.ts`).
 */

/** The name segment Storybook treats as a story file marker. */
const STORY_INFIXES = ['stories', 'story'] as const

/** Script extensions the CSF indexer and the generated story files use. */
const STORY_SCRIPT_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js', 'mjs'] as const

/**
 * Matches `*.stories.*`/`*.story.*` and bare `stories.*`/`story.*` files,
 * whatever the final extension — the same shapes {@link STORY_EXCLUDE_GLOBS}
 * carves out of instrumentation.
 */
export const STORY_FILE_PATTERN = new RegExp(
  `(?:^|[./])(?:${STORY_INFIXES.join('|')})\\.[^./]+$`,
)

/** The story-file shapes instrumentation skips. */
export const STORY_EXCLUDE_GLOBS = STORY_INFIXES.flatMap((infix) => [
  `**/*.${infix}.*`,
  `**/${infix}.*`,
])

/**
 * {@link STORY_FILE_PATTERN} narrowed to the script extensions a CSF indexer
 * can parse — `.mdx` and other non-script story files are not CSF.
 */
export const CSF_STORY_FILE_PATTERN = new RegExp(
  `(?:^|[./])(?:${STORY_INFIXES.join('|')})\\.(?:${STORY_SCRIPT_EXTENSIONS.join('|')})$`,
)
