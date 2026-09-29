# AGENTS.md

Guidance for AI coding agents working in this repository.

Read `docs/ARCHITECTURE.md` early for implementation/refactor tasks.

## Goals

- Ship minimal, correct changes.
- Preserve cross-framework parity across all supported integrations.
- Prove behavior with tests before claiming completion.

## Working Rules

1. **Start with tests, not assumptions**
   - If behavior changes, add/update tests first.
   - Prefer extending shared e2e helpers/suites over duplicating spec logic.
   - Sequence: add/adjust tests describing the expected behavior, confirm
     they fail against the old behavior, implement the change, then re-run
     the tests and capture the output.

2. **Keep framework playgrounds aligned**
   - Component naming and app structure should stay equivalent across supported frameworks when possible.
   - If one framework playground changes, review whether the others should match.
   - `playground/react` (React 19) is the canonical source tree.
     `playground/react18/src` and `playground/rsbuild/src` are symlinks to
     `playground/react/src`. Edit components once there; all three
     playgrounds and their shared E2E suites pick it up. Do not replace the
     symlinks with copies.
   - `playground/rsbuild` and `playground/next` alias the shared entry's
     `client/listeners` + `client/overlay` imports to shims
     (`playground/<host>/shims/`) instead of importing the package directly.
   - `playground/next` has its own source tree, not a symlink, because its
     RSC gate (`rsc: true`) needs a real server component in the render
     tree, which the `rsc: false` SPA playgrounds don't have. The `"use
     client"` transform gate itself is covered by unit tests
     (`src/frameworks/react/transform.test.ts` → "RSC mode");
     `e2e/playground-next-detection.spec.ts` covers the runtime registry.
   - React 18 and 19 are both required and both E2E-gated.
   - Keep `docs/SUPPORTED_FRAMEWORKS.md` current.

3. **Use shared test primitives**
   - Reuse:
     - `e2e/highlighter-helpers.ts`
     - `e2e/common-highlighter-suite.ts`
     - `e2e/common-listeners-replay-suite.ts` (late-loading listeners recovery)
     - `e2e/common-ssr-suite.ts` (SSR hosts only — raw-payload markup,
       hydration-mismatch-free boot, registry pickup of the `HydrationInfo`
       SSR-data component; registered by the Next and Nuxt specs)
   - Keep framework-specific specs focused on true framework differences only.

4. **Verify both save flows**
   - `Create` (story with current props)
   - `Create with Interactions` (story with recorded play function)
   - Ensure interaction recording is exercised with real form input/select actions.

5. **Make CI reliable**
   - Avoid relying on manual DevTools authorization in CI (Vite's trust
     prompt, or devframe's OTP gate on Rsbuild/Next — disable it with
     `clientAuth: false` on Rsbuild or `auth: false` on Next).
   - Keep E2E activation deterministic (automation hooks + config).

6. **Keep documentation up to date**
   - If you change architecture, features, testing strategy, workflow, or framework behavior, update the relevant documentation **in the same change**. Do not defer doc updates.
   - Required docs to review and update when applicable:
     - `README.md` - User-facing feature descriptions, configuration, usage guides
     - `AGENTS.md` - Agent working rules and validation steps
     - `docs/ARCHITECTURE.md` - Module responsibilities, endpoints, window globals, key IDs
     - `docs/SUPPORTED_FRAMEWORKS.md` - If framework list changed
     - `.github/pull_request_template.md` - If PR process changed
   - When in doubt, update the docs. Stale documentation causes compounding errors for future agents and contributors.

## Verifying DevTools Panel Behavior

When changes affect the panel, coverage dashboard, or panel↔client communication,
verify interactively using preview tools against a playground dev server.

### Setup

Use `.claude/launch.json` to start a playground (E2E env var is removed so DevTools
authorization works). The DevTools dock lives inside
`<devframes-dock-embedded>` — a custom element with a **shadow DOM**.

### Navigating the DevTools UI via preview tools

```js
// Access the shadow root
const dock = document.querySelector('devframes-dock-embedded');
const shadow = dock?.shadowRoot;

// Find dock buttons (Storybook, Component Highlighter, etc.)
const buttons = shadow?.querySelectorAll('button');
// Click by title: btn.title === 'Storybook' or 'Component Highlighter'

// Access the panel iframe (Storybook/Coverage/Terminal/Docs tabs)
const iframe = shadow?.querySelector('iframe');
const iframeDoc = iframe?.contentDocument;

// Interact with panel tab buttons
iframeDoc?.querySelectorAll('.tab-btn');  // click by textContent

// Panel-specific elements
iframeDoc?.getElementById('highlight-toggle');  // highlight mode toggle
iframeDoc?.querySelectorAll('tr.row');           // coverage table rows
iframeDoc?.querySelector('.act-btn.locate');      // scroll-to-component buttons
```

### Authorization

If the DevTools shows "Unauthorized", auto-authorize with the snippet below.
The host publishes the client context on `window.__DEVFRAME_HUB_CLIENT_CONTEXT__`
(standalone viewer: `__VITE_DEVTOOLS_CLIENT_CONTEXT__`); the token lives in
localStorage under `__DEVFRAME_CONNECTION_AUTH_TOKEN__`.
```js
const ctx =
  window.__VITE_DEVTOOLS_CLIENT_CONTEXT__ ||
  window.__DEVFRAME_HUB_CLIENT_CONTEXT__;
const token =
  localStorage.getItem('__DEVFRAME_CONNECTION_AUTH_TOKEN__') ||
  window.__DEVFRAME_CONNECTION_AUTH_TOKEN__;
ctx.rpc.requestTrustWithToken(token);
```

### What to verify

- Coverage tab: components show correct visible/not-visible status
- Coverage `hasStory` decision: matches a real Storybook story index
  (custom titles, stories outside the component's directory) rather than
  only a sibling `Name.stories.*` file; falls back to the sibling-file
  scan when there's no Storybook project or indexing fails
  (`src/story-index.ts`, `src/coverage-dashboard.ts`)
- Hover on coverage rows: highlight overlays appear on app page (`[data-coverage-highlight]`)
- Highlight toggle: `window.__componentHighlighterIsActive()` reflects state, cursor changes
- Scroll-to-component: locate button triggers scroll via RPC
- Create story / Create all: stories created without errors
- Live prop editing (React AND Vue): the pencil on a prop row edits the live app; reset restores the original
- Registry sync: `(await ctx.rpc.sharedState.get('component-highlighter:registry')).value()` returns the synced instances

### Communication architecture

All panel↔client communication uses Vite DevTools RPC (no `window.parent`).
Client broadcast handlers are registered in `listeners.ts` via `autoInitRpc()` —
they work before dock activation. See `docs/ARCHITECTURE.md` for the full RPC table.

## Required Validation Before Handoff

Run at minimum:

```bash
pnpm build
pnpm test --run
pnpm typecheck
pnpm exec playwright test
```

Build before tests: runtime-helper tests and Next/Rsbuild load `dist`.
Do not build concurrently with tests; the build clears that directory.

For Storybook peer, indexing, generation, or launcher changes, also run:

```bash
pnpm exec playwright test --config=playwright.storybook.config.ts
```

This serial suite uses port 6006, starts Storybook through the panel,
backs up a component's story file, creates and appends stories through RPC,
runs the generated play function in a preview, and checks external deletion.
It restores the exact original file and stops its own PTY. Keep port 6006
free before running it. React 18 has no
`.storybook` config: it checks fallback coverage and the launch failure UI.
The other five playgrounds must launch and render successfully.

The regular save-flow E2Es inspect emitted payloads; they do **not** prove
that disk writes, Storybook indexing, or the generated preview work.
When reviewing these paths, also cover concurrent saves, existing import
aliases/type imports, `.mjs` stories, source-directory symlinks, and separate
Nuxt client/SSR terminal hosts.
Webpack/rspack do not watch stories outside the app import graph; tests
must edit files without manually calling `invalidate()` to verify refresh.

Run the broader test set too when the change touches more than one area.

## PR Hygiene

- Keep tests and implementation in the same PR, tests first.
- PR description includes: what changed, why, exact commands run, and any caveats or follow-ups.

---

## UI Styling — Storybook Design System

The DevTools panel UI uses vanilla JS + Shadow DOM. Do **not** introduce React or Emotion just for styling. Instead, use Storybook's design tokens as CSS custom properties injected at the Shadow DOM root.

### In-repo skill
See `.agents/skills/storybook-ui/SKILL.md` for implementation guidance.

### Token injection pattern

```js
const style = document.createElement('style');
style.textContent = getSbTokenStyles(); // see skill for full block
shadowRoot.prepend(style);
```

### Key rules
- Use `--sb-*` CSS custom properties for all colors, typography, and spacing
- Always include both light (`:host {}`) and dark (`@media (prefers-color-scheme: dark)`) blocks
- Never hardcode hex colors — use the `--sb-*` variables
- The Shadow DOM root is `<devframes-dock-embedded>`'s `shadowRoot`
- **Unavailable actions**: omit them from the DOM entirely — do not render them as `disabled`. This applies to popover menus, context menu action buttons, and any other affordance that depends on optional state (e.g. story existence, editor availability).
