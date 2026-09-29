/**
 * Vue-specific story generation
 */

import type { SerializedProps } from '../types'
import * as path from 'path'
import {
  type StoryGenerationData,
  type GeneratedStory,
  toValidStoryName,
  generateStoryName,
  getRelativeImportPath,
  collectComponentRefs,
  collectRequiredImports,
  generateArgsContent,
  formatPlayFunctionForStory,
  printImportStatement,
} from '../../utils/story-generator'
import { writeStoryIntoCsf, type CsfImportRequest } from '../../utils/csf-writer'

function splitVueSlotArgs(props: SerializedProps): {
  componentArgs: SerializedProps
  slotArgs: Record<string, unknown>
} {
  const componentArgs: SerializedProps = {}
  const slotArgs: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('slot:')) {
      slotArgs[key] = value
    } else {
      componentArgs[key] = value
    }
  }

  return { componentArgs, slotArgs }
}

function isSerializedVueSlot(
  value: unknown,
): value is { __isVueSlot: true; source: string; componentRefs: string[] } {
  if (!value || typeof value !== 'object') return false

  const slot = value as {
    __isVueSlot?: unknown
    source?: unknown
    componentRefs?: unknown
  }

  return (
    slot.__isVueSlot === true &&
    typeof slot.source === 'string' &&
    Array.isArray(slot.componentRefs)
  )
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function collectVueSlotComponentRefs(
  slotArgs: Record<string, unknown>,
  refs: Set<string>,
): void {
  for (const slotValue of Object.values(slotArgs)) {
    if (!isSerializedVueSlot(slotValue)) continue
    for (const ref of slotValue.componentRefs) {
      if (ref) refs.add(ref)
    }
  }
}

function buildVueSlotTemplate(slotArgs: Record<string, unknown>): string {
  const slotEntries = Object.entries(slotArgs)
    .map(([key, value]) => [key.slice('slot:'.length), value] as const)
    .filter(([slotName]) => Boolean(slotName))

  if (slotEntries.length === 0) {
    return ''
  }

  const defaultEntry = slotEntries.find(([slotName]) => slotName === 'default')
  const namedEntries = slotEntries
    .filter(([slotName]) => slotName !== 'default')
    .sort(([a], [b]) => a.localeCompare(b))

  const parts: string[] = []

  if (defaultEntry) {
    const slotValue = defaultEntry[1]
    if (isSerializedVueSlot(slotValue)) {
      parts.push(slotValue.source)
    } else if (typeof slotValue === 'string' && slotValue.trim()) {
      parts.push(escapeHtmlText(slotValue))
    }
  }

  for (const [slotName, slotValue] of namedEntries) {
    if (isSerializedVueSlot(slotValue)) {
      parts.push(`<template #${slotName}>${slotValue.source}</template>`)
    } else if (typeof slotValue === 'string' && slotValue.trim()) {
      parts.push(
        `<template #${slotName}>${escapeHtmlText(slotValue)}</template>`,
      )
    }
  }

  return parts.join('')
}

function buildVueRenderContent(
  componentName: string,
  slotArgs: Record<string, unknown>,
  slotComponentRefs: string[],
): string {
  const slotTemplate = buildVueSlotTemplate(slotArgs)
  if (!slotTemplate) {
    return ''
  }

  const allComponents = [componentName, ...slotComponentRefs].join(', ')

  return `
  render: (args) => ({
    components: { ${allComponents} },
    setup() {
      const componentArgs = Object.fromEntries(
        Object.entries(args).filter(([key]) => !key.startsWith('slot:')),
      );
      return { componentArgs };
    },
    template: \`<${componentName} v-bind="componentArgs">${slotTemplate}</${componentName}>\`,
  }),`
}

/**
 * Generate a Vue story file from component data
 * Vue-specific: imports include .vue extension, uses @storybook/vue3-vite
 */
export async function generateStory(
  data: StoryGenerationData,
): Promise<GeneratedStory> {
  const {
    meta,
    props,
    componentRegistry,
    storyName: customStoryName,
    existingContent,
    playFunction,
    playImports,
    storybookFramework,
  } = data
  const { componentName, filePath, isDefaultExport } = meta

  // Calculate paths
  const componentDir = path.dirname(filePath)
  const componentFileName = path.basename(filePath, path.extname(filePath))
  // Vue uses .stories.ts instead of .stories.tsx
  const storyFilePath = path.join(
    componentDir,
    `${componentFileName}.stories.ts`,
  )

  // Determine story name
  let storyName = customStoryName || generateStoryName(props)
  storyName = toValidStoryName(storyName)

  const { componentArgs, slotArgs } = splitVueSlotArgs(props)

  // Collect component references. The slot refs are also the ones the
  // render function registers, so they are collected on their own first.
  const slotComponentRefs = new Set<string>()
  collectVueSlotComponentRefs(slotArgs, slotComponentRefs)

  const componentRefs = new Set<string>()
  collectComponentRefs(componentArgs, componentRefs)
  for (const ref of slotComponentRefs) componentRefs.add(ref)

  // Build imports
  const imports: Array<{ name: string; path: string }> = []

  // Main component import - Vue requires .vue extension
  imports.push({
    name: isDefaultExport ? componentName : `{ ${componentName} }`,
    path: `./${componentFileName}.vue`,
  })

  // Referenced components - also need .vue extension
  if (componentRegistry) {
    for (const refName of componentRefs) {
      if (refName === componentName) continue

      const refFilePath = componentRegistry.get(refName)
      if (refFilePath) {
        const refRelativePath = getRelativeImportPath(componentDir, refFilePath)
        // Add .vue extension if not already there
        const refImportPath = refRelativePath.endsWith('.vue')
          ? refRelativePath
          : `${refRelativePath}.vue`
        imports.push({
          name: refName,
          path: refImportPath,
        })
      }
    }
  }

  const requiredImports = collectRequiredImports({
    props: componentArgs,
    imports,
    ...(playImports ? { playImports } : {}),
  })
  const storyExportSource = renderStoryExport({
    componentName,
    storyName,
    componentArgs,
    slotArgs,
    slotComponentRefs,
    ...(componentRegistry ? { componentRegistry } : {}),
    ...(playFunction ? { playFunction } : {}),
  })

  if (!existingContent) {
    return {
      content: generateStoryContent({
        componentName,
        requiredImports,
        storyExportSource,
        ...(storybookFramework ? { storybookFramework } : {}),
      }),
      filePath: storyFilePath,
      imports,
      storyName,
    }
  }

  const written = await writeStoryIntoCsf({
    existingCode: existingContent,
    fileName: storyFilePath,
    storyExportSource,
    desiredExportName: storyName,
    requiredImports,
  })

  return {
    content: written.code,
    filePath: storyFilePath,
    imports,
    storyName: written.exportName,
    ...(written.fallbackReason
      ? { fallbackReason: written.fallbackReason }
      : {}),
  }
}

/** Render the story export block, without touching the surrounding file */
function renderStoryExport(options: {
  componentName: string
  storyName: string
  componentArgs: SerializedProps
  slotArgs: Record<string, unknown>
  slotComponentRefs: Set<string>
  componentRegistry?: Map<string, string>
  playFunction?: string[]
}): string {
  const {
    componentName,
    storyName,
    componentArgs,
    slotArgs,
    slotComponentRefs,
    playFunction,
  } = options

  const argsContent = generateArgsContent(
    componentArgs,
    1,
    options.componentRegistry,
  )
  const hasArgs = Object.keys(componentArgs).length > 0

  const renderContent = buildVueRenderContent(
    componentName,
    slotArgs,
    [...slotComponentRefs].sort((a, b) => a.localeCompare(b)),
  )
  const hasPlay = playFunction && playFunction.length > 0
  const playContent = hasPlay
    ? `\n${formatPlayFunctionForStory(playFunction)}`
    : ''

  return `export const ${storyName}: Story = {${renderContent}${hasArgs ? `\n  args: ${argsContent},` : ''}${playContent}
};
`
}

/** Generate new story file content: header, imports, then the story export */
function generateStoryContent(options: {
  componentName: string
  requiredImports: CsfImportRequest[]
  storyExportSource: string
  storybookFramework?: string
}): string {
  const {
    componentName,
    requiredImports,
    storyExportSource,
    storybookFramework = '@storybook/vue3-vite',
  } = options

  const importStatements = [
    `import type { Meta, StoryObj } from '${storybookFramework}';`,
    ...requiredImports.map(printImportStatement),
  ].join('\n')

  return `${importStatements}

const meta: Meta<typeof ${componentName}> = {
  component: ${componentName},
};

export default meta;
type Story = StoryObj<typeof ${componentName}>;

${storyExportSource}`
}
