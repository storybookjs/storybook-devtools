import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Real PTYs and disk writes: hosts share a Storybook port (6006 by default,
// configurable via STORYBOOK_E2E_URL) and symlinked sources.
export default defineConfig({
  ...base,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  projects: base.projects!.map(project => ({
    ...project,
    testMatch: /storybook-integration\.spec\.ts/,
    fullyParallel: false,
  })),
})
