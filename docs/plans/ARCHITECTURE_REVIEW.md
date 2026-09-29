# Architecture review — the devframe-era shape

> Historical design notes. Version references and proposed work describe the
> original investigation; see [Architecture](../ARCHITECTURE.md) and
> [Supported frameworks](../SUPPORTED_FRAMEWORKS.md) for current behavior.

A layer-by-layer judgment of the plugin's architecture now that it runs on devframe
(definition in `src/devframe.ts`, instrumentation delivered through the unplugin core in
`src/unplugin.ts`). The devframe platform provides primitives — patch-synced shared state,
streaming channels, a settings store, process launchers — that several of this codebase's
hand-rolled mechanisms predate. This review records what is sound, what is now redundant,
and a rework plan. Every item is covered by the existing Playwright suites, so each
workstream can land independently with the full E2E gate as its safety net.

## Sound — keep as is

- **Instrumentation core** (`src/unplugin.ts`, `src/frameworks/*/transform*`): Babel/SFC
  tagging, virtual runtime modules, the RSC gate. Well-tested, portable, correctly split
  from the Vite adapter.
- **In-page runtime** (`src/runtime-helpers.ts`, `src/frameworks/*/runtime-module.ts`):
  hooks the framework devtools globals, not the bundler — the reason the browser side is
  already host-agnostic. The xstate highlight machine gives the overlay defensible state
  semantics.
- **Story generation and interaction codegen** (`src/utils/story-generator.ts`,
  `src/codegen/`, `src/frameworks/*/story-generator.ts`): clean framework split, strong
  unit coverage.
- **Vanilla-TS panel as a policy**: the no-framework rule for the panel UI is fine; the
  panel's problems are transport-shaped, not rendering-shaped.
- **The dock action script** (`src/client/vite-devtools.ts` as a `type: 'action'` dock
  entry): the idiomatic way to run code in the inspected page.

## Findings

### F1 — Three communication idioms for the same concepts

The RPC table carries three overlapping mechanisms:

1. **Relay RPCs** — 8 of the 20 server functions do nothing but re-broadcast a matching
   `do-*` client function (`scroll-to-component`, `set-prop`, `reset-prop`,
   `highlight-coverage-instances`, `highlight-coverage-batch`, `set-highlight-mode`,
   `visit-story`, `select-component`).
2. **Shared states** — 6 keys, several of which duplicate a relay: `select-component` +
   `selected-component`, `set-highlight-mode` + `highlight-active`, `visit-story` +
   `pending-visit`, and the tab trio (`do-open-panel-tab` + `do-switch-tab` +
   `pending-tab`).
3. **Direct server actions/queries** — the legitimately server-side calls (`create-story`,
   `get-coverage`, …).

The dual-write pattern (broadcast *and* store) defends against clients that connect after
the event — exactly the problem devframe shared state already solves (values replay on
connect, mutations patch-sync both ways). Two server functions have no callers at all:
`highlight-target` and `toggle-overlay`.

**Target model — one idiom per concept:**

| Concept | Mechanism |
| --- | --- |
| UI state that must survive reconnect (highlight mode, selected component, pending story visit, active panel tab) | shared state only — both sides subscribe and mutate |
| Ephemeral commands aimed at the app page (scroll-to, hover coverage highlights, set/reset a live prop) | broadcast events only |
| Server work (story writing, coverage, process control) | server RPC only |

This deletes the duplicated relays, their `do-*` counterparts, and the dead functions —
roughly half the wire surface.

### F2 — The registry sync is a dead diff protocol

`src/client/listeners.ts` maintains diff bookkeeping (`pendingDiff` added/removed/updated),
then both push sites discard it and send `fullSync: true` with the entire serialized
registry; the server's diff-application branches in `push-registry-diff` are unreachable.
Devframe shared state is client-mutable: the app page can mutate
`component-highlighter:registry` directly and drop the RPC, the `RegistryDiff` type, and
the client-side diff machinery entirely. Server and panel become plain subscribers.

### F3 — The panel is pull-based on a push-capable transport

Three polling loops drive the panel: coverage every 5 s, terminal logs with a `since`
cursor, and Storybook-index polling — against a server that already knows when each
changes (it owns the transform hook, writes the story files, and owns the child process).

- **Coverage** → server-pushed shared state, recomputed on transform and story-write.
- **Terminal logs** → a streaming channel with a replay window (deletes
  `get-terminal-logs` and the cursor protocol).
- **`get-config`** → the devframe settings store (`project` scope), which also makes the
  Storybook URL user-editable from the UI and persistent across restarts.

### F4 — Hand-rolled process management where the kit ships the primitive

`start-storybook` + the log ring buffer + the panel's Terminal tab reimplement
`createProcessLauncher` (`@vitejs/devtools-kit/node`): spawn into a tracked terminal
session, stream a startup digest, and — via `serve.onReady` — swap the dock to an iframe
embedding the served URL. Adopting it deletes the process RPCs and Terminal-tab code and
adds a capability the current code lacks: the running Storybook UI embedded in the dock.

### F5 — Server module diverges from devframe's recommended layout

`src/devframe.ts` is a single ~950-line module: full-name RPC registration, a hand-written
`declare module` augmentation for every function, and a hand-rolled shared mutable `state`
object threaded through `deps`. Devframe's documented layout is one file per RPC function
under `src/rpc/functions/` with a barrel, `ctx.scope('component-highlighter')` bare-name
registration, `RpcDefinitionsToFunctionsWithNamespace` typing, and a
`WeakMap<DevframeNodeContext, …>` context module instead of the shared object. Mechanical
to adopt; best done after F1–F3 so the surface being reorganized is the final one.

### F6 — Minor

- 17 distinct `window.__componentHighlighter*` globals form the intra-page API between
  runtime, listeners, overlay, dock script, and the E2E suites. Consolidate into one
  namespaced object with typed members; keep individual aliases only where E2E needs
  stable hooks.
- `NotificationService` (`src/notifications.ts`) is a vendor-abstraction layer from before
  devframe was itself the vendor-neutral layer; it can shrink to a thin
  console-fallback helper around `ctx.messages`.
- `ComponentHighlighterOptions.eventName` and `enableOverlay` are accepted and ignored.

## Rework plan

Ordered by leverage; each lands as its own change with the full unit + E2E gate. Doing
these before the Rsbuild/Next host phases shrinks the surface every new host must support.

1. **Consolidation pass** — F1 + F2 + F6: one idiom per concept, delete dead RPCs, the
   relay/state dual-writes, and the diff protocol.
2. **Process launcher** — F4: adopt `createProcessLauncher`, delete the terminal pipeline,
   gain embedded Storybook.
3. **Push-based panel + settings** — F3: shared-state coverage, streaming logs, settings
   store.
4. **Devframe layout idiom** — F5: split the server module along devframe's recommended
   structure. Last, so it reorganizes the post-rework surface rather than churning under
   the other workstreams.

`docs/plans/DEVFRAME_OPPORTUNITIES.md` lists the additive capabilities beyond this
corrective work (agent/MCP surface, static coverage builds, when-clauses, and more);
items 2–4 here overlap with its opportunities 2–4 and supersede them where they differ.
