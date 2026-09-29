# Opportunities unlocked by the devframe foundation

> Historical design notes. Version references and proposed work describe the
> original investigation; see [Architecture](../ARCHITECTURE.md) and
> [Supported frameworks](../SUPPORTED_FRAMEWORKS.md) for current behavior.

The plugin now runs on devframe 0.9 (`src/devframe.ts` holds the definition; Vite mounts it
through `@vitejs/devtools-kit`'s `createPluginFromDevframe`). Beyond the host-portability
work already planned in the phased migration
([PR #18](https://github.com/storybookjs/vite-plugin-experimental-storybook-devtools/pull/18)),
the new foundation exposes capabilities the kit-0.3 surface had no equivalent for. Each item
below is independently adoptable; none blocks the phased plan.

## High value

### 1. Agent-native surface (MCP) over the existing RPC table

Devframe RPC functions opt into agent exposure with an `agent: { description, safety }`
field (plus `jsonSerializable: true`); the definition then serves them as MCP tools through
`createMcpServer` or a hub's aggregate MCP endpoint — no separate MCP server to build or
maintain. Natural candidates:

- `get-coverage` (read) — "which components lack stories" as a queryable tool
- `check-story` (read), `storybook-status` (read)
- `create-story` (action) — agent-driven story generation from live registry props

This turns the devtool into a shared source of truth for both the panel UI and coding
agents, and overlaps directly with the Storybook MCP addon's goals — worth aligning the two
tool vocabularies before exposing. Requires adding argument/return schemas (see item 6),
since MCP tools speak validated JSON.

### 2. `createProcessLauncher` for the Storybook process

The kit ships a composed launcher-dock primitive: it registers a launcher card, binds a
command, spawns a child process into a terminal session, streams a startup digest, and — via
`serve.onReady` — swaps the card for an iframe embedding the served URL once it's up. That
is almost exactly the hand-rolled `start-storybook` + `get-terminal-logs` + panel-terminal-tab
pipeline, plus a capability we don't have today: embedding the actual running Storybook UI
in a dock. Adopting it would delete the terminal-log polling RPC, the log ring buffer, and
most of the panel's Terminal tab in exchange for host-maintained equivalents.

### 3. Streaming channels instead of terminal-log polling

If the launcher (item 2) is not adopted wholesale, `rpc.streaming` channels are the targeted
fix for the same plumbing: a `terminal-logs` channel with a `replayWindow` gives the panel
push-based log tailing with replay-on-reconnect, replacing the `get-terminal-logs` +
`{ since }` cursor polling loop.

### 4. Persisted settings store

`ctx.scope(...)` exposes a `settings` store with `project` (per-checkout) and `global`
(per-user) scopes, file-backed on the server and synced to clients over shared state. Panel
preferences that currently reset every session become durable one-liners:

- Storybook URL override (today only a plugin option in `vite.config.ts`)
- last active panel tab, highlight-mode default, coverage-table sort
- per-user editor preference for "open story file"

## Medium value

### 5. Panel tabs as first-class docks (shared-frame sub-tabs)

The dock model supports several dock entries sharing one iframe (`frameId`) with soft
navigation between internal views (`navTarget`), or a single anchor dock that advertises its
sub-tabs at runtime (`subTabs`). The panel's hand-rolled tab strip (Storybook / Coverage /
Terminal / Docs) plus the `pending-tab` shared-state relay could migrate onto that protocol:
each tab gets a dock-rail presence, host-driven switching, and deep-linkable state, and the
`pending-tab` machinery disappears.

### 6. Runtime-validated RPC schemas

RPC functions accept Standard Schema `args`/`returns` (valibot, zod, or the bundled zero-dep
`devframe/utils/simple-schema`), enforced at runtime. The RPC table currently trusts its
callers. Adding schemas hardens the panel↔server boundary, produces self-documenting
payloads, and is a prerequisite for MCP exposure (item 1).

### 7. `when`-clause gating for commands and docks

Commands and dock entries take VS Code-style `when` expressions fed by plugin-published
context keys. Candidates: hide "Write Stories for Missing Components" when coverage reports
zero uncovered components; hide the highlighter action dock while a recording is in
progress.

### 8. Wire service for "open in editor"

`@devframes/service-open` provides open-file-in-editor / reveal-in-finder as a host-level
service; the definition declares it under `services`, and clients feature-detect with
`rpc.services.has(...)`. This gives the coverage table and story-created toasts a proper
"open story file in editor" action without shipping editor-launching code in this plugin.

## Exploratory

### 9. Static build adapter → shareable coverage report

`createBuild` bakes `static`/`query` RPC results into a self-contained static site served
from the same SPA. With a `dump` on `get-coverage`, `storybook-devtools build` would emit a
browsable story-coverage report as a CI artifact — no dev server, read-only panel.

### 10. Standalone CLI adapter

`createCac(definition)` yields a `dev` / `build` / `mcp` CLI for free. The `dev` and `build`
subcommands are only meaningful once instrumentation is decoupled from Vite (migration
Phases 2+), but `mcp` (item 1) works today: a stdio MCP server over the live dev server's
registry and coverage.

### 11. Ship an agent skill with the package

Devframe itself ships a `skills/` directory in its npm package — machine-readable authoring
guidance that coding agents load on demand. The same pattern fits here: a skill describing
the RPC surface, the registry model, and how to drive story generation programmatically
would make the plugin legible to agents working in consuming repos.

## Sequencing note

Items 2–4 remove more code than they add and are good candidates for the next change after
the phased migration's Phase 2 (unplugin refactor) lands, since they shrink the surface that
has to be ported per host. Item 1 is independent of hosting and can proceed any time; it
pairs well with item 6.
