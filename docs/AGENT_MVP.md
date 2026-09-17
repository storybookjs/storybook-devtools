# Runtime MCP MVP

Runtime MCP answers questions about the application currently open in a browser.
Storybook MCP supplies component documentation, story previews and tests. Use both.

## Enable

Vite (React/Vue/Nuxt) and Rsbuild accept `agent` on the existing plugin:

```ts
componentHighlighter({
  agent: { token: process.env.STORYBOOK_DEVTOOLS_MCP_TOKEN! },
})
```

For Next, pass `agent` to `createStorybookDevtoolsRoute`, where the live RPC hub
exists, rather than to `withStorybookDevtools`.

Set a non-empty token in the dev-server environment. Configure an HTTP MCP
client with the matching `Authorization: Bearer <token>` header and a loopback
`Origin` header (for example `http://127.0.0.1:5173`). Endpoint paths:

| Host | Application runtime MCP |
| --- | --- |
| Vite / Nuxt / Rsbuild | `/__storybook-devtools/mcp` on the app server |
| Next | `/__devframes/storybook-devtools/mcp` (uses the configured hub base) |

The feature is opt-in. The separate endpoint exposes only three read-only tools,
without the hub's terminals, story-writing actions, or shared-state resources.
It uses Devframe's `ctx.agent.registerTool` and `createMcpFetchHandler` with a
dedicated agent context whose handlers query the existing application RPC hub.
It does not rely on automatic MCP mounting, `devframe connect` discovery, or
WebMCP. This accommodates the installed Devframe 0.9.12 / hub 0.9.5 APIs.

Open the app and authorize its DevTools connection before requesting runtime
data. Connecting MCP alone cannot render the app or populate component data.
Playgrounds use `playground-only` unless the environment overrides the token;
that fixed value is for local examples/E2E, not shared environments.

## Agent workflow

1. Call `storybook-devtools_get-app-context` with `{}`. Choose a page by URL and
   `pageId`. Each page includes component source identities and its selected
   instance ID. Props are omitted.
2. Call `storybook-devtools_inspect-component` with `{ pageId, instanceId }`.
   Use actual props as reproduction evidence and matching stories as candidates.
3. Call `storybook-devtools_get-story-gaps` with `{ pageId }` to find mounted
   components without matching stories, grouped by source identity.
4. Use the separate Storybook MCP for docs, previews and tests. The suggested
   `/mcp` endpoint returned by runtime tools is explicitly unverified: projects
   can customize that path or have no MCP addon installed.

Calls query currently connected browser peers with a two-second timeout per
peer, in parallel. No cached registry is used. A missing/closed page or unmounted
instance is an error. Instance IDs are only unique within a page. Page IDs change
on reload; discover again afterward.

### What this proves

In the React demo, runtime MCP discovered 26 mounted instances and returned the
manually selected `TaskList` with `count: 3`. It also identified the live Filter
button as `Button.tsx`, with `{ variant: "secondary", children: "Filter" }`.
Storybook MCP resolved that exact source path with `stories-find-by-component`,
returned the Button API via `docs-show`, and passed the linked story via
`test-run`. The existing story renders `EDITED-BY-QA`, not the Filter state;
the runtime tool deliberately reports a candidate, without claiming coverage.

The useful addition is page/instance/selection identity plus current app props.
Source-to-story lookup itself already exists in Storybook MCP; this MVP reuses
the devtool's index to annotate live usage, rather than establishing a second
authoritative component documentation or import-graph service. Missing-story
results are priorities for investigation, not a complete coverage audit.

## Storybook MCP in this repository

`@storybook/addon-mcp@10.6.0` is installed in all five playgrounds with Storybook.
React 18 intentionally has no Storybook config and remains the fallback case.
React 19 enables the experimental components manifest for documentation tools.
Other renderers expose the toolsets their installed framework supports; addon
presence does not imply documentation or test-runner support.
React, Vue and Nuxt have separate `vitest.config.ts` files, so the Storybook
`test-run` tool finds an actual browser test project without starting the app's
DevTools plugins. The Next webpack and Rsbuild configurations do not expose this
Vitest test tool. See the [Storybook Vitest setup](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon).

From `playground/react`, run `pnpm storybook`. Storybook MCP is then available
at `http://localhost:6006/mcp`. Run
`STORYBOOK_FEATURE_AI_CLI=1 pnpm exec storybook ai --help` in that directory to
discover its tools and argument schemas. Runtime MCP stays on the app server.

### Ready-to-use Codex demo

This repository's `.codex/config.toml` connects the React demo's runtime MCP on
6173 and Storybook MCP on 6016, with the local playground token. Start them in
separate terminals (after `pnpm build`):

```sh
E2E_STORYBOOK_PORT=6016 pnpm --dir playground/react dev --host 127.0.0.1 --port 6173
pnpm --dir playground/react storybook --port 6016 --no-open
```

Open `http://127.0.0.1:6173` and start a new Codex task/reload its MCP connections.
Keep token overrides in the dev server and client configuration aligned. The
project config uses the documented
[Codex HTTP MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Evidence limits

- DOM-connected does not mean viewport-visible; offscreen components can appear.
- Only instrumented client components are included. No React Server Components,
  hook state, context values, parent tree, network history, or unvisited routes.
- Props use the existing lossy serializer; complex values can become markers.
  They reflect the latest serialized render, not a transactionally frozen app.
  Each page is sampled independently.
- At most 200 instances per page are listed. `truncated` and `totalInstances`
  reveal partial results. Exact inspection can target an instance beyond the
  list if its ID is known. Props over 32,000 serialized characters are omitted
  with `propsTruncated: true`.
- URLs omit query strings/fragments. Explicit prop inspection can still return
  application data; serialization is not a redaction mechanism.
- Matching uses existing component-path/filename/title logic. Story presence
  does not prove prop-state coverage, correctness or test success. `indexSource`
  distinguishes Storybook indexing, file scanning and stale data. Stale/unknown
  indexes cannot establish gaps.
- `unavailableClients` can include non-app DevTools peers with no snapshot
  handler as well as unresponsive peers. `no-connected-app` means no responding
  trusted application; it does not mean the project has no components.
- This MVP does not create stories, edit props, or expose recordings. Those need
  separate action contracts and verified acknowledgments.
- Vite/Nuxt/Rsbuild additionally require a loopback socket peer and bound request
  bodies to 16 KiB. Next's Fetch route has no socket-peer API and relies on bearer
  and Origin checks; run that dev server on loopback. Neither setup is intended
  as a hosted, multi-user MCP service.

## Validation

`src/agent.test.ts` uses the real Devframe MCP protocol adapter with fixture
snapshots: schemas, annotations, no mutations/resources, page selection, missing
instances, story matching, provenance and peer timeouts.
`e2e/common-agent-suite.ts` exercises HTTP MCP through actual browser RPC on all
six playgrounds, including selection, props, two-page isolation, close handling,
and bearer rejection. The serial Storybook suite checks the separate Storybook
MCP tool list while launching each configured framework, and executes the
generated story through MCP `test-run` on React, Vue and Nuxt.

Build before tests. If standard ports are occupied, set `E2E_PORT_OFFSET=1000`
for either Playwright command to use 6173–6178. Set `E2E_STORYBOOK_PORT=6016` to
move the serial suite's Storybook server too. Keep the chosen port free.

### Validation observations

Final commands and results (2026-09-17):

| Command | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm test --run` | 406 passed, 32 files |
| `pnpm typecheck` | Passed |
| `E2E_PORT_OFFSET=2000 E2E_STORYBOOK_PORT=6026 pnpm exec playwright test --workers=1 --reporter=line` | 185 passed |
| `E2E_PORT_OFFSET=2000 E2E_STORYBOOK_PORT=6026 pnpm exec playwright test --config=playwright.storybook.config.ts --reporter=line` | 6 passed |

- Build, type checking and all 406 unit tests passed. Tests were introduced
  before implementation; the runtime-tool test first failed on the missing
  module. A real story parse failure also verifies stale-index provenance and
  recovery.
- The six-host Storybook integration suite passed, including real disk writes,
  interaction playback and MCP story tests on the three supported Vite hosts.
  The new `test-run` assertion first failed with `Failed to start Vitest` before
  the playground test configs were corrected. Vue also needed its SFC plugin.
- Manual verification used normal MCP initialization, app component selection,
  source-to-story resolution, documentation, preview and a passing Button test
  with accessibility enabled. No visual/UI styling changes were made.
- Earlier four-worker browser runs failed with server/connection errors; the
  first Storybook integration run also had two disconnects. The latter paths
  passed three repetitions each and subsequent complete runs. Their intermittent
  cause has not been established; parallel execution is not claimed clean.
- Devframe emits a non-fatal duplicate `open-in-editor` registration warning
  (`DF0021`) in these playgrounds. The dependency graph includes Devframe 0.9.12
  and 0.9.5 peer contexts. This MVP does not establish whether those warnings and
  the intermittent failures are related.
