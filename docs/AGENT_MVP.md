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

The feature is opt-in. The separate endpoint exposes only four read-only tools,
without the hub's terminals, story-writing actions, or shared-state resources.
It uses Devframe's `ctx.agent.registerTool` and `createMcpFetchHandler` with a
dedicated agent context whose handlers query the existing application RPC hub.
It does not rely on automatic MCP mounting, `devframe connect` discovery, or
WebMCP. The Devframe 1.1.0 adapter loads its implementation from `@devframes/agentic`,
which this package declares as a runtime dependency. Keep the public imports
from `devframe/adapters/mcp`; no direct SDK integration is needed.
Next awaits the current hub startup promise before creating this isolated context,
and production routes return 404 without allocating a development sidecar.

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

For React, call `storybook-devtools_get-component-tree` with `{ pageId }` to
discover the hierarchy of components currently rendered anywhere in the page.
There is no viewport filter. Connected offscreen and CSS-hidden DOM are included.
React 18/19 on Vite, Rsbuild and Next are supported; Vue/Nuxt return
`status: "unsupported-framework"`. App discovery advertises
`componentTreeSupported` per page.

The result is a compact, parent-first forest:

```json
{
  "status": "ok",
  "scope": "rendered-page",
  "framework": "react",
  "rootIds": ["app:0"],
  "nodes": [
    { "id": "app:0", "parentId": null, "meta": { "componentName": "App", "sourceId": "app", "filePath": "/app/App.tsx" } },
    { "id": "card:1", "parentId": "app:0", "meta": { "componentName": "TaskCard", "sourceId": "card", "filePath": "/app/TaskCard.tsx" } }
  ],
  "totalNodes": 2,
  "truncated": false
}
```

`parentId` refers to the nearest instrumented React ancestor, even for portals;
it is not a DOM parent or necessarily the component that authored a JSX value.
Transparent wrappers and fragments remain when their descendants have connected
DOM output. Text output counts; a component returning `null` with no rendered
descendants does not. The existing wrapper deduplication and instance IDs are
preserved. Exact inspection accepts these IDs, including wrappers with no
highlighter anchor of their own (`isRendered: true`, `isConnected: false`).

Each request samples the committed React trees and current DOM connection state.
At most 500 nodes are returned, with `totalNodes` and `truncated` describing the
complete count and omitted tail. Parents precede children, so truncation never
leaves a returned node pointing to an omitted parent. Props are excluded; use
`inspect-component` for a chosen instance.

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
The React tree additionally returned 26 rendered instances with actual ancestry;
opening the modal added seven instances under `Modal → TaskForm`, and closing it
returned to 26 with existing IDs preserved. These relationships come from the
running app, which Storybook's source/story catalog cannot establish.
Source-to-story lookup itself already exists in Storybook MCP; this MVP reuses
the devtool's index to annotate live usage, rather than establishing a second
authoritative component documentation or import-graph service. Missing-story
results are priorities for investigation, not a complete coverage audit.

## Storybook MCP in this repository

`@storybook/addon-mcp@11.0.0-alpha.1` is installed in all five playgrounds with Storybook.
React 18 intentionally has no Storybook config and remains the fallback case.
React 19 enables the experimental components manifest for documentation tools.
Other renderers expose the toolsets their installed framework supports; addon
presence does not imply documentation or test-runner support.
React, Vue and Nuxt have separate `vitest.config.ts` files, so the Storybook
`test-run` tool finds an actual browser test project without starting the app's
DevTools plugins. Storybook 11 supplies preview annotations through the test
plugin, so these configs do not reference the removed `vitest.setup.ts` files. The Next webpack and Rsbuild configurations do not expose this
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
STORYBOOK_E2E_URL=http://localhost:6016 pnpm --dir playground/react dev --host 127.0.0.1 --port 6173
BROWSER=none pnpm --dir playground/react storybook --port 6016
```

Open `http://127.0.0.1:6173` and start a new Codex task/reload its MCP connections.
Keep token overrides in the dev server and client configuration aligned. The
project config uses the documented
[Codex HTTP MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Evidence limits

- DOM-connected does not mean viewport-visible; offscreen components can appear.
- Only instrumented client components are included. No React Server Components,
  hook state, context values, network history, or unvisited routes. The React
  component tree skips uninstrumented ancestors; Vue/Nuxt have no tree yet.
- React hierarchy depends on the existing private Fiber integration. React 18/19
  are exercised, but future React internals may require adaptation. The tree is
  capped at 500 nodes; sampling still traverses the committed roots, so the cap
  bounds response size rather than traversal cost.
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

### Devframe 1.1 / current main integration (2026-09-29)

Merged `main` at `a6a421e`, retaining the runtime tools and React tree. The
runtime now declares `@devframes/agentic@1.1.0`; Storybook MCP playgrounds use
`11.0.0-alpha.1` alongside the rest of Storybook. Next awaits the asynchronous
hub startup, and skips all hub/sidecar setup in production. Dedicated browser
Vitest configs use Storybook 11's preview setup without deleted setup files.

Validated locally with Node `22.21.1` and pnpm `10.33.0` (CI uses Node 24):

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm build` | Passed |
| `pnpm test --run` | 502 passed, 40 files |
| `pnpm typecheck` | Passed |
| `PLAYWRIGHT_PORT_OFFSET=2000 STORYBOOK_E2E_URL=http://localhost:6026 pnpm exec playwright test --workers=2 --reporter=line` | 211 passed |
| `PLAYWRIGHT_PORT_OFFSET=2000 STORYBOOK_E2E_URL=http://localhost:6026 pnpm exec playwright test --config=playwright.storybook.config.ts --reporter=line` | 6 passed |

Regression assertions failed before the fixes: the MCP implementation dependency
was undeclared, and constructing a production Next route still allocated a
sidecar port. Both pass afterward. Interactive React verification opened the
coverage inspector on TaskList (`count: 3`); HTTP MCP returned matching props
and a 26-node React tree containing three TaskCards. The serial suite also
executed the generated interaction story through MCP on React, Vue and Nuxt.

The React tree extension has five traversal unit tests covering fragments,
portals, transparent ancestors, text/null output, multiple roots, connection
changes and bounded output. Protocol tests cover tree responses, unsupported
runtimes and inspecting rendered wrappers without a DOM anchor. Shared browser
tests verify real React ancestry, offscreen membership, repeated instances,
stable IDs and modal mount/unmount on all four React hosts, plus explicit
unsupported responses on Vue/Nuxt. Portal/fragment edge cases are unit fixtures,
not additional browser fixtures.

Historical React tree validation (2026-09-17, before the Devframe 1.1 / Storybook 11 migration; the old E2E environment names below no longer apply):

| Command | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm test --run` | 413 passed, 33 files |
| `pnpm typecheck` | Passed |
| `E2E_PORT_OFFSET=3000 E2E_STORYBOOK_PORT=6036 pnpm exec playwright test --grep 'Runtime MCP' --workers=1 --reporter=line` | 18 passed |
| `E2E_PORT_OFFSET=3000 E2E_STORYBOOK_PORT=6036 pnpm exec playwright test --workers=1 --reporter=line` | 191 passed |

New tests failed before implementation (missing traversal module / unknown MCP
tool) and passed afterward. Interactive verification on the React demo confirmed
26 → 33 → 26 tree nodes when opening and closing the modal, with retained IDs
unchanged. The Storybook integration results below belong to the committed MVP;
the tree extension does not change Storybook indexing, generation or launching.

`src/agent.test.ts` uses the real Devframe MCP protocol adapter with fixture
snapshots: schemas, annotations, no mutations/resources, page selection, missing
instances, story matching, provenance and peer timeouts.
`e2e/common-agent-suite.ts` exercises HTTP MCP through actual browser RPC on all
six playgrounds, including selection, props, two-page isolation, close handling,
and bearer rejection. The serial Storybook suite checks the separate Storybook
MCP tool list while launching each configured framework, and executes the
generated story through MCP `test-run` on React, Vue and Nuxt.

Build before tests. If standard ports are occupied, set `PLAYWRIGHT_PORT_OFFSET=1000`
for either Playwright command to use 6173–6178. Set `STORYBOOK_E2E_URL=http://localhost:6016` to
move the serial suite's Storybook server too. Keep the chosen port free.

### Validation observations

Initial MVP commands and results (2026-09-17, commit `33e185a`):

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
