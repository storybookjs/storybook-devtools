import * as path from 'path'
import { describe, it, expect } from 'vitest'
import { transform } from './transform'

// The React transform is non-intrusive: it never wraps components in an HOC
// (which pollutes the tree and breaks RSC). It only appends an idempotent
// metadata tag — `__chRegisterMeta(Component, { ... })` — and the original
// declarations are left byte-for-byte intact.

describe('transform (non-intrusive tagging)', () => {
  describe('basic transformations', () => {
    it('tags a simple function component', () => {
      const code = `
import React from 'react'

export function MyComponent(props) {
  return <div>Hello {props.name}</div>
}
`
      const result = transform(code, '/src/MyComponent.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(MyComponent, {')
      expect(result).toContain('filePath')
      // Never wraps.
      expect(result).not.toContain('withComponentHighlighter')
      // Original declaration is preserved.
      expect(result).toContain('function MyComponent(props)')
    })

    it('tags a default-export arrow function component', () => {
      const code = `
import React from 'react'

const MyComponent = (props) => {
  return <div>Hello {props.name}</div>
}

export default MyComponent
`
      const result = transform(code, '/src/MyComponent.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(MyComponent, {')
      expect(result).toContain('isDefaultExport: true')
    })

    it('does not transform non-JSX files', () => {
      const code = `
export function helper() {
  return 'hello'
}
`
      expect(transform(code, '/src/helper.ts')).toBeUndefined()
    })

    it('does not transform JSX-less component files', () => {
      const code = `
export function MyComponent(props) {
  return 'Hello ' + props.name
}
`
      expect(transform(code, '/src/MyComponent.tsx')).toBeUndefined()
    })
  })

  describe('export variations', () => {
    it('tags a named export function declaration', () => {
      const code = `
import React from 'react'

export function Button({ label }) {
  return <button>{label}</button>
}
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Button, {')
      expect(result).toContain('componentName: "Button"')
      expect(result).toContain('isDefaultExport: false')
    })

    it('tags a default export via identifier', () => {
      const code = `
import React from 'react'

const Button = ({ label }) => {
  return <button>{label}</button>
}

export default Button
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Button, {')
      expect(result).toContain('isDefaultExport: true')
    })

    it('tags a direct default export function declaration', () => {
      const code = `
import React from 'react'

export default function App({ name }) {
  return <div>Hello {name}</div>
}
`
      const result = transform(code, '/src/App.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(App, {')
      expect(result).toContain('isDefaultExport: true')
      expect(result).toContain('componentName: "App"')
    })

    it('tags a const arrow function export', () => {
      const code = `
import React from 'react'

export const Button = ({ label }) => {
  return <button>{label}</button>
}
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Button, {')
      expect(result).toContain('componentName: "Button"')
    })
  })

  describe('React patterns', () => {
    it('tags React.memo wrapped components', () => {
      const code = `
import React, { memo } from 'react'

export const Button = memo(({ label }) => {
  return <button>{label}</button>
})
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Button, {')
    })

    it('tags React.forwardRef wrapped components', () => {
      const code = `
import React, { forwardRef } from 'react'

export const Button = forwardRef(({ label }, ref) => {
  return <button ref={ref}>{label}</button>
})
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Button, {')
    })

    it('tags React.memo member-expression wrapper form', () => {
      const code = `
import React from 'react'

export const Card = React.memo(function Card({ title }) {
  return <div>{title}</div>
})
`
      const result = transform(code, '/src/Card.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Card, {')
    })

    it('tags React.forwardRef member-expression wrapper form', () => {
      const code = `
import React from 'react'

export const Field = React.forwardRef(function Field(props, ref) {
  return <input ref={ref} />
})
`
      const result = transform(code, '/src/Field.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Field, {')
    })

    it('tags class components (named export)', () => {
      const code = `
import React from 'react'

export class Counter extends React.Component {
  render() { return <div>{this.state?.n}</div> }
}
`
      const result = transform(code, '/src/Counter.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Counter, {')
    })

    it('tags class components (default export)', () => {
      const code = `
import React from 'react'

export default class Counter extends React.Component {
  render() { return <div /> }
}
`
      const result = transform(code, '/src/Counter.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Counter, {')
      expect(result).toContain('isDefaultExport: true')
    })

    it('does NOT tag anonymous default exports (documented limitation)', () => {
      const code = `
import React from 'react'
export default () => <div />
`
      const result = transform(code, '/src/Anon.tsx')
      // No stable binding to tag → transform returns undefined (no change).
      expect(result).toBeUndefined()
    })

    it('does NOT tag arbitrary HOC-wrapped bindings (documented limitation)', () => {
      const code = `
import React from 'react'
function Base() { return <div /> }
const withX = (C) => (p) => <C {...p} />
export const Wrapped = withX(Base)
`
      const result = transform(code, '/src/Wrapped.tsx')
      // withX(...) is not provably a component at build time.
      expect(result === undefined || !result.includes('__chRegisterMeta(Wrapped'))
        .toBe(true)
    })
  })

  describe('metadata', () => {
    it('includes the absolute filePath', () => {
      const code = `
import React from 'react'
export function Button() { return <button>Click</button> }
`
      const result = transform(code, '/project/src/components/Button.tsx')

      expect(result).toContain('filePath')
      expect(result).toContain('/project/src/components/Button.tsx')
    })

    it('includes relativeFilePath and sourceId', () => {
      const code = `
import React from 'react'
export function Button() { return <button>Click</button> }
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toContain('relativeFilePath')
      expect(result).toContain('sourceId')
    })

    it('generates distinct sourceIds for distinct file paths', () => {
      const code1 = `
import React from 'react'
export function Button() { return <button>1</button> }
`
      const code2 = `
import React from 'react'
export function Button() { return <button>2</button> }
`
      const r1 = transform(code1, '/src/Button1.tsx')
      const r2 = transform(code2, '/src/Button2.tsx')

      const id1 = r1?.match(/sourceId: "([^"]+)"/)?.[1]
      const id2 = r2?.match(/sourceId: "([^"]+)"/)?.[1]
      expect(id1).toBeTruthy()
      expect(id2).toBeTruthy()
      expect(id1).not.toBe(id2)
    })
  })

  describe('multiple components', () => {
    it('tags every exported component', () => {
      const code = `
import React from 'react'

export const Button = ({ label }) => {
  return <button>{label}</button>
}

export const Icon = ({ name }) => {
  return <span>{name}</span>
}
`
      const result = transform(code, '/src/components.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Button, {')
      expect(result).toContain('__chRegisterMeta(Icon, {')
    })
  })

  describe('import injection', () => {
    it('imports __chRegisterMeta from the virtual runtime', () => {
      const code = `
import React from 'react'
export function Button() { return <button>Click</button> }
`
      const result = transform(code, '/src/Button.tsx')

      expect(result).toContain('__chRegisterMeta')
      expect(result).toContain('virtual:component-highlighter/runtime')
    })

    it('keeps the module text and appends the import and tags after it', () => {
      const code = `'use client'
// A comment the transform keeps.
import React from 'react'

export const Button = () => <button  type="button">Click</button>
`
      const result = transform(code, '/src/Button.tsx')!

      expect(result.startsWith(code)).toBe(true)
      expect(result.slice(code.length)).toBe(`import { __chRegisterMeta } from "virtual:component-highlighter/runtime";
__chRegisterMeta(Button, {
  componentName: "Button",
  filePath: "/src/Button.tsx",
  relativeFilePath: ${JSON.stringify(path.relative(process.cwd(), '/src/Button.tsx'))},
  sourceId: ${JSON.stringify(result.match(/sourceId: "([^"]+)"/)![1])},
  isDefaultExport: false,
});
`)
    })

    it('still produces valid output if re-transformed', () => {
      const code = `
import React from 'react'
import { __chRegisterMeta } from 'virtual:component-highlighter/runtime'

export function Button() { return <button>Click</button> }
`
      expect(transform(code, '/src/Button.tsx')).toBeDefined()
    })
  })

  describe('non-exported components', () => {
    it('does not tag non-exported components', () => {
      const code = `
import React from 'react'

const ThemeToggle = () => {
  return (
    <button>
      <span>Theme</span>
    </button>
  )
}

export const Header = ({ sticky }: { sticky?: boolean }) => {
  return (
    <span>Header component <ThemeToggle /></span>
  )
}
`
      const result = transform(code, '/src/Test.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Header, {')
      expect(result).not.toContain('__chRegisterMeta(ThemeToggle')
    })
  })

  describe('edge cases', () => {
    it('handles complex JSX', () => {
      const code = `
import React from 'react'

export function Card({ title, children }) {
  return (
    <div className="card">
      <header><h2>{title}</h2></header>
      <main>{children}</main>
      <footer><button onClick={() => {}}>Action</button></footer>
    </div>
  )
}
`
      const result = transform(code, '/src/Card.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Card, {')
    })

    it('handles TypeScript generic components', () => {
      const code = `
import React from 'react'

interface Props<T> {
  items: T[]
  renderItem: (item: T) => React.ReactNode
}

export function List<T>({ items, renderItem }: Props<T>) {
  return <ul>{items.map(renderItem)}</ul>
}
`
      const result = transform(code, '/src/List.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(List, {')
    })

    it('handles components with hooks (no extra render boundary)', () => {
      const code = `
import React, { useState, useEffect } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)
  useEffect(() => { console.log(count) }, [count])
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>
}
`
      const result = transform(code, '/src/Counter.tsx')

      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Counter, {')
      // No HOC / boundary wrapper is introduced.
      expect(result).not.toContain('withComponentHighlighter')
      expect(result).not.toContain('ComponentHighlighterBoundary')
    })
  })

  describe('RSC mode ("use client" gate)', () => {
    const clientComponent = `'use client'
import React from 'react'

export function ClientWidget() {
  return <div>client</div>
}
`
    const serverComponent = `import React from 'react'

export function ServerWidget() {
  return <div>server</div>
}
`

    it('tags server components when rsc is off (SPA default)', () => {
      // A plain SPA has no "use client" directive but every component is a
      // client component — must still be tagged.
      const result = transform(serverComponent, '/src/ServerWidget.tsx')
      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(ServerWidget, {')
    })

    it('tags server components when rsc is explicitly false', () => {
      const result = transform(serverComponent, '/src/ServerWidget.tsx', {
        rsc: false,
      })
      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(ServerWidget, {')
    })

    it('tags "use client" components in rsc mode', () => {
      const result = transform(clientComponent, '/src/ClientWidget.tsx', {
        rsc: true,
      })
      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(ClientWidget, {')
      // The directive is preserved (must stay the first statement).
      expect(result).toContain("'use client'")
    })

    it('does NOT tag server components in rsc mode (left untouched)', () => {
      const result = transform(serverComponent, '/src/ServerWidget.tsx', {
        rsc: true,
      })
      // No transform at all — the module is returned untouched (undefined).
      expect(result).toBeUndefined()
    })

    it('recognizes a double-quoted "use client" directive', () => {
      const code = `"use client"
import React from 'react'

export function Dq() {
  return <div>dq</div>
}
`
      const result = transform(code, '/src/Dq.tsx', { rsc: true })
      expect(result).toBeDefined()
      expect(result).toContain('__chRegisterMeta(Dq, {')
    })

    it('ignores a "use client" string that is not a leading directive', () => {
      // A "use client" appearing as a value (not a directive prologue) must
      // NOT flip the module into client mode.
      const code = `import React from 'react'

const label = 'use client'

export function NotADirective() {
  return <div>{label}</div>
}
`
      const result = transform(code, '/src/NotADirective.tsx', { rsc: true })
      expect(result).toBeUndefined()
    })
  })

  describe('diagnostics (onIssue reporting)', () => {
    type Issue = {
      code: string
      file: string
      name?: string
      detail: string
      loc?: string
    }
    const collect = (code: string, id: string) => {
      const issues: Issue[] = []
      const result = transform(code, id, { onIssue: (i) => issues.push(i) })
      return { issues, result }
    }

    it('reports an anonymous default export as unsupported', () => {
      const { issues } = collect(
        `import React from 'react'\nexport default () => <div>hi</div>\n`,
        '/src/AnonWidget.tsx',
      )
      const issue = issues.find((i) => i.name === 'default')
      expect(issue).toBeDefined()
      expect(issue?.code).toBe('unsupported-pattern')
      expect(issue?.file).toBe('/src/AnonWidget.tsx')
      expect(issue?.loc).toMatch(/AnonWidget\.tsx:\d+:\d+$/)
    })

    it('reports an exported PascalCase custom-HOC binding as unsupported', () => {
      const { issues } = collect(
        `import React from 'react'
function Base() { return <div /> }
export const Framed = withFrame(Base)
`,
        '/src/FramedNote.tsx',
      )
      const issue = issues.find((i) => i.name === 'Framed')
      expect(issue).toBeDefined()
      expect(issue?.code).toBe('unsupported-pattern')
    })

    it('reports a parse failure as transform-failed (and does not throw)', () => {
      const { issues, result } = collect(
        `import React from 'react'\nexport default function ( {\n`,
        '/src/Broken.tsx',
      )
      expect(result).toBeUndefined()
      const issue = issues.find((i) => i.code === 'transform-failed')
      expect(issue).toBeDefined()
      expect(issue?.file).toBe('/src/Broken.tsx')
    })

    it('does NOT flag a PascalCase factory export in a non-JSX module', () => {
      // No JSX → not a component module → no unsupported-pattern noise.
      const { issues } = collect(
        `export const Store = createStore()\n`,
        '/src/store.ts',
      )
      expect(issues).toHaveLength(0)
    })

    it('reports nothing for a normal named component', () => {
      const { issues } = collect(
        `import React from 'react'\nexport function Button() { return <button /> }\n`,
        '/src/Button.tsx',
      )
      expect(issues).toHaveLength(0)
    })

    it('does not flag a non-exported local component (intentional limitation)', () => {
      // `Base` is local; only the HOC binding `Framed` (exported) is flagged.
      const { issues } = collect(
        `import React from 'react'
function Base() { return <div /> }
export const Framed = withFrame(Base)
`,
        '/src/FramedNote.tsx',
      )
      expect(issues.find((i) => i.name === 'Base')).toBeUndefined()
    })
  })
})
