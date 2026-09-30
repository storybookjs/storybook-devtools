import { registerAgentSuite } from './common-agent-suite'
import { test, expect } from '@playwright/test'
import { registerReactDetectionSuite } from './common-react-detection-suite'
import { registerCommonHighlighterSuite } from './common-highlighter-suite'
import { registerHighlightPanelStateSuite } from './common-highlight-panel-state-suite'
import { registerLivePropEditSuite } from './common-live-prop-edit-suite'
import { registerListenersReplaySuite } from './common-listeners-replay-suite'
import { registerPanelRenderSuite } from './common-panel-render-suite'

registerReactDetectionSuite(test as any, {
  suiteTitle: 'React playground detection coverage',
  taskListFilePath: '/playground/react/src/components/TaskList.tsx',
})
registerCommonHighlighterSuite(test as any)
registerHighlightPanelStateSuite(test as any)
registerLivePropEditSuite(test as any)
registerListenersReplaySuite(test as any)
registerPanelRenderSuite(test as any, expect as any, { componentName: 'TaskCard' })

registerAgentSuite()
