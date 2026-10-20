# React Authoring Patterns — Support Matrix

What the component detector recognizes, why, and the documented limits.

Detection is non-intrusive: the transform parses each module with
Storybook's parser (Babel on Storybook 10, `parseModule` from
`storybook/internal/csf-tools` on 11) and tags exported component **bindings**
with a metadata symbol (`__chRegisterMeta`), and the runtime reads that symbol
off the live React fiber tree. So a pattern is "supported" iff the transform
can find a **stable, exported, statically-named binding** to tag.

Every pattern below is exercised live in
`playground/react/src/components/patterns/` (rendered by `PatternShowcase`,
shared with the React 18 playground via symlink) and asserted by
`e2e/playground-react*-detection.spec.ts`.

## ✅ Supported

| Pattern | Example | Component file |
|---|---|---|
| Named function export | `export function Badge() {}` | `Badge.tsx` |
| Named arrow/const export | `export const App = () => {}` | `App.tsx` |
| Default export — function declaration | `export default function DefaultBanner() {}` | `patterns/DefaultBanner.tsx` |
| Default export — via identifier | `const IconChip = () => {}; export default IconChip` | `patterns/IconChip.tsx` |
| `export { X }` specifier | `function X(){}; export { X }` | (transform unit tests) |
| `memo(...)` (bare) | `export const MemoStat = memo(fn)` | `patterns/MemoStat.tsx` |
| `forwardRef(...)` (bare) | `export const FancyField = forwardRef(fn)` | `patterns/FancyField.tsx` |
| `React.memo(...)` / `React.forwardRef(...)` (member form) | `export const ReactMemoCard = React.memo(fn)` | `patterns/ReactMemoCard.tsx` |
| Composed wrappers | `export const MemoForwardInput = memo(forwardRef(fn))` | `patterns/MemoForwardInput.tsx` |
| Class component | `export class LegacyCounter extends React.Component` | `patterns/LegacyCounter.tsx` |
| Generic component | `export function GenericList<T>(p: Props<T>)` | `patterns/GenericList.tsx` |
| Compound component (parent) | `export function Disclosure() {}` | `patterns/Disclosure.tsx` |
| Barrel re-export | `export { MemoStat } from './MemoStat'` | `patterns/index.ts` |
| Multiple exported components per file | (transform unit tests) | — |

### Supported prop kinds (`patterns/PropZoo.tsx`)

- primitives
- string-literal unions
- destructured defaults
- deep nested objects
- arrays of objects
- arrays of primitives
- `Date` (emitted as `new Date("…ISO…")`)
- inline `style` object
- element prop that isn't `children`
- function-as-children / render prop
- discriminated unions
- nullable (`string | null`)
- tuple (`[number, number]`)
- event handler with args
- `ReactNode` children (single / array / nested mapped array)
- function props

**Prop serialization safety:** React-reserved props `ref` and `key` are
dropped (never valid story args — and a live `ref` holds a DOM node).
DOM nodes / `Window` / circular or very deep structures are replaced with
safe markers, so a `forwardRef`'s `ref` can never blow the call stack
("Maximum call stack size exceeded").

## Live prop editing (tooltip + panel)

Each editable prop row has a pencil; clicking it turns the value into a typed
form (Apply / Cancel). Edits drive React's own
`renderer.overrideProps(fiber, path, value)`, reached through the DevTools
hook we already install. Available in the tooltip (in-app overlay, direct
call) and the panel (via `set-prop` RPC → `do-set-prop` → runtime). No
remount; component state is preserved; the next commit re-syncs the
registry/UI.

The framework-agnostic machinery (payload decoding, reset-to-original
snapshots, registry sync) is shared: `src/runtime-helpers.ts` →
`createLivePropEditor`. Vue implements the same contract by mutating the
shallow-reactive `instance.props` (see `docs/SUPPORTED_FRAMEWORKS.md`).

| Value kind | Editor control | Notes |
|---|---|---|
| string | text input | |
| number | number input | rejects non-numeric (`{ok:false,error}`) |
| boolean | `<select>` true/false | |
| `Date` (`__isDate`) | text input (ISO) | reconstructed as `new Date(iso)` |
| object / array / `null` / `undefined` | JSON `<textarea>` | parsed; nested `__isDate` revived |
| function / JSX / Vue slot | **read-only** (no pencil) | cannot be round-tripped |
| object/array containing a fn/JSX | **read-only** | not reconstructable |

Constraints (same as React DevTools): **dev builds only** — `overrideProps`
is stripped from production react-dom; `__componentHighlighterCanEditProps()`
feature-detects and the pencil is omitted when unavailable. Overrides are
**ephemeral**: a parent re-render that passes a fresh prop replaces them.
Invalid input (bad JSON / NaN / editing a fn) reports an inline error and
changes nothing.

## ⚠️ Supported with a nuance

| Pattern | Nuance |
|---|---|
| Compound `Parent.Sub = Sub` | The exported **parent** is detected; dot-notation subcomponents assigned as static members (`Disclosure.Summary`, `Disclosure.Panel`) are **not** separate bindings, so they are not detected individually. |
| Component returning `null` | Registered with no anchor element until it renders DOM (e.g. `Modal` when closed) — present in the registry, just not hoverable. |
| `memo(forwardRef(...))` | React creates two tagged fibers (Memo wrapper + ForwardRef inner). The walker collapses a same-`sourceId` wrapper chain into **one** selectable instance anchored to the real DOM, so it registers once and story creation works (`MemoForwardInput`). Genuine recursion (`<Tree>` inside `<Tree>`) is unaffected — a host element between instances resets the chain. |

## ❌ Unsupported (documented limitations)

The two most common cases below — **anonymous default exports** and
**custom-HOC bindings** — are also surfaced at dev time as structured DevTools
diagnostics (`CH_UNSUPPORTED_PATTERN`, via `ctx.diagnostics`) with the source
`file:line:column`, so contributors see them in context instead of only here.
Parse failures surface as `CH_TRANSFORM_FAILED`. Detection lives in
`src/frameworks/react/transform.ts` (reported through `TransformOptions.onIssue`)
and is wired to the diagnostics host in `create-component-highlighter-plugin.ts`.

| Pattern | Why | Workaround |
|---|---|---|
| Anonymous default export — `export default () => {}` / `export default function(){}` | No stable binding name to tag. | Name it: `function Foo(){}; export default Foo`. (`patterns/AnonWidget.tsx`) |
| Arbitrary custom HOC — `export const X = withThing(Y)` | A call expression is not provably a component at build time (only `memo`/`forwardRef` are special-cased). | Export the inner component and use it directly, or wrap with `memo`/`forwardRef`. If the inner component is itself exported/tagged it is detected under **its** name. (`patterns/FramedNote.tsx` + `withFrame.tsx`) |
| HOC factory default — `export default connect()(X)` | Same as above (call result). | Assign to a named binding first. |
| Non-exported / local components | Only exported components can have stories, so detection is intentionally export-scoped. | Export it if you want a story. |
| Non-PascalCase functions | Not treated as components by design. | — |
| Object-of-components — `export const Icons = { Star: () => … }` | Not a function/class binding. | Export each as its own named component. |

## React Server Components (RSC) — the `rsc` option

The detection model is RSC-safe by design: the DevTools hook only sees client
commits, so Server Components are invisible (they never mount a client fiber).
The remaining concern is purely build-time — the transform should not inject
the client runtime import into a server-component module.

The **`rsc` plugin option** (default `false`) handles this with a `"use client"`
gate:

```ts
componentHighlighter({ rsc: true }) // e.g. TanStack Start
```

| Mode | Behavior |
|---|---|
| `rsc: false` (default, SPA) | Every matching module is instrumented. A plain SPA has no `"use client"` directive yet every component runs on the client, so gating would be wrong. |
| `rsc: true` (RSC frameworks) | Only modules declaring a leading `"use client"` directive are instrumented. Server components (no directive) are returned untouched — no tag, no runtime import. |

The directive is read from the parser's directive prologue (Babel's
`program.directives`, or the leading statements ESTree marks with
`directive`; handles either quote
style; a `"use client"` string elsewhere in the module does not count). The
gate is covered by `src/frameworks/react/transform.test.ts` ("RSC mode"):
client modules are tagged, server modules (no directive) are returned
untouched, and the SPA default (`rsc: false`) still tags everything.

On the Next.js host (`./next` entry, `src/next.ts`), `rsc` defaults to
`true`, since the App Router ships Server Components by default. Vite-based
RSC frameworks (e.g. TanStack Start) opt in explicitly with `rsc: true`.

## How to extend support

The recognizer lives in `src/frameworks/react/transform.ts`
(`isComponentInit` / `isMemoOrForwardRef` / `considerFunction` /
`considerClass`). The runtime tag/lookup is `__chRegisterMeta` / `readMeta`
in `src/frameworks/react/runtime-module.ts`. Any new pattern must keep the
"non-intrusive" invariant (tag a binding; never wrap the component) and add a
demonstrator under `patterns/` plus a detection-spec assertion.
