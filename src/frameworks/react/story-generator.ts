/**
 * React-specific story generation
 */

import type { SerializedProps } from '../types'
import * as path from 'path'
import {
  type StoryGenerationData,
  type GeneratedStory,
  toValidStoryName,
  generateStoryName,
  getRelativeImportPath,
  hasAnyJSXProps,
  collectComponentRefs,
  collectRequiredImports,
  generateArgsContent,
  formatPlayFunctionForStory,
  printImportStatement,
} from '../../utils/story-generator'
import { writeStoryIntoCsf, type CsfImportRequest } from '../../utils/csf-writer'

/**
 * Generate a React story file from component data
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
  const storyFilePath = path.join(
    componentDir,
    `${componentFileName}.stories.tsx`,
  )

  // Determine story name
  let storyName = customStoryName || generateStoryName(props)
  storyName = toValidStoryName(storyName)

  // Collect component references
  const componentRefs = new Set<string>()
  collectComponentRefs(props, componentRefs)

  // Build imports
  const imports: Array<{ name: string; path: string }> = []

  // Main component import (React: no .jsx/.tsx extension in import path)
  imports.push({
    name: isDefaultExport ? componentName : `{ ${componentName} }`,
    path: `./${componentFileName}`,
  })

  // Referenced components
  if (componentRegistry) {
    for (const refName of componentRefs) {
      if (refName === componentName) continue

      const refFilePath = componentRegistry.get(refName)
      if (refFilePath) {
        const refRelativePath = getRelativeImportPath(componentDir, refFilePath)
        imports.push({
          name: `{ ${refName} }`,
          path: refRelativePath,
        })
      }
    }
  }

  const requiredImports = collectRequiredImports({
    props,
    imports,
    ...(playImports ? { playImports } : {}),
  })
  const storyExportSource = renderStoryExport({
    storyName,
    props,
    ...(componentRegistry ? { componentRegistry } : {}),
    ...(playFunction ? { playFunction } : {}),
  })

  if (!existingContent) {
    return {
      content: generateStoryContent({
        componentName,
        props,
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
  storyName: string
  props: SerializedProps
  componentRegistry?: Map<string, string>
  playFunction?: string[]
}): string {
  const { storyName, props, playFunction } = options
  const argsContent = generateArgsContent(props, 1, options.componentRegistry)
  const hasArgs = Object.keys(props).length > 0
  const hasPlay = playFunction && playFunction.length > 0
  const playContent = hasPlay
    ? `\n${formatPlayFunctionForStory(playFunction)}`
    : ''

  return `export const ${storyName}: Story = {${hasArgs ? `\n  args: ${argsContent},` : ''}${playContent}
};
`
}

/** Generate new story file content: header, imports, then the story export */
function generateStoryContent(options: {
  componentName: string
  props: SerializedProps
  requiredImports: CsfImportRequest[]
  storyExportSource: string
  storybookFramework?: string
}): string {
  const {
    componentName,
    props,
    requiredImports,
    storyExportSource,
    storybookFramework = '@storybook/react-vite',
  } = options

  const importStatements = [
    ...(hasAnyJSXProps(props) ? [`import React from 'react';`] : []),
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
