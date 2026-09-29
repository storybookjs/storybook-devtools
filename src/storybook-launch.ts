/**
 * Builds the command used to launch Storybook's dev server, matching the
 * package manager the user's project actually uses instead of always
 * shelling out through `npx`. Backed by `storybook/internal/common`'s
 * `JsPackageManagerFactory`, loaded lazily (dynamic `import()`, never at
 * module top level of a host plugin entry — see `storybook-project.ts` for
 * why: `webpackIgnore` keeps this off Next's server webpack bundle, since a
 * string-literal dynamic import is otherwise still statically bundled and
 * the module transitively pulls in a native binding webpack can't parse).
 */

/**
 * Splits a package manager's command string into `{ command, args }` for a
 * PTY session. `getPackageCommand` only ever joins plain tokens (no quoted
 * or space-containing arguments), so a plain whitespace split round-trips
 * it exactly — including Yarn Classic's `--` separator before the
 * storybook args.
 */
function splitCommand(full: string): { command: string; args: string[] } {
  const tokens = full.trim().split(/\s+/)
  const [command, ...args] = tokens
  if (!command) throw new Error(`Empty package manager command: "${full}"`)
  return { command, args }
}

const NPX_FALLBACK = (port: string): { command: string; args: string[] } => ({
  command: 'npx',
  args: ['storybook', 'dev', '-p', port, '--no-open'],
})

/**
 * Detects the project's package manager and asks its `JsPackageManager`
 * instance for the command that runs a local binary (`getPackageCommand`),
 * rather than re-deriving per-package-manager invocation rules ourselves —
 * that mapping (e.g. Yarn Classic's `--` separator) is Storybook's to
 * maintain. Falls back to `npx` when detection throws — e.g. no lockfile and
 * no package manager on PATH.
 */
export async function resolveStorybookDevCommand({
  cwd,
  port,
  logDebug,
}: {
  cwd: string
  port: string
  logDebug: (...args: unknown[]) => void
}): Promise<{ command: string; args: string[] }> {
  try {
    const { JsPackageManagerFactory } = await import(
      /* webpackIgnore: true */ 'storybook/internal/common'
    )
    const packageManager = JsPackageManagerFactory.getPackageManager({}, cwd)
    const full = packageManager.getPackageCommand([
      'storybook',
      'dev',
      '-p',
      port,
      '--no-open',
    ])
    return splitCommand(full)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logDebug(`Package manager detection failed, falling back to npx: ${msg}`)
    return NPX_FALLBACK(port)
  }
}

/**
 * Environment for the spawned Storybook process: the host dev server's own
 * env (so PATH, package-manager and Node settings carry over) with
 * `STORYBOOK=true` set — the playgrounds' bundler configs read it to keep
 * this plugin out of Storybook's builder, which loads the same config file
 * — and `PORT` pinned to Storybook's port. Storybook's CLI lets a `PORT` env
 * var override `-p`, and Next's dev server exports its own port under that
 * name, so an inherited value makes the child bind the app's port and never
 * come up at `storybookUrl`. Pinned rather than deleted because the PTY host
 * layers the caller's env over its own copy of `process.env`, so only an
 * explicit value can displace the inherited one.
 */
export function buildStorybookEnv(
  base: NodeJS.ProcessEnv,
  port: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value
  }
  env['STORYBOOK'] = 'true'
  env['PORT'] = port
  return env
}
