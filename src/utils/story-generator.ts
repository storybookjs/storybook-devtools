import type {
  ComponentMeta,
  SerializedProps,
  JSXSerializedValue,
  FunctionSerializedValue,
} from '../frameworks/types'
import * as path from 'path'
import type { CsfImportRequest } from './csf-writer'

// Re-export types for consumers
export type { SerializedProps, JSXSerializedValue, FunctionSerializedValue }

export interface StoryGenerationData {
  meta: ComponentMeta
  props: SerializedProps
  /** Map of component name to file path for import resolution */
  componentRegistry?: Map<string, string>
  /** Custom story name (defaults to auto-generated name) */
  storyName?: string
  /** Existing file content to append to */
  existingContent?: string
  /** Play function code lines generated from recorded interactions */
  playFunction?: string[]
  /** Import statements required by the play function */
  playImports?: string[]
  /** Storybook framework package for the `Meta`/`StoryObj` type import (defaults to the generator's framework package) */
  storybookFramework?: string
}

export interface GeneratedStory {
  /** The generated story file content */
  content: string
  /** Suggested file path for the story */
  filePath: string
  /** List of imports that need to be added */
  imports: Array<{ name: string; path: string }>
  /** The story name that was used */
  storyName: string
  /**
   * Why the CSF AST append was abandoned for the text-splice fallback, when
   * it was (`src/utils/csf-writer.ts`).
   */
  fallbackReason?: string
}

/**
 * The imports an appended story needs on top of what the story file already
 * has: `fn` for function props, the play function's `storybook/test` names,
 * and the component imports the story renders.
 */
export function collectRequiredImports(options: {
  props: SerializedProps
  imports: Array<{ name: string; path: string }>
  playImports?: string[]
}): CsfImportRequest[] {
  const requests: CsfImportRequest[] = []

  const testNames = collectStorybookTestNames(options.props, options.playImports)
  if (testNames.length > 0) {
    requests.push({ source: 'storybook/test', specifiers: testNames })
  }

  for (const imp of options.imports) {
    if (imp.name.startsWith('{')) {
      requests.push({
        source: imp.path,
        specifiers: [imp.name.replace(/[{}]/g, '').trim()],
      })
    } else {
      requests.push({ source: imp.path, defaultSpecifier: imp.name.trim() })
    }
  }

  return requests
}

/** Render an import request as the source line a new story file carries. */
export function printImportStatement(request: CsfImportRequest): string {
  const bindings: string[] = []
  if (request.defaultSpecifier) bindings.push(request.defaultSpecifier)
  if (request.specifiers?.length) {
    bindings.push(`{ ${request.specifiers.join(', ')} }`)
  }
  return `import ${request.typeOnly ? 'type ' : ''}${bindings.join(', ')} from '${request.source}';`
}

/**
 * The `storybook/test` bindings a story needs: `fn` for mocked function
 * props, plus every name the recorded play function imports (the client only
 * ever generates `storybook/test` imports — see `src/codegen/`).
 */
export function collectStorybookTestNames(
  props: SerializedProps,
  playImports?: string[],
): string[] {
  const names = new Set<string>()
  if (hasAnyFunctionProps(props)) names.add('fn')
  for (const playImport of playImports ?? []) {
    for (const name of extractStorybookTestImports(playImport)) {
      names.add(name)
    }
  }
  return [...names]
}

/**
 * Shared utilities for story generation
 */

/** Convert a string to a valid JavaScript identifier in PascalCase */
export function toValidStoryName(name: string): string {
  let validName = name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('')

  if (!validName || /^\d/.test(validName)) {
    return 'Default'
  }

  return validName
}

/** Generate a story name from component props */
export function generateStoryName(props: SerializedProps): string {
  const meaningfulProps = ['variant', 'type', 'size', 'mode', 'status', 'kind']

  for (const propName of meaningfulProps) {
    if (propName in props && typeof props[propName] === 'string') {
      const value = props[propName] as string
      return capitalizeFirst(value)
    }
  }

  return 'Default'
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/** Get relative import path between two directories */
export function getRelativeImportPath(
  fromDir: string,
  toFilePath: string,
): string {
  const relativePath = path
    .relative(fromDir, toFilePath)
    .replace(/\.(tsx?|jsx?)$/i, '')
  if (!relativePath.startsWith('.')) {
    return `./${relativePath}`
  }
  return relativePath
}

/** Type guard for JSX serialized values */
export function isJSXSerializedValue(
  value: unknown,
): value is JSXSerializedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__isJSX' in value &&
    (value as JSXSerializedValue).__isJSX === true
  )
}

/** Type guard for function serialized values */
export function isFunctionSerializedValue(
  value: unknown,
): value is FunctionSerializedValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__isFunction' in value &&
    (value as FunctionSerializedValue).__isFunction === true
  )
}

/** Type guard for Date serialized values */
export function isDateSerializedValue(
  value: unknown,
): value is { __isDate: true; iso: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__isDate' in value &&
    (value as { __isDate?: unknown }).__isDate === true
  )
}

/**
 * Type guard for non-plain object markers (Map, Set, class instances) that the
 * runtime could not serialize into a story-safe value.
 */
export function isUnserializableObjectValue(
  value: unknown,
): value is { __isObject: true; name?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__isObject' in value &&
    (value as { __isObject?: unknown }).__isObject === true
  )
}

/** Check if props contain any JSX values */
export function hasAnyJSXProps(props: SerializedProps): boolean {
  for (const value of Object.values(props)) {
    if (isJSXSerializedValue(value)) return true
    if (
      typeof value === 'object' &&
      value !== null &&
      !isJSXSerializedValue(value)
    ) {
      if (hasAnyJSXProps(value as SerializedProps)) return true
    }
  }
  return false
}

/** Check if props contain any function values */
export function hasAnyFunctionProps(props: SerializedProps): boolean {
  for (const value of Object.values(props)) {
    if (isFunctionSerializedValue(value)) return true
    if (isJSXSerializedValue(value) && hasFunctionHandlersInJSX(value.source))
      return true
    if (
      typeof value === 'object' &&
      value !== null &&
      !isJSXSerializedValue(value)
    ) {
      if (hasAnyFunctionProps(value as SerializedProps)) return true
    }
  }
  return false
}

/** Collect component references from serialized props */
export function collectComponentRefs(
  props: SerializedProps,
  refs: Set<string>,
): void {
  for (const value of Object.values(props)) {
    if (isJSXSerializedValue(value)) {
      for (const ref of value.componentRefs) {
        refs.add(ref)
      }
      const sourceRefs = extractComponentNamesFromJSXSource(value.source)
      for (const ref of sourceRefs) {
        refs.add(ref)
      }
    } else if (typeof value === 'object' && value !== null) {
      collectComponentRefs(value as SerializedProps, refs)
    }
  }
}

function normalizeJsxIdentifierToken(raw: string): string {
  const parts = raw.match(/[A-Za-z0-9_$]+/g)
  if (!parts || parts.length === 0) return ''

  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/** Normalize non-identifier JSX tags, e.g. <Styled(Link)> -> <StyledLink> */
function normalizeNonIdentifierJsxTags(jsxSource: string): string {
  const openingTagPattern = /<([A-Z][A-Za-z0-9_$]*)\(([^)]+)\)(?=\s|\/?>)/g
  const closingTagPattern = /<\/([A-Z][A-Za-z0-9_$]*)\(([^)]+)\)\s*>/g

  const normalizeName = (prefix: string, innerRaw: string): string => {
    const normalizedInner = normalizeJsxIdentifierToken(innerRaw)
    return normalizedInner ? `${prefix}${normalizedInner}` : prefix
  }

  let normalized = jsxSource.replace(
    openingTagPattern,
    (_match, prefix, inner) => {
      return `<${normalizeName(prefix, inner)}`
    },
  )

  normalized = normalized.replace(
    closingTagPattern,
    (_match, prefix, inner) => {
      return `</${normalizeName(prefix, inner)}>`
    },
  )

  return normalized
}

/** Extract component names from JSX source */
export function extractComponentNamesFromJSXSource(
  jsxSource: string,
): Set<string> {
  const componentNames = new Set<string>()
  const normalizedSource = normalizeNonIdentifierJsxTags(jsxSource)
  const jsxTagPattern = /<([A-Z][a-zA-Z0-9]*)(?:\s|>|\.)/g
  let match

  while ((match = jsxTagPattern.exec(normalizedSource)) !== null) {
    const componentName = match[1]
    if (
      componentName &&
      componentName !== 'Fragment' &&
      componentName !== 'React'
    ) {
      componentNames.add(componentName)
    }
  }

  return componentNames
}

/** Format a prop key (handle keys that need quoting) */
export function formatPropKey(key: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
    return key
  }
  return JSON.stringify(key)
}

/** Generate args object content with proper formatting */
export function generateArgsContent(
  props: SerializedProps,
  indentLevel: number,
  componentRegistry?: Map<string, string>,
): string {
  const indent = '  '.repeat(indentLevel)
  const innerIndent = '  '.repeat(indentLevel + 1)
  const entries = Object.entries(props)

  if (entries.length === 0) {
    return '{}'
  }

  const propsContent = entries
    .map(([key, value]) => {
      const formattedValue = formatPropValue(
        value,
        indentLevel + 1,
        componentRegistry,
      )
      return `${innerIndent}${formatPropKey(key)}: ${formattedValue},`
    })
    .join('\n')

  return `{\n${propsContent}\n${indent}}`
}

/** Replace function handlers in JSX with fn() */
export function replaceFunctionHandlersInJSX(jsxSource: string): string {
  let result = jsxSource
  let pos = 0

  while (pos < result.length) {
    const propMatch = result.slice(pos).match(/(\w+)=\{/)
    if (!propMatch) break

    const propStart = pos + propMatch.index!
    const propName = propMatch[1]
    const braceStart = propStart + propMatch[0].length - 1

    let braceCount = 0
    let braceEnd = braceStart
    let inString = false
    let stringChar = ''

    for (let i = braceStart; i < result.length; i++) {
      const char = result[i]
      const prevChar = i > 0 ? result[i - 1] : ''

      if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
        if (!inString) {
          inString = true
          stringChar = char
        } else if (char === stringChar) {
          inString = false
        }
        continue
      }

      if (inString) continue

      if (char === '{') {
        braceCount++
      } else if (char === '}') {
        braceCount--
        if (braceCount === 0) {
          braceEnd = i
          break
        }
      }
    }

    if (braceCount !== 0) {
      pos = braceStart + 1
      continue
    }

    const content = result.slice(braceStart + 1, braceEnd).trim()
    const functionPatterns = [
      /^\([^)]*\)\s*=>/,
      /^async\s*\([^)]*\)\s*=>/,
      /^function(?:\s+\w+)?\s*\(/,
      /^[\w.]+\([^)]*\)/,
    ]

    const isFunctionHandler = functionPatterns.some((pattern) =>
      pattern.test(content),
    )

    if (isFunctionHandler) {
      result =
        result.slice(0, propStart) +
        `${propName}={fn()}` +
        result.slice(braceEnd + 1)
      pos = propStart + `${propName}={fn()}`.length
    } else {
      pos = braceEnd + 1
    }
  }

  return result
}

/** Check if JSX source contains function handlers */
export function hasFunctionHandlersInJSX(jsxSource: string): boolean {
  let pos = 0

  while (pos < jsxSource.length) {
    const propMatch = jsxSource.slice(pos).match(/(\w+)=\{/)
    if (!propMatch) break

    const propStart = pos + propMatch.index!
    const braceStart = propStart + propMatch[0].length - 1

    let braceCount = 0
    let braceEnd = braceStart
    let inString = false
    let stringChar = ''

    for (let i = braceStart; i < jsxSource.length; i++) {
      const char = jsxSource[i]
      const prevChar = i > 0 ? jsxSource[i - 1] : ''

      if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
        if (!inString) {
          inString = true
          stringChar = char
        } else if (char === stringChar) {
          inString = false
        }
        continue
      }

      if (inString) continue

      if (char === '{') {
        braceCount++
      } else if (char === '}') {
        braceCount--
        if (braceCount === 0) {
          braceEnd = i
          break
        }
      }
    }

    if (braceCount !== 0) {
      pos = braceStart + 1
      continue
    }

    const content = jsxSource.slice(braceStart + 1, braceEnd).trim()
    const functionPatterns = [
      /^\([^)]*\)\s*=>/,
      /^async\s*\([^)]*\)\s*=>/,
      /^function(?:\s+\w+)?\s*\(/,
      /^[\w.]+\([^)]*\)/,
    ]

    const isFunctionHandler = functionPatterns.some((pattern) =>
      pattern.test(content),
    )

    if (isFunctionHandler) {
      return true
    }

    pos = braceEnd + 1
  }

  return false
}

/** Replace styled components and unknown components in JSX with divs */
export function replaceStyledComponentsInJSX(
  jsxSource: string,
  componentRegistry?: Map<string, string>,
): string {
  let result = jsxSource

  result = result.replace(/<styled\.([a-zA-Z][a-zA-Z0-9]*)/g, '<div')
  result = result.replace(/<\/styled\.([a-zA-Z][a-zA-Z0-9]*)>/g, '</div>')

  if (componentRegistry) {
    const componentNames = extractComponentNamesFromJSXSource(result)

    for (const componentName of componentNames) {
      if (!componentRegistry.has(componentName)) {
        const fallbackReason = `The component ${componentName} could not be used as it is not exported, so a simple div was used instead. Please replace it.`
        const fallbackAttribute = ` data-important-read-this="${fallbackReason}"`
        const openingTagRegex = new RegExp(`<${componentName}(\\s|>)`, 'g')
        result = result.replace(openingTagRegex, `<div${fallbackAttribute}$1`)

        const closingTagRegex = new RegExp(`</${componentName}>`, 'g')
        result = result.replace(closingTagRegex, '</div>')
      }
    }
  }

  return result
}

/** Format a prop value for output */
export function formatPropValue(
  value: unknown,
  indentLevel: number,
  componentRegistry?: Map<string, string>,
): string {
  if (isJSXSerializedValue(value)) {
    let jsxSource = normalizeNonIdentifierJsxTags(value.source)
    jsxSource = replaceFunctionHandlersInJSX(jsxSource)
    jsxSource = replaceStyledComponentsInJSX(jsxSource, componentRegistry)

    if (jsxSource.includes('\n')) {
      const indent = '  '.repeat(indentLevel)
      const lines = jsxSource.split('\n')
      const indentedJsx = lines
        .map((line, i) => (i === 0 ? line : indent + line))
        .join('\n')
      return `(\n${indent}${indentedJsx}\n${'  '.repeat(indentLevel - 1)})`
    }
    return jsxSource
  }

  if (isFunctionSerializedValue(value)) {
    return 'fn()'
  }

  if (isDateSerializedValue(value)) {
    return `new Date(${JSON.stringify(value.iso)})`
  }

  if (isUnserializableObjectValue(value)) {
    // Map/Set/class instances can't be reconstructed as a literal — emit a
    // placeholder the author can fill in rather than a bogus object.
    return `undefined /* ${value.name || 'Object'}: non-serializable value, provide one */`
  }

  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (typeof value === 'function') {
    return 'fn()'
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'

    const indent = '  '.repeat(indentLevel)
    const innerIndent = '  '.repeat(indentLevel + 1)
    const items = value
      .map(
        (item) =>
          `${innerIndent}${formatPropValue(item, indentLevel + 1, componentRegistry)},`,
      )
      .join('\n')
    return `[\n${items}\n${indent}]`
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'

    const indent = '  '.repeat(indentLevel)
    const innerIndent = '  '.repeat(indentLevel + 1)
    const props = entries
      .map(([k, v]) => {
        const formattedKey = formatPropKey(k)
        const formattedValue = formatPropValue(
          v,
          indentLevel + 1,
          componentRegistry,
        )
        return `${innerIndent}${formattedKey}: ${formattedValue},`
      })
      .join('\n')
    return `{\n${props}\n${indent}}`
  }

  return String(value)
}

/** Extract storybook/test imports from import statement */
export function extractStorybookTestImports(importStatement: string): string[] {
  const match = importStatement.match(/import\s*\{([^}]+)\}/)
  if (!match || !match[1]) return []
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Escape special regex characters */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Format play function for story */
export function formatPlayFunctionForStory(playLines: string[]): string {
  return playLines
    .map((line, i) => {
      const indented = `  ${line}`
      if (i === playLines.length - 1 && line === '}') {
        return `${indented},`
      }
      return indented
    })
    .join('\n')
}
