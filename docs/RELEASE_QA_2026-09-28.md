# Release QA — 2026-09-28

This records the release preparation pass started on September 28 and completed
on September 29, based on `c57d31d`, including the
working-tree fixes described below. It is a dated test record; the README,
architecture documentation, and framework matrix remain the current guides.

## Findings and fixes

1. **First-click Component Highlighter activation was lost.** The dock selects
   an action and emits its activation event before dynamically importing its
   script. Setup now reads `current.isActive`, initializes available RPC
   receivers immediately, and binds lifecycle events once per dock. The shared
   browser suite clicks the actual dock button on all six hosts; the previous
   automation enable hook bypassed this failure. Re-executing the action also
   registered navigation RPCs twice; navigation and save handlers are now
   registered once per RPC client, including replacement clients.
2. **The editor RPC could be registered twice (`DF0021`).** A real hub-context
   test reproduced Devframe 1.1.0 racing late service imports after its ready
   barrier. Vite's built-in Messages plugin already provides the open service,
   so the Vite adapter reuses it. Portable hosts retain their service declaration
   and workspace roots. This avoids overwriting a live service with `force`.
3. **The package depended on workspace hoisting.** A packed consumer with
   `hoist=false` could not import the adapters or resolve React serialization
   dependencies. `@vue/compiler-sfc`, `@vitejs/devtools-kit`, and `react-is` are
   runtime dependencies; React is an optional peer. A built-ESM dependency
   contract test guards external imports. Optimizer includes now resolve the
   client libraries through the plugin package instead of assuming the app
   installs them directly.
4. **Dependency audits found vulnerable locked versions.** Targeted transitive
   fixes were applied, Nuxt was updated from 4.2.1 to 4.5.2, Vitest packages to
   4.1.11, and the Rsbuild Storybook framework from 3.4.2 to 3.6.0. This removes
   the critical [Nuxt DevTools RPC advisory](https://github.com/advisories/GHSA-279x-mwfv-vcqv)
   and the vulnerable older Vitest mocker dependency. The final full audit has
   one low-severity finding, described below; the production audit is clean.
5. **The patched Nuxt exposed two integration defects.** It now forwards Vite's
   native DevTools option, so the explicit plugin was removed from the
   playground. Source-mode runtime imports also needed their `/_nuxt/` prefix
   removed from `/@fs/` specifiers before a second import-analysis pass.
   A regression test covers that normalization.
6. **Circular Vue props overflowed serialization.** Newer Nuxt internal
   component props exposed an unbounded traversal. Vue now marks circular
   references and caps object/array depth, while preserving repeated objects
   in independent branches. Regression tests cover cycles and deep values.
   SSR tests now reject highlighter console errors, which previously did not
   fail an otherwise successful hydration check.
7. **Vue tracked dependency-owned DevTools components.** Unlike the transform
   filter, the global Vue hook accepted precompiled dependency SFCs. With Nuxt
   DevTools mounted, their reactive updates kept postponing registry sync and
   left the coverage panel empty. Those components embed build-machine source
   paths, so excluding `node_modules` alone was insufficient. The transform
   now registers accepted source paths; the runtime only tracks those files.
   The Nuxt detection test asserts that DevTools components stay out of the
   registry, and both Vue/Nuxt coverage checks pass.

Behavior regressions were reproduced before their fixes. Local red-run logs
include `activation-red.log`, `dock-red.log`, `client-rpc-red.log`,
`package-red.log`, `optimizer-red.log`, `nuxt-imports-red.log`, and
`vue-circular-props-red.log` in the evidence directory below.

## Validation

Local execution used macOS, Node 22.21.1, pnpm 10.33.0, and Chromium. CI is
configured for Ubuntu and Node 24; the updated remote workflow was not run
as part of this local pass.

| Check | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm test --run` | 422 passed across 35 test files |
| `pnpm typecheck` | Passed |
| Regular Playwright suite | 193 passed across all six playgrounds |
| Serial Storybook integration suite | 6 passed; five successful launches/previews and React 18's expected failure UI |
| React 18/19 activation and panel-reopen stress | 40 passed, ten repetitions of each scenario on each version |
| Packed consumer imports | React, Vue, Nuxt, Vite, Rsbuild, Next, and devframe entries imported successfully |
| Packed React production build | Passed; output has no highlighter runtime instrumentation |
| Packed React first-click UI smoke | Passed; real hover outline, source metadata, and creation menu; no browser warning/error logs |
| `pnpm audit --prod --json` | 0 findings |
| `pnpm audit --json` | 1 low; 0 moderate, high, or critical |
| Fresh packed consumer production audit | 0 findings, without workspace overrides |

Browser commands used isolated playground ports so existing development
servers could remain running:

```sh
PLAYWRIGHT_PORT_OFFSET=20 pnpm exec playwright test --max-failures=2 --reporter=line
PLAYWRIGHT_PORT_OFFSET=20 STORYBOOK_E2E_URL=http://localhost:6007 \
  pnpm exec playwright test --config=playwright.storybook.config.ts --reporter=line
PLAYWRIGHT_PORT_OFFSET=20 pnpm exec playwright test \
  --project=react-chromium --project=react18-chromium \
  -g 'first highlighter dock click|panel close then dock activate' \
  --repeat-each=10 --workers=1 --reporter=line
```

The stress run preceded the development-dependency refresh; the final regular
suite covers both lifecycle scenarios again on the final dependency set.
Builds and the disk-mutating Storybook suite must run separately from other
test suites. Runs interrupted by rebuilds, sandbox port restrictions, or the
Nuxt upgrade diagnosis were not counted as successful validation.

### Coverage

| Playground | Verified stack |
| --- | --- |
| React | React 19.2.7, Vite 8.3.1 |
| React 18 | React 18.3.1, Vite 8.3.1 |
| Vue | Vue 3.5.39, Vite 8.3.1 |
| Nuxt | Nuxt 4.5.2, SSR and hydration |
| Rsbuild | React 19.2.7, Rsbuild 2.1.13; Storybook framework 3.6.0 |
| Next | Next 15.5.24, React 19.2.7, webpack, App Router/RSC boundary |

The main browser matrix covers component detection, source metadata, hover
colors and labels, selection, locate, panel/dock state transitions, live prop
editing/reset, both creation payload flows, real typing/select interactions,
late-listener registry replay, and SSR/hydration where applicable.

The separate Storybook suite uses real disk writes, creates and appends stories,
starts Storybook through the panel, renders the generated preview and play
function, exercises Docs tabs, bulk notifications, and external deletion.
Five hosts have a working Storybook config; React 18 intentionally verifies
the missing-config failure path. The suite restores original story bytes.

Interactive checks also covered the React coverage search and inspector tabs,
plus a fresh packed React app with no eager listeners import. React 18 and
Rsbuild source-directory symlinks were retained.

## Repository and documentation

- CI now runs build, unit tests, typechecking, and both browser suites, with
  separate HTML report directories and a frozen lockfile.
- Playground port offsets and a shared Storybook test URL allow isolated QA.
- README setup, highlight colors, story-formatting behavior, troubleshooting,
  and validation commands were corrected, including the Nuxt 4.5 setup.
- Architecture, supported-framework guidance, agent instructions, and the PR
  checklist were updated with the behavior and regression coverage.
- Historical planning documents are explicitly marked as historical.
- README/AGENTS/top-level documentation relative links and `git diff --check`
  were checked. No release version bump, commit, or publication was performed.

## Remaining limitations and follow-ups

- The remaining [Elliptic advisory](https://github.com/advisories/GHSA-848j-6mx2-7j84)
  is low severity and has no patched version. The dependency path is the Next
  playground's `@storybook/nextjs` → `node-polyfill-webpack-plugin` →
  `crypto-browserify` → `browserify-sign` → `elliptic`. It is absent from the
  package's production audit. Track an upstream fix; the full audit is not zero.
- Installation still reports upstream peer-range warnings, including React 19
  versus `react-element-to-jsx-string`'s React 18 range, and development-tool
  peers in Next/Nuxt. Passing tests establish the tested paths, not complete
  compatibility with every consumer dependency combination.
- Browser coverage is Chromium only. Firefox, WebKit, Windows, the standalone
  browser-extension surface, every minimum peer version, and a full visual
  accessibility/theme audit were not covered in this pass.
- Vue-on-Rsbuild remains unverified; Next Turbopack is unsupported.
- The previously documented panel-selection race did not reproduce in the
  40-run stress check. It is not claimed fixed by this pass.

Local evidence is retained in `/tmp/storybook-devtools-release-qa/`, including
build/unit/typecheck logs, browser logs, audit JSON, the packed tarball, and
the isolated consumer fixture. These temporary files are not committed and
may be removed by the operating system.

The final successful browser logs are `e2e-verified.log` and
`storybook-verified.log`; final unit/typecheck/build logs use the `-final.log`
suffix. The final consumer artifact is `package-qa-final.tgz`. The original
playground story files were restored, and temporary QA servers were stopped.
