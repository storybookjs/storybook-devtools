/**
 * Merged Storybook + Coverage panel.
 *
 * Served as the devframe's `clientAssets` SPA. Communicates with the server
 * plugin entirely over devframe RPC. All client-side DOM operations are
 * delegated to the app-page client via RPC broadcast so that the panel works
 * whether inline or popped out into a separate window.
 */

import { connectDevframe, type DevframeRpcClient } from 'devframe/client'
import { storyNameFromExport } from 'storybook/internal/csf/csf-utils'
import { propEditability } from '../client/utils/prop-utils'
import { createPropEditor } from '../client/utils/prop-editor'
import {
  findStoryCandidates,
  pickStoryId,
  stripExtForMatch,
} from '../utils/story-matching'
import {
  pickRepresentativeByKey,
  propsFingerprint,
} from '../utils/instance-selection'

// ─── RPC client ─────────────────────────────────────────────────────

let rpcClient: DevframeRpcClient | null = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registrySharedState: any = null

async function initRpcClient() {
  try {
    const client = await connectDevframe()
    await client.ensureTrusted()
    rpcClient = client

    // Boot-time config: the storybookUrl the app was launched with — an
    // auto-derived dock URL can't carry query params, so it arrives over RPC.
    try {
      const config = await client.call('component-highlighter:get-config')
      if (config.storybookUrl) {
        storybookUrl = config.storybookUrl
      }
      if (config.storybookDocsUrl) {
        storybookDocsUrl = config.storybookDocsUrl
      }
      // The Storybook tab renders once before this config arrives — its
      // status banner may show the default URL and a stale "not running";
      // re-check now that the URL and the RPC client are real.
      initStorybookTab()
    } catch {
      // Keep the default storybookUrl
    }

    // Subscribe to shared state
    const regState = await client.sharedState.get(
      'component-highlighter:registry',
    )
    registrySharedState = regState
    // Refresh coverage immediately when the registry changes (e.g. on navigation)
    regState.on('updated', () => {
      if (coverageInterval) {
        // Coverage tab is active — refresh immediately
        refreshCoverage()
      }
    })

    const visitState = await client.sharedState.get(
      'component-highlighter:pending-visit',
    )
    // React to pending visit changes in real time. Shared state values are
    // `{ value }` envelopes (devframe 0.9 requires object states).
    const consumeVisit = (visit: any) => {
      if (!visit) return
      visitState.mutate((s: any) => {
        s.value = null
      }) // consume
      visitStory(visit.relativeFilePath, visit.preferredStoryName)
    }
    consumeVisit(visitState.value()?.value)
    visitState.on('updated', (val: any) => consumeVisit(val?.value))

    const tabState = await client.sharedState.get(
      'component-highlighter:pending-tab',
    )
    const consumeTab = (tab: any) => {
      if (!tab) return
      tabState.mutate((s: any) => {
        s.value = null
      }) // consume
      switchTab(tab as TabId)
    }
    consumeTab(tabState.value()?.value)
    tabState.on('updated', (val: any) => consumeTab(val?.value))

    // Sync highlight toggle button state
    const hlState = await client.sharedState.get(
      'component-highlighter:highlight-active',
    )
    // When the dock activates it enables highlight mode globally.
    // If we're not on the highlighter tab, immediately disable it —
    // only the highlighter tab should have the overlay on while the panel is open.
    // When highlight-active changes (action button toggled), re-sync the
    // highlighter-tab-active state. The client uses highlighter-tab-active to
    // decide whether clicks go to the panel or show the context menu.
    // The panel does NOT call set-highlight-mode — the overlay is driven by
    // the client's subscription to highlighter-tab-active shared state.
    const enforceHighlightForTab = (_dockActive: boolean) => {
      const shouldBeActive = activeTab === 'highlighter'
      highlightEnabled = shouldBeActive
      syncHighlighterTabState(shouldBeActive)
    }
    enforceHighlightForTab(hlState.value()?.value ?? false)
    hlState.on('updated', (val: any) => enforceHighlightForTab(!!val?.value))

    // The client owns overlay visibility; mirror it for the popover label.
    const visState = await client.sharedState.get(
      'component-highlighter:highlights-visible',
    )
    highlightsVisible = visState.value()?.value ?? true
    visState.on('updated', (val: any) => {
      highlightsVisible = val?.value ?? true
    })

    // Subscribe to selected-component shared state
    const selState = await client.sharedState.get(
      'component-highlighter:selected-component',
    )
    selState.on('updated', (val: any) => {
      const next = val?.value
      const unchanged = isSameSelection(next)
      selectedComponent = next
      // Only rebuild if already on the highlighter tab — don't auto-switch
      // when the user is on another tab (context menu handles interaction there).
      if (!unchanged && activeTab === 'highlighter') {
        buildHighlighterPanel()
      }
    })
  } catch {
    // RPC client not available (e.g. during build or test)
  }
}

/**
 * Re-selecting the already-shown component (same instance, same payload)
 * must not rebuild the inspector — a rebuild reloads every story preview
 * iframe, which reads as a flash.
 */
function isSameSelection(next: RegistryInstance | null | undefined): boolean {
  return JSON.stringify(next ?? null) === JSON.stringify(selectedComponent ?? null)
}

/** Convenience wrapper for server RPC calls */
function rpcCall(method: string, ...args: unknown[]): Promise<unknown> {
  if (!rpcClient) return Promise.resolve(undefined)
  // `rpcClient.call` only accepts a literal method name from
  // `DevframeRpcServerFunctions`; this passthrough forwards an arbitrary
  // runtime method string, which no literal-keyed signature can type.
  return (
    rpcClient.call as (m: string, ...a: unknown[]) => Promise<unknown>
  )(method, ...args)
}

/** Sync the highlighter-tab-active shared state so the client knows whether to show context menu */
function syncHighlighterTabState(active: boolean) {
  if (!rpcClient) return
  rpcClient.sharedState
    ?.get('component-highlighter:highlighter-tab-active')
    .then((state: any) =>
      state.mutate((s: any) => {
        s.value = active
      }),
    )
    .catch(() => {})
}

/** Registry instance shape matching the server's SerializedRegistryInstance */
interface RegistryInstance {
  id: string
  meta: {
    componentName: string
    filePath: string
    relativeFilePath?: string
    sourceId: string
    isDefaultExport?: boolean
  }
  serializedProps?: Record<string, unknown>
  isConnected: boolean
  /** Top-level prop keys the user has live-edited (differ from original). */
  editedProps?: string[]
}

// ─── Icons ──────────────────────────────────────────────────────────
const CODE_ICON = `<svg width="12" height="12" viewBox="0 0 14 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.53613 4.31055C7.63877 4.05443 7.92931 3.92987 8.18555 4.03223C8.44167 4.13483 8.56617 4.4254 8.46387 4.68164L6.46387 9.68164C6.36117 9.93761 6.07062 10.0623 5.81445 9.95996C5.55837 9.85739 5.43397 9.56674 5.53613 9.31055L7.53613 4.31055Z" fill="currentColor"/><path d="M3.64648 5.14258C3.84175 4.94762 4.15834 4.94747 4.35352 5.14258C4.5486 5.33775 4.54846 5.65435 4.35352 5.84961L3.20703 6.99609L4.35352 8.14258C4.5486 8.33775 4.54846 8.65435 4.35352 8.84961C4.15826 9.04458 3.84166 9.0447 3.64648 8.84961L2.14648 7.34961C2.04896 7.25205 2.00006 7.12393 2 6.99609C2.00001 6.93207 2.01266 6.86784 2.03711 6.80762C2.04931 6.77763 2.06475 6.74834 2.08301 6.7207L2.14648 6.64258L3.64648 5.14258Z" fill="currentColor"/><path d="M9.64648 5.14258C9.84174 4.94763 10.1583 4.9475 10.3535 5.14258L11.8535 6.64258L11.918 6.7207C11.9363 6.7484 11.9517 6.77755 11.9639 6.80762C11.9883 6.86782 12 6.93209 12 6.99609C11.9999 7.12383 11.9509 7.25208 11.8535 7.34961L10.3535 8.84961C10.1583 9.04455 9.84166 9.0447 9.64648 8.84961C9.45144 8.65443 9.45155 8.33782 9.64648 8.14258L10.793 6.99609L9.64648 5.84961C9.45142 5.65445 9.45158 5.33784 9.64648 5.14258Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M13.5 0C13.7761 0 14 0.223858 14 0.5V11.5L13.9902 11.6006C13.9503 11.7961 13.7961 11.9503 13.6006 11.9902L13.5 12H0.5L0.399414 11.9902C0.203918 11.9503 0.0496648 11.7961 0.00976562 11.6006L0 11.5V0.5C1.28852e-07 0.223858 0.223858 1.20798e-08 0.5 0H13.5ZM1 11H13V3H1V11ZM1.5 1C1.22386 1 1 1.22386 1 1.5C1 1.77614 1.22386 2 1.5 2C1.77614 2 2 1.77614 2 1.5C2 1.22386 1.77614 1 1.5 1ZM3.5 1C3.22386 1 3 1.22386 3 1.5C3 1.77614 3.22386 2 3.5 2C3.77614 2 4 1.77614 4 1.5C4 1.22386 3.77614 1 3.5 1ZM5.5 1C5.22386 1 5 1.22386 5 1.5C5 1.77614 5.22386 2 5.5 2C5.77614 2 6 1.77614 6 1.5C6 1.22386 5.77614 1 5.5 1Z" fill="currentColor"/></svg>`
const PENCIL_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`
const RESET_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`
// SB_LOGO_FULL — dual-color Storybook logo for the rail (pink bg + white S)
const SB_LOGO_FULL = `<svg width="20" height="20" viewBox="-31.5 0 319 319" xmlns="http://www.w3.org/2000/svg"><path fill="#FF4785" d="M9.87,293.32L0.01,30.57C-0.31,21.9,6.34,14.54,15.01,14L238.49,0.03C247.32,-0.52,254.91,6.18,255.47,15.01C255.49,15.34,255.5,15.67,255.5,16V302.32C255.5,311.16,248.33,318.32,239.49,318.32C239.25,318.32,239.01,318.32,238.77,318.31L25.15,308.71C16.83,308.34,10.18,301.65,9.87,293.32Z"/><path fill="#FFF" d="M188.67,39.13L190.19,2.41L220.88,0L222.21,37.86C222.25,39.18,221.22,40.29,219.9,40.33C219.34,40.35,218.79,40.17,218.34,39.82L206.51,30.5L192.49,41.13C191.44,41.93,189.95,41.72,189.15,40.67C188.81,40.23,188.64,39.68,188.67,39.13ZM149.41,119.98C149.41,126.21,191.36,123.22,196.99,118.85C196.99,76.45,174.23,54.17,132.57,54.17C90.91,54.17,67.57,76.79,67.57,110.74C67.57,169.85,147.35,170.98,147.35,203.23C147.35,212.28,142.91,217.65,133.16,217.65C120.46,217.65,115.43,211.17,116.02,189.1C116.02,184.32,67.57,182.82,66.09,189.1C62.33,242.57,95.64,257.99,133.75,257.99C170.69,257.99,199.65,238.3,199.65,202.66C199.65,139.3,118.68,141,118.68,109.6C118.68,96.88,128.14,95.18,133.75,95.18C139.66,95.18,150.3,96.22,149.41,119.98Z"/></svg>`
const COVERAGE_TAB_ICON = `<svg width="16" height="16" viewBox="0 0 10 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.76464 1.0757C9.90598 1.16404 10 1.32104 10 1.5V7.5L9.99992 7.50892C9.9987 7.57865 9.98321 7.64491 9.95623 7.70488C9.92676 7.77041 9.88358 7.82845 9.83035 7.87534L5.3369 11.8695C5.30013 11.9031 5.25937 11.9303 5.21616 11.951C5.14779 11.9838 5.0738 12 5 12C4.9262 12 4.85221 11.9838 4.78384 11.951C4.74062 11.9303 4.69986 11.9031 4.66308 11.8695L0.169665 7.87535L0.161201 7.86772C0.109893 7.82048 0.0706711 7.76488 0.0437672 7.70488C0.0169921 7.64535 0.0015266 7.57963 0.000107183 7.51046L0 7.5V1.5C0 1.32103 0.0940346 1.16401 0.235393 1.07568L0.252579 1.06477C0.268532 1.0548 0.290464 1.04142 0.318377 1.02514C0.374201 0.992577 0.453956 0.94838 0.557643 0.896536C0.765036 0.79284 1.06813 0.658576 1.46689 0.525658C2.2651 0.259589 3.44341 0 5 0C6.55659 0 7.7349 0.259589 8.53311 0.525658C8.93187 0.658576 9.23496 0.79284 9.44236 0.896536C9.54604 0.94838 9.6258 0.992577 9.68162 1.02514C9.70954 1.04142 9.73147 1.0548 9.74742 1.06477L9.76464 1.0757ZM1 1.7934V7.27547L2.06804 8.22483L8.65573 1.63719C8.53022 1.58541 8.38394 1.53003 8.21689 1.47434C7.5151 1.24041 6.44341 1 5 1C3.55659 1 2.4849 1.24041 1.78311 1.47434C1.43187 1.59142 1.17246 1.70716 1.00486 1.79096L1 1.7934ZM5 10.831L2.81674 8.89035L9 2.70713V7.27547L5 10.831Z" fill="currentColor"/></svg>`
const CROSSHAIR_ICON = `<svg width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3.00391C0.447715 3.00391 0 3.45162 0 4.00391V9.00391C0 9.55619 0.447715 10.0039 1 10.0039H4.5C4.77614 10.0039 5 9.78005 5 9.50391C5 9.22776 4.77614 9.00391 4.5 9.00391H1V4.00391L13 4.00391V9.00391H12C11.7239 9.00391 11.5 9.22776 11.5 9.50391C11.5 9.78005 11.7239 10.0039 12 10.0039H13C13.5523 10.0039 14 9.55619 14 9.00391V4.00391C14 3.45162 13.5523 3.00391 13 3.00391H1Z" fill="currentColor"/><path d="M6.45041 7.00643C6.50971 7.00046 6.5704 7.00502 6.62952 7.0209C6.67575 7.03326 6.71935 7.05208 6.75929 7.07634L10.2265 9.09876C10.2664 9.12106 10.3035 9.149 10.3366 9.18222C10.3798 9.22561 10.414 9.27597 10.4384 9.33038C10.4682 9.39673 10.4824 9.46686 10.4822 9.53619C10.4821 9.60554 10.4676 9.67562 10.4374 9.74185C10.4128 9.79612 10.3784 9.84632 10.335 9.8895C10.3018 9.92257 10.2646 9.95035 10.2245 9.97248L9.1496 10.5931L9.8996 11.8921C10.1067 12.2508 9.9838 12.7095 9.62508 12.9166C9.26636 13.1238 8.80767 13.0008 8.60056 12.6421L7.85056 11.3431L6.77563 11.9637C6.73646 11.9873 6.69378 12.0057 6.64855 12.0179C6.58942 12.0339 6.52873 12.0386 6.46941 12.0327C6.39698 12.0258 6.32904 12.0033 6.26895 11.9687C6.2088 11.9342 6.15518 11.8869 6.11265 11.8278C6.07771 11.7795 6.05119 11.7247 6.03524 11.6656C6.02298 11.6204 6.01735 11.5743 6.018 11.5285L6.00012 7.51465C5.99908 7.46793 6.00458 7.42076 6.017 7.37454C6.03285 7.31525 6.05933 7.26029 6.09428 7.21183C6.13666 7.15281 6.1901 7.10543 6.25004 7.0709C6.31004 7.03618 6.37794 7.01357 6.45041 7.00643Z" fill="currentColor"/></svg>`
// const DOCS_TAB_ICON = `<svg width="16" height="16" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5.5C3 5.22386 3.22386 5 3.5 5H8.5C8.77614 5 9 5.22386 9 5.5C9 5.77614 8.77614 6 8.5 6H3.5C3.22386 6 3 5.77614 3 5.5Z" fill="currentColor"/><path d="M3.5 7.5C3.22386 7.5 3 7.72386 3 8C3 8.27614 3.22386 8.5 3.5 8.5H8.5C8.77614 8.5 9 8.27614 9 8C9 7.72386 8.77614 7.5 8.5 7.5H3.5Z" fill="currentColor"/><path d="M3 10.5C3 10.2239 3.22386 10 3.5 10H8.5C8.77614 10 9 10.2239 9 10.5C9 10.7761 8.77614 11 8.5 11H3.5C3.22386 11 3 10.7761 3 10.5Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M0.5 0C0.223858 0 0 0.223857 0 0.5V13.5C0 13.7761 0.223858 14 0.5 14H11.5C11.7761 14 12 13.7761 12 13.5V3.20711C12 3.0745 11.9473 2.94732 11.8536 2.85355L9.14645 0.146447C9.05268 0.0526784 8.9255 0 8.79289 0H0.5ZM1 1H8.5V3C8.5 3.27614 8.72386 3.5 9 3.5H11V13H1V1Z" fill="currentColor"/></svg>`
const HELP_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M6.5 6.5a1.5 1.5 0 1 1 1.5 1.5v1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/><circle cx="8" cy="11.5" r="0.75" fill="currentColor"/></svg>`
const DOCS_TAB_ICON = `<svg width="14" height="14" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5.5C3 5.22386 3.22386 5 3.5 5H8.5C8.77614 5 9 5.22386 9 5.5C9 5.77614 8.77614 6 8.5 6H3.5C3.22386 6 3 5.77614 3 5.5Z" fill="currentColor"/><path d="M3.5 7.5C3.22386 7.5 3 7.72386 3 8C3 8.27614 3.22386 8.5 3.5 8.5H8.5C8.77614 8.5 9 8.27614 9 8C9 7.72386 8.77614 7.5 8.5 7.5H3.5Z" fill="currentColor"/><path d="M3 10.5C3 10.2239 3.22386 10 3.5 10H8.5C8.77614 10 9 10.2239 9 10.5C9 10.7761 8.77614 11 8.5 11H3.5C3.22386 11 3 10.7761 3 10.5Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M0.5 0C0.223858 0 0 0.223857 0 0.5V13.5C0 13.7761 0.223858 14 0.5 14H11.5C11.7761 14 12 13.7761 12 13.5V3.20711C12 3.0745 11.9473 2.94732 11.8536 2.85355L9.14645 0.146447C9.05268 0.0526784 8.9255 0 8.79289 0H0.5ZM1 1H8.5V3C8.5 3.27614 8.72386 3.5 9 3.5H11V13H1V1Z" fill="currentColor"/></svg>`
const EYE_ICON = `<svg width="12" height="12" viewBox="0 0 11.2368 13.9999" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0.659982 0.615712C0.278813 0.639535 -0.013819 0.962974 0.000504064 1.34462L0.434194 12.9005C0.447931 13.2665 0.740084 13.5608 1.106 13.5773L10.5014 13.9992C10.5119 13.9997 10.5224 13.9999 10.533 13.9999C10.9217 13.9999 11.2368 13.6848 11.2368 13.2961V0.703904C11.2368 0.689258 11.2364 0.674615 11.2355 0.659997C11.2112 0.272012 10.877 -0.0228544 10.4891 0.00139464L9.71642 0.0497456L9.77284 1.6653C9.77487 1.72325 9.72953 1.77187 9.67157 1.7739C9.64676 1.77476 9.62244 1.76681 9.60293 1.75144L9.08239 1.34138L8.46609 1.80888C8.41989 1.84393 8.35402 1.83489 8.31898 1.78869C8.30422 1.76924 8.29671 1.74526 8.29772 1.72087L8.36369 0.134291L0.659982 0.615712ZM8.66356 5.36294C8.41593 5.5553 6.57131 5.68655 6.57131 5.4127C6.6103 4.36774 6.14247 4.32193 5.88256 4.32193C5.63565 4.32193 5.2198 4.39657 5.2198 4.95637C5.2198 5.52683 5.82752 5.84888 6.54082 6.22689C7.55413 6.76387 8.78051 7.41377 8.78051 9.04913C8.78051 10.6166 7.50697 11.4824 5.88256 11.4824C4.20616 11.4824 2.74118 10.8042 2.90663 8.45275C2.97161 8.17663 5.10284 8.24225 5.10284 8.45275C5.07685 9.42307 5.29777 9.70845 5.85657 9.70845C6.28541 9.70845 6.48034 9.47209 6.48034 9.07401C6.48034 8.47157 5.84715 8.11607 5.11874 7.7071C4.13246 7.15336 2.97161 6.50161 2.97161 5.00613C2.97161 3.51333 3.99824 2.51813 5.83058 2.51813C7.66292 2.51813 8.66356 3.49808 8.66356 5.36294Z" fill="currentColor"/></svg>`
const PLUS_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`
const CHECK_ICON = `<svg width="12" height="12" viewBox="0 0 14 9.5" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13.8536 0.853553C14.0488 0.658291 14.0488 0.341709 13.8536 0.146447C13.6583 -0.0488155 13.3417 -0.0488155 13.1464 0.146447L5 8.29289L0.853553 4.14645C0.658291 3.95118 0.341709 3.95118 0.146447 4.14645C-0.0488155 4.34171 -0.0488155 4.65829 0.146447 4.85355L4.64645 9.35355C4.84171 9.54882 5.15829 9.54882 5.35355 9.35355L13.8536 0.853553Z" fill="currentColor"/></svg>`
const ELLIPSIS_ICON = `<svg width="12" height="3" viewBox="0 0 12 3" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1.5C3 2.32843 2.32843 3 1.5 3C0.671573 3 0 2.32843 0 1.5C0 0.671573 0.671573 0 1.5 0C2.32843 0 3 0.671573 3 1.5Z" fill="currentColor"/><path d="M12 1.5C12 2.32843 11.3284 3 10.5 3C9.67157 3 9 2.32843 9 1.5C9 0.671573 9.67157 0 10.5 0C11.3284 0 12 0.671573 12 1.5Z" fill="currentColor"/><path d="M6 3C6.82843 3 7.5 2.32843 7.5 1.5C7.5 0.671573 6.82843 0 6 0C5.17157 0 4.5 0.671573 4.5 1.5C4.5 2.32843 5.17157 3 6 3Z" fill="currentColor"/></svg>`
const WARNING_ICON = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.134 2.5a1 1 0 0 1 1.732 0l5.196 9A1 1 0 0 1 13.196 13H2.804a1 1 0 0 1-.866-1.5l5.196-9Z" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M8 6v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="11" r="0.7" fill="currentColor"/></svg>`
const BULLSEYE_ICON = `<svg width="12" height="12" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 7C0 3.13401 3.13401 0 7 0C10.866 0 14 3.13401 14 7C14 10.866 10.866 14 7 14C3.13401 14 0 10.866 0 7ZM6.5 10.5V12.9795C3.5851 12.739 1.26101 10.4149 1.02054 7.5H3.5C3.77614 7.5 4 7.27614 4 7C4 6.72386 3.77614 6.5 3.5 6.5H1.02054C1.26101 3.5851 3.5851 1.26101 6.5 1.02054V3.5C6.5 3.77614 6.72386 4 7 4C7.27614 4 7.5 3.77614 7.5 3.5V1.02054C10.4149 1.26101 12.739 3.5851 12.9795 6.5H10.5C10.2239 6.5 10 6.72386 10 7C10 7.27614 10.2239 7.5 10.5 7.5H12.9795C12.739 10.4149 10.4149 12.739 7.5 12.9795V10.5C7.5 10.2239 7.27614 10 7 10C6.72386 10 6.5 10.2239 6.5 10.5Z" fill="currentColor"/></svg>`

// ─── Types ──────────────────────────────────────────────────────────

interface CoverageEntry {
  componentName: string
  filePath: string
  relativeFilePath: string
  hasStory: boolean
  storyPath: string | null
}

interface CoverageData {
  entries: CoverageEntry[]
  totalComponents: number
  coveredComponents: number
  coveragePercent: number
}

// ─── Helpers ────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function coverageColorClass(pct: number): string {
  if (pct >= 80) return 'green'
  if (pct >= 50) return 'yellow'
  if (pct >= 25) return 'orange'
  return 'red'
}

const OPEN_SERVICE = '@devframes/service-open'

function openInEditor(filePath: string) {
  const client = rpcClient as unknown as {
    services?: { has: (pkg: string) => boolean }
    call: (method: string, ...args: unknown[]) => Promise<unknown>
  } | null
  if (client?.services?.has(OPEN_SERVICE)) {
    client
      .call('devframes:service:open:open-in-editor', { path: filePath })
      .catch(() => {})
    return
  }
  // Vite's built-in endpoint — the fallback on hosts without the service.
  fetch(`/__open-in-editor?file=${encodeURIComponent(filePath)}`).catch(
    () => {},
  )
}

/** The Storybook URL, fetched once via the `get-config` RPC at boot. */
let storybookUrl = 'http://localhost:6006'

/** Framework-specific docs page, fetched with the config; generic fallback until then. */
let storybookDocsUrl = 'https://storybook.js.org/docs'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The Storybook URL, with its hostname aligned to the page's when both are
 * loopback. `localhost` and `127.0.0.1` are different *sites* to the
 * browser, so an embedded cross-site Storybook is denied storage access
 * (third-party blocking) and its manager boots to a blank page.
 */
function getStorybookUrl(): string {
  try {
    const url = new URL(storybookUrl)
    const pageHost = window.location.hostname
    if (
      LOOPBACK_HOSTS.has(url.hostname) &&
      LOOPBACK_HOSTS.has(pageHost) &&
      url.hostname !== pageHost
    ) {
      url.hostname = pageHost
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    /* malformed configured URL — use as-is */
  }
  return storybookUrl
}

// ─── Visit Story ────────────────────────────────────────────────────

interface StorybookIndexEntry {
  id: string
  title: string
  name: string
  importPath: string
  type: string
}

let storybookIndexCache: Record<string, StorybookIndexEntry> | null = null
let storybookIndexFetchedAt = 0

async function getStorybookIndex(): Promise<
  Record<string, StorybookIndexEntry>
> {
  // Cache for 30 seconds
  if (storybookIndexCache && Date.now() - storybookIndexFetchedAt < 30_000) {
    return storybookIndexCache
  }
  try {
    const data = (await rpcCall('component-highlighter:storybook-index')) as {
      entries?: Record<string, StorybookIndexEntry>
    }
    storybookIndexCache = data.entries || {}
    storybookIndexFetchedAt = Date.now()
    return storybookIndexCache!
  } catch {
    return {}
  }
}

/**
 * Find a story ID by matching the component's relative file path against
 * Storybook index entries (shared matcher: `src/utils/story-matching.ts`).
 *
 * `requirePreferred` makes the lookup fail (null) unless the preferred story
 * name is actually present — used while polling a possibly-stale index for a
 * story that was just created, where falling back to an OLDER story of the
 * same component would navigate to the wrong story.
 */
async function findStoryId(
  relativeFilePath: string,
  preferredStoryName?: string,
  opts: { requirePreferred?: boolean } = {},
): Promise<string | null> {
  const entries = await getStorybookIndex()
  if (!entries || Object.keys(entries).length === 0) return null
  return pickStoryId(entries, relativeFilePath, preferredStoryName, opts)
}

/**
 * Build a Storybook URL for a specific story.
 * Returns null if no matching story is found.
 */
async function buildStoryUrl(
  relativeFilePath: string,
  preferredStoryName?: string,
): Promise<string | null> {
  const storyId = await findStoryId(relativeFilePath, preferredStoryName)
  if (!storyId) return null
  const sbUrl = getStorybookUrl()
  return `${sbUrl}/?path=/story/${encodeURIComponent(storyId)}&nav=0`
}

/**
 * Navigate to a story in the Storybook iframe.
 *
 * @param relativeFilePath - Component's relative file path.
 * @param preferredStoryName - Optional story name to prefer when multiple
 *   stories exist for the component (e.g. the name used during creation).
 *   When provided, the function will also retry index lookups with cache
 *   invalidation so that a story that was just written to disk is found even
 *   before Storybook's HMR cycle finishes.
 */
async function visitStory(
  relativeFilePath: string,
  preferredStoryName?: string,
) {
  const running = await checkStorybook()
  if (running) {
    // Fast path: Storybook is already running, index is available.
    // For newly created stories the index cache may be stale — bust it and
    // retry until the story appears (Storybook needs a moment to process HMR).
    const maxAttempts = preferredStoryName ? 20 : 1
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // Bust the index cache so we re-fetch on the next iteration
        storybookIndexCache = null
        await new Promise((r) => setTimeout(r, 500))
      }
      // While waiting for the (possibly stale) index to pick up a
      // just-created story, do NOT accept a fallback to an older story of
      // the same component — that would navigate to the wrong story and
      // short-circuit the retry loop. Only the final attempt may fall back.
      const storyId = await findStoryId(relativeFilePath, preferredStoryName, {
        requirePreferred: !!preferredStoryName && attempt < maxAttempts - 1,
      })
      if (storyId) {
        switchTab('storybook')
        // Try channel API first (no reload), fall back to iframe src navigation
        if (!navigateStorybookViaChannel(storyId)) {
          const targetUrl = await buildStoryUrl(
            relativeFilePath,
            preferredStoryName,
          )
          if (targetUrl) navigateStorybookPane(targetUrl)
        }
        return
      }
    }
    return
  }

  // Start Storybook and navigate once ready. Stay on the Storybook tab —
  // the pane shows the starting state; the log stays a click away in the
  // Terminals dock (not force-switched).
  renderStorybookState('starting')
  try {
    await rpcCall('component-highlighter:start-storybook')
  } catch {
    // Server may not support terminal start
  }

  switchTab('storybook')

  // Poll until Storybook is ready, then build the URL and navigate
  let attempts = 0
  const poll = setInterval(async () => {
    attempts++
    const status = await getStorybookStatus()
    if (status.startFailure) {
      clearInterval(poll)
      markStorybookStartFailed(status.startFailure)
      return
    }
    if (status.running) {
      clearInterval(poll)
      renderStorybookState('running')
      switchTab('storybook')
      // Storybook just started — index may take a moment to become available
      for (let retry = 0; retry < 10; retry++) {
        storybookIndexCache = null
        const storyId = await findStoryId(relativeFilePath, preferredStoryName, {
          requirePreferred: !!preferredStoryName && retry < 9,
        })
        if (storyId) {
          if (!navigateStorybookViaChannel(storyId)) {
            const targetUrl = await buildStoryUrl(
              relativeFilePath,
              preferredStoryName,
            )
            if (targetUrl) navigateStorybookPane(targetUrl)
          }
          break
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    } else if (attempts > 120) {
      clearInterval(poll)
      renderStorybookState('not-running')
    }
  }, 1000)
}

// ─── Action popover (singleton, reused per row) ─────────────────────────────
let _actionPopover: HTMLDivElement | null = null

function getActionPopover(): HTMLDivElement {
  if (!_actionPopover) {
    _actionPopover = document.createElement('div')
    _actionPopover.className = 'act-popover'
    _actionPopover.hidden = true
    document.body.appendChild(_actionPopover)
    document.addEventListener('click', () => {
      if (_actionPopover) _actionPopover.hidden = true
    })
  }
  return _actionPopover
}

/**
 * Open the popover right-aligned to the anchor, below it — or above when a
 * row near the viewport bottom would push items off-screen; clamp when
 * neither side fully fits.
 */
function positionPopover(popover: HTMLDivElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect()
  popover.style.left = `${rect.right}px`
  popover.style.transform = 'translateX(-100%)'
  popover.style.top = `${rect.bottom + 4}px`
  popover.hidden = false
  const height = popover.offsetHeight
  if (rect.bottom + 4 + height > window.innerHeight) {
    const above = rect.top - 4 - height
    popover.style.top = `${above >= 0 ? above : Math.max(4, window.innerHeight - height - 4)}px`
  }
}

function makePopoverItem(
  icon: string,
  label: string,
  action: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'act-popover-item'
  btn.innerHTML = `${icon}<span>${label}</span>`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    getActionPopover().hidden = true
    action()
  })
  return btn
}

function showActionPopover(anchor: HTMLElement, entry: CoverageEntry) {
  const popover = getActionPopover()
  // Toggle off if already open for this entry
  if (!popover.hidden && popover.dataset['entry'] === entry.componentName) {
    popover.hidden = true
    return
  }

  popover.innerHTML = ''
  popover.dataset['entry'] = entry.componentName

  popover.appendChild(
    makePopoverItem(BULLSEYE_ICON, 'Locate component', () => {
      rpcCall('component-highlighter:scroll-to-component', {
        componentName: entry.componentName,
      }).catch(() => {})
    }),
  )
  popover.appendChild(
    makePopoverItem(CODE_ICON, 'Open component in editor', () =>
      openInEditor(entry.filePath),
    ),
  )
  if (entry.hasStory && entry.storyPath) {
    popover.appendChild(
      makePopoverItem(CODE_ICON, 'Open story in editor', () =>
        openInEditor(entry.storyPath!),
      ),
    )
  }
  if (entry.hasStory) {
    popover.appendChild(
      makePopoverItem(EYE_ICON, 'View story in Storybook', () =>
        visitStory(entry.relativeFilePath),
      ),
    )
  }

  positionPopover(popover, anchor)
}

/**
 * Navigate to a story via the Storybook channel API (postMessage).
 * This avoids a full page reload when Storybook is already loaded.
 * Returns true if the channel was available and the message was sent.
 */
function navigateStorybookViaChannel(storyId: string): boolean {
  const iframe = document.querySelector<HTMLIFrameElement>('.sb-iframe')
  if (!iframe?.contentWindow) return false
  try {
    const channel = (iframe.contentWindow as any).__STORYBOOK_ADDONS_CHANNEL__
    if (!channel || typeof channel.emit !== 'function') return false
    channel.emit('setCurrentStory', { storyId, viewMode: 'story' })
    return true
  } catch {
    return false // cross-origin or not loaded yet
  }
}

/** Set the Storybook iframe to a given URL, creating it if needed. */
function navigateStorybookPane(targetUrl: string) {
  const pane = document.getElementById('pane-storybook')
  if (!pane) return

  const iframe = pane.querySelector<HTMLIFrameElement>('.sb-iframe')
  if (iframe) {
    iframe.src = targetUrl
  } else {
    pane.innerHTML = `<iframe class="sb-iframe" src="${esc(targetUrl)}"></iframe>`
  }
}

// Register panel-side client RPC handlers so the server can communicate with the panel
// in real time (works whether panel is inline or popped out)
function registerPanelRpcHandlers() {
  if (!rpcClient?.client) return
  try {
    rpcClient.client.register({
      name: 'component-highlighter:do-visit-story',
      type: 'action',
      handler: (data: {
        relativeFilePath: string
        preferredStoryName?: string
      }) => {
        visitStory(data.relativeFilePath, data.preferredStoryName)
      },
    } as any)

    rpcClient.client.register({
      name: 'component-highlighter:do-switch-tab',
      type: 'action',
      handler: (data: { tab: string }) => {
        switchTab(data.tab as TabId)
      },
    } as any)

    rpcClient.client.register({
      name: 'component-highlighter:do-select-component',
      type: 'action',
      handler: (data: RegistryInstance | null) => {
        const unchanged = isSameSelection(data)
        selectedComponent = data
        if (!unchanged && activeTab === 'highlighter') {
          buildHighlighterPanel()
        }
      },
    } as any)
  } catch {
    // Client RPC registration not supported in this context
  }
}

/** Ask the client to remove all coverage highlight overlays via RPC */
function clearAllHighlights() {
  rpcCall('component-highlighter:highlight-coverage-instances', null).catch(
    () => {},
  )
}

// ─── Tab management ─────────────────────────────────────────────────

type TabId = 'storybook' | 'highlighter' | 'coverage' | 'about'

let activeTab: TabId = 'storybook'
let coverageInterval: ReturnType<typeof setInterval> | null = null

let highlightEnabled = false
let highlightsVisible = true

// devframe's built-in Terminals dock (hub-ui's dock id — not exported by
// the package) and the Storybook session id the start-storybook RPC spawns.
const TERMINALS_DOCK_ID = 'devframes_plugin_terminals'
const STORYBOOK_SESSION_ID = 'storybook-dev'

/** Switch the host viewer to the Terminals dock, on the Storybook session. */
function openStorybookTerminal() {
  rpcCall('hub:docks:activate', {
    dockId: TERMINALS_DOCK_ID,
    params: { sessionId: STORYBOOK_SESSION_ID },
  }).catch(() => {
    // host without the terminals dock — nothing to open
  })
}

function switchTab(tab: TabId) {
  activeTab = tab
  clearAllHighlights()

  // Update rail buttons
  document.querySelectorAll('.rail-btn[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab)
  })

  // Update tab panes
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `pane-${tab}`)
  })

  // Sync highlighter-tab-active shared state. The client subscribes to this
  // to enable/disable the overlay — no direct set-highlight-mode RPC needed.
  highlightEnabled = tab === 'highlighter'
  syncHighlighterTabState(highlightEnabled)

  if (tab === 'highlighter') {
    buildHighlighterPanel()
  }

  // Start/stop coverage polling
  if (tab === 'coverage') {
    refreshCoverage()
    if (!coverageInterval) {
      coverageInterval = setInterval(refreshCoverage, 5000)
    }
  } else {
    if (coverageInterval) {
      clearInterval(coverageInterval)
      coverageInterval = null
    }
  }

}

// ─── Storybook tab ──────────────────────────────────────────────────

type SbState = 'checking' | 'not-running' | 'starting' | 'running' | 'failed'
type SbStartFailure = { code: number | null; detail?: string | null }
type SbStatus = {
  running: boolean
  startFailure?: SbStartFailure | null | undefined
  /** Whether the host has a Terminals dock the Storybook session can be opened in. */
  terminalDockAvailable?: boolean
}

/**
 * Last known answer from `storybook-status`. Render "Open Terminal" only
 * when the host reports an available dock.
 */
let terminalDockAvailable = false

function openTerminalButton(id: string): string {
  return terminalDockAvailable
    ? `<button class="start-btn" id="${id}">Open Terminal</button>`
    : ''
}

function renderStorybookState(state: SbState, failure?: SbStartFailure | null) {
  const pane = document.getElementById('pane-storybook')
  if (!pane) return

  const sbUrl = getStorybookUrl()

  switch (state) {
    case 'checking':
      pane.innerHTML = `
        <div class="sb-state">
          <div class="spinner"></div>
          <div class="msg">Checking if Storybook is running\u2026</div>
        </div>`
      break

    case 'not-running':
      pane.innerHTML = `
        <div class="sb-state">
          <div class="msg">Storybook is not running at <strong>${esc(sbUrl)}</strong></div>
          <button class="start-btn" id="sb-start-btn">Start Storybook</button>
        </div>`
      document
        .getElementById('sb-start-btn')
        ?.addEventListener('click', startStorybook)
      break

    case 'starting':
      pane.innerHTML = `
        <div class="sb-state">
          <div class="spinner"></div>
          <div class="msg">Starting Storybook\u2026</div>
          ${openTerminalButton('sb-viewlog-btn')}
        </div>`
      document
        .getElementById('sb-viewlog-btn')
        ?.addEventListener('click', openStorybookTerminal)
      break

    case 'running':
      pane.innerHTML = `<iframe class="sb-iframe" src="${esc(sbUrl)}"></iframe>`
      break

    case 'failed':
      pane.innerHTML = `
        <div class="sb-state">
          <div class="msg">Storybook failed to start${
            failure?.code != null ? ` (exit code ${failure.code})` : ''
          }</div>
          ${
            failure?.detail
              ? `<pre class="sb-error-detail">${esc(failure.detail)}</pre>`
              : ''
          }
          <div class="btn-row">
            ${openTerminalButton('sb-error-btn')}
            <button class="start-btn" id="sb-retry-btn">Try again</button>
          </div>
        </div>`
      document
        .getElementById('sb-error-btn')
        ?.addEventListener('click', openStorybookTerminal)
      document
        .getElementById('sb-retry-btn')
        ?.addEventListener('click', startStorybook)
      break
  }
}

/**
 * Put the Storybook pane into its failed state — the failure detail lives
 * in the Terminals dock's Storybook session, a click away via its button on
 * hosts that have that dock.
 */
function markStorybookStartFailed(failure: SbStartFailure | null | undefined) {
  renderStorybookState('failed', failure)
  switchTab('storybook')
}

async function getStorybookStatus(): Promise<SbStatus> {
  try {
    const data = (await rpcCall(
      'component-highlighter:storybook-status',
    )) as SbStatus
    terminalDockAvailable = data.terminalDockAvailable === true
    return { running: data.running === true, startFailure: data.startFailure }
  } catch {
    return { running: false }
  }
}

async function checkStorybook(): Promise<boolean> {
  return (await getStorybookStatus()).running
}

async function initStorybookTab() {
  renderStorybookState('checking')
  const running = await checkStorybook()
  renderStorybookState(running ? 'running' : 'not-running')
}

async function startStorybook() {
  renderStorybookState('starting')

  try {
    await rpcCall('component-highlighter:start-storybook')
  } catch {
    // Server may not support terminal start; fall through to polling
  }

  // Poll until Storybook is ready (max ~120s)
  let attempts = 0
  const poll = setInterval(async () => {
    attempts++
    const status = await getStorybookStatus()
    if (status.startFailure) {
      clearInterval(poll)
      markStorybookStartFailed(status.startFailure)
    } else if (status.running) {
      clearInterval(poll)
      renderStorybookState('running')
      // Auto-switch back to the Storybook tab once it's up
      switchTab('storybook')
    } else if (attempts > 120) {
      clearInterval(poll)
      renderStorybookState('not-running')
    }
  }, 1000)
}

// ─── Story creation from coverage ───────────────────────────────────

/** Suggest a story name based on meaningful prop values */
function suggestStoryName(props: Record<string, unknown>): string {
  const meaningfulProps = ['variant', 'type', 'size', 'mode', 'status', 'kind', 'color', 'intent', 'appearance']
  for (const propName of meaningfulProps) {
    const value = props[propName]
    if (typeof value === 'string' && value.length > 0 && value.length < 30) {
      return value.charAt(0).toUpperCase() + value.slice(1)
    }
  }
  for (const [, value] of Object.entries(props)) {
    if (typeof value === 'boolean' && value) continue
    if (typeof value === 'string' && value.length > 0 && value.length < 30) {
      return value.charAt(0).toUpperCase() + value.slice(1)
    }
  }
  return 'Default'
}

/** Fetch the registry snapshot from the server (RPC) */
/** Read the registry from shared state (synced automatically from client) */
function fetchRegistry(): RegistryInstance[] {
  try {
    return (registrySharedState?.value() as RegistryInstance[]) ?? []
  } catch {
    return []
  }
}

/** A representative instance picked for story creation, plus its position among live siblings sharing the same filePath (for the creation toast). */
interface InstanceSelection {
  instance: RegistryInstance
  /** 1-based position among all connected instances of this component. */
  index: number
  /** Total connected instances of this component (siblings). */
  total: number
}

/**
 * Collect unique instances of a component from the server registry snapshot,
 * deduplicated by their serialized props fingerprint. When several instances
 * share a fingerprint, the one carrying live edits is kept (see
 * `pickRepresentativeByKey`) so an edited sibling's props are never silently
 * dropped in favor of an unedited one.
 */
async function collectUniqueInstances(
  filePath: string,
): Promise<InstanceSelection[]> {
  const instances = await fetchRegistry()
  const matching = instances.filter(
    (i) => i.meta?.filePath === filePath && i.isConnected,
  )
  const representatives = pickRepresentativeByKey(matching, (i) =>
    i.serializedProps ? propsFingerprint(i.serializedProps) : '{}',
  )
  return representatives.map((instance) => ({
    instance,
    index: matching.indexOf(instance) + 1,
    total: matching.length,
  }))
}

/**
 * Collect all unique visible instances across ALL components from the server
 * registry snapshot. Deduplicates by (filePath + propsFingerprint), same
 * edited-instance preference as `collectUniqueInstances`.
 */
async function collectAllVisibleInstances(): Promise<InstanceSelection[]> {
  const instances = await fetchRegistry()
  const connected = instances.filter((i) => i.meta?.filePath && i.isConnected)
  const representatives = pickRepresentativeByKey(connected, (i) => {
    const fp = i.serializedProps ? propsFingerprint(i.serializedProps) : '{}'
    return `${i.meta.filePath}::${fp}`
  })
  return representatives.map((instance) => {
    const siblings = connected.filter(
      (i) => i.meta.filePath === instance.meta.filePath,
    )
    return {
      instance,
      index: siblings.indexOf(instance) + 1,
      total: siblings.length,
    }
  })
}

/**
 * Create stories for a component by calling the server's create-story RPC
 * directly with instance data from the registry snapshot.
 */
async function createStoryForComponent(filePath: string): Promise<boolean> {
  const selections = await collectUniqueInstances(filePath)
  if (selections.length === 0) return false

  for (const { instance, index, total } of selections) {
    try {
      await rpcCall('component-highlighter:create-story', {
        meta: instance.meta,
        serializedProps: instance.serializedProps,
        ...(total > 1 ? { sourceInstance: { index, total } } : {}),
      })
    } catch {
      // Best effort; continue with remaining instances
    }
  }
  return true
}

/**
 * Check whether a component is currently rendered using the server registry snapshot.
 */
// ─── Coverage tab ───────────────────────────────────────────────────

let lastCoverageJson = ''
let lastVisibilityKey = ''

async function fetchCoverage(): Promise<CoverageData | null> {
  try {
    return (await rpcCall(
      'component-highlighter:get-coverage',
    )) as CoverageData
  } catch {
    return null
  }
}

/** Build a key from the registry's connected file paths to detect navigation. */
function computeRegistryKey(): string {
  const instances = fetchRegistry()
  const paths = new Set<string>()
  for (const inst of instances) {
    if (inst.meta?.filePath && inst.isConnected) {
      paths.add(inst.meta.filePath)
    }
  }
  return [...paths].sort().join('|')
}

async function refreshCoverage() {
  const coverage = await fetchCoverage()
  if (!coverage) return

  // Rebuild when server-side coverage data or visible components change
  const json = JSON.stringify(coverage)
  const regKey = computeRegistryKey()
  if (json === lastCoverageJson && regKey === lastVisibilityKey) return
  lastCoverageJson = json
  lastVisibilityKey = regKey

  clearAllHighlights()
  await buildCoveragePanel(coverage)
}

async function buildCoveragePanel(coverage: CoverageData) {
  const pane = document.getElementById('pane-coverage')
  if (!pane) return

  // Filter to only components visible on the current page
  const registryInstances = await fetchRegistry()
  const visibleFilePaths = new Set<string>()
  for (const inst of registryInstances) {
    if (inst.meta?.filePath && inst.isConnected) {
      visibleFilePaths.add(inst.meta.filePath)
    }
  }
  const visibleEntries = coverage.entries.filter((e) =>
    visibleFilePaths.has(e.filePath),
  )
  const totalVisible = visibleEntries.length
  const coveredVisible = visibleEntries.filter((e) => e.hasStory).length
  const pctVisible =
    totalVisible > 0 ? Math.round((coveredVisible / totalVisible) * 100) : 0
  const cc = coverageColorClass(pctVisible)

  const missingEntries = visibleEntries.filter((e) => !e.hasStory)
  const coveredEntries = visibleEntries.filter((e) => e.hasStory)

  const root = document.createElement('div')
  root.className = 'coverage-root'

  // ── Header with donut chart ──
  const hdr = document.createElement('div')
  hdr.className = 'cov-hdr'

  const hdrText = document.createElement('div')
  hdrText.className = 'cov-hdr-text'
  const title = document.createElement('h2')
  title.textContent = 'Coverage'
  hdrText.appendChild(title)
  const subtitle = document.createElement('div')
  subtitle.className = 'cov-hdr-subtitle'
  subtitle.textContent = `${coveredVisible}/${totalVisible} components on this page have stories`
  hdrText.appendChild(subtitle)
  hdr.appendChild(hdrText)

  // Donut chart
  const donut = document.createElement('div')
  donut.className = 'cov-donut'
  const r = 18 // radius
  const circumference = 2 * Math.PI * r
  const offset = circumference - (pctVisible / 100) * circumference
  donut.innerHTML = `
    <svg viewBox="0 0 44 44">
      <circle class="cov-donut-track" cx="22" cy="22" r="${r}" />
      <circle class="cov-donut-fill ${cc}" cx="22" cy="22" r="${r}"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" />
    </svg>
    <span class="cov-donut-label">${pctVisible}</span>
  `
  hdr.appendChild(donut)
  root.appendChild(hdr)

  // Empty state
  if (visibleEntries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent =
      'No components detected yet. Navigate your app to discover components.'
    root.appendChild(empty)
    pane.innerHTML = ''
    pane.appendChild(root)
    return
  }

  // Highlight/clear helpers — delegate to client via RPC broadcast
  const highlightInstances = (componentName: string, hasStory: boolean) => {
    rpcCall('component-highlighter:highlight-coverage-instances', {
      componentName,
      hasStory,
    }).catch(() => {})
  }

  const clearHighlights = () => {
    rpcCall('component-highlighter:highlight-coverage-instances', null).catch(
      () => {},
    )
  }

  // Scrollable wrapper for both sections
  const listWrap = document.createElement('div')
  listWrap.className = 'cov-list-wrap'

  // ── Missing section ──
  if (missingEntries.length > 0) {
    const section = document.createElement('div')
    section.className = 'cov-section'

    const sectionHdr = document.createElement('div')
    sectionHdr.className = 'cov-section-hdr'

    const sectionTitle = document.createElement('span')
    sectionTitle.className = 'cov-section-title'
    sectionTitle.innerHTML = `Missing<span class="cov-section-count">${missingEntries.length}</span>`
    sectionHdr.appendChild(sectionTitle)

    const sectionActions = document.createElement('div')
    sectionActions.className = 'cov-section-actions'

    // Preview button — highlights all uncovered components on the page
    const previewBtn = document.createElement('button')
    previewBtn.className = 'cov-preview-btn'
    previewBtn.textContent = 'Preview'
    previewBtn.title = 'Highlight all uncovered components on the page'
    let previewing = false
    previewBtn.addEventListener('click', () => {
      previewing = !previewing
      previewBtn.classList.toggle('active', previewing)
      if (previewing) {
        // Highlight all uncovered components at once via batch RPC
        const batch = missingEntries.map((e) => ({
          componentName: e.componentName,
          hasStory: false,
        }))
        rpcCall('component-highlighter:highlight-coverage-batch', batch).catch(
          () => {},
        )
      } else {
        clearHighlights()
      }
    })
    sectionActions.appendChild(previewBtn)

    // "Generate all" button
    const allVisibleInstances = await collectAllVisibleInstances()
    const uncoveredFilePaths = new Set(missingEntries.map((e) => e.filePath))
    const uncoveredSelections = allVisibleInstances.filter(
      (sel) =>
        sel.instance.meta?.filePath &&
        uncoveredFilePaths.has(sel.instance.meta.filePath),
    )
    if (uncoveredSelections.length > 0) {
      const createAllBtn = document.createElement('button')
      createAllBtn.className = 'create-all-btn'
      createAllBtn.textContent = 'Generate all'
      createAllBtn.title = `Create stories for ${uncoveredSelections.length} uncovered component${uncoveredSelections.length === 1 ? '' : 's'}`
      createAllBtn.addEventListener('click', async () => {
        createAllBtn.disabled = true
        createAllBtn.textContent = 'Creating\u2026'
        for (const { instance, index, total } of uncoveredSelections) {
          try {
            await rpcCall('component-highlighter:create-story', {
              meta: instance.meta,
              serializedProps: instance.serializedProps,
              skipNavigation: true,
              ...(total > 1 ? { sourceInstance: { index, total } } : {}),
            })
          } catch {
            // Best effort
          }
        }
        setTimeout(() => {
          lastCoverageJson = ''
          refreshCoverage()
        }, 1500)
      })
      sectionActions.appendChild(createAllBtn)
    }

    sectionHdr.appendChild(sectionActions)
    section.appendChild(sectionHdr)

    const list = document.createElement('ul')
    list.className = 'cov-list'

    for (const entry of missingEntries) {
      const li = document.createElement('li')
      li.className = 'cov-item'

      const info = document.createElement('div')
      info.className = 'cov-item-info'
      info.innerHTML = `
        <div class="comp-name">${esc(entry.componentName)}</div>
        <div class="comp-file" title="${esc(entry.relativeFilePath)}">${esc(entry.relativeFilePath)}</div>
      `
      li.appendChild(info)

      const actions = document.createElement('div')
      actions.className = 'cov-item-actions'

      // More actions (hidden until hover)
      const moreBtn = document.createElement('button')
      moreBtn.className = 'act-btn more-btn'
      moreBtn.innerHTML = ELLIPSIS_ICON
      moreBtn.title = 'More actions'
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        showActionPopover(moreBtn, entry)
      })
      actions.appendChild(moreBtn)

      // Warning icon
      const warn = document.createElement('span')
      warn.className = 'cov-warning-icon'
      warn.innerHTML = WARNING_ICON
      actions.appendChild(warn)

      // Create story "+" button
      const createBtn = document.createElement('button')
      createBtn.className = 'act-btn create'
      createBtn.innerHTML = PLUS_ICON
      createBtn.title = 'Create story from current props'
      createBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        createBtn.disabled = true
        const created = await createStoryForComponent(entry.filePath)
        if (created) {
          setTimeout(() => {
            lastCoverageJson = ''
            refreshCoverage()
          }, 1500)
        } else {
          createBtn.disabled = false
        }
      })
      actions.appendChild(createBtn)

      li.appendChild(actions)

      // Hover → highlight matching component instances on the app page via RPC
      li.addEventListener('mouseenter', () => {
        highlightInstances(entry.componentName, false)
      })
      li.addEventListener('mouseleave', () => {
        if (!previewing) clearHighlights()
      })

      list.appendChild(li)
    }

    section.appendChild(list)
    listWrap.appendChild(section)
  }

  // ── Covered section ──
  if (coveredEntries.length > 0) {
    const section = document.createElement('div')
    section.className = 'cov-section'

    const sectionHdr = document.createElement('div')
    sectionHdr.className = 'cov-section-hdr'

    const sectionTitle = document.createElement('span')
    sectionTitle.className = 'cov-section-title'
    sectionTitle.innerHTML = `Covered<span class="cov-section-count">${coveredEntries.length}</span>`
    sectionHdr.appendChild(sectionTitle)

    section.appendChild(sectionHdr)

    const list = document.createElement('ul')
    list.className = 'cov-list'

    for (const entry of coveredEntries) {
      const li = document.createElement('li')
      li.className = 'cov-item'

      const info = document.createElement('div')
      info.className = 'cov-item-info'
      info.innerHTML = `
        <div class="comp-name">${esc(entry.componentName)}</div>
        <div class="comp-file" title="${esc(entry.relativeFilePath)}">${esc(entry.relativeFilePath)}</div>
      `
      li.appendChild(info)

      const actions = document.createElement('div')
      actions.className = 'cov-item-actions'

      // More actions (hidden until hover)
      const moreBtn = document.createElement('button')
      moreBtn.className = 'act-btn more-btn'
      moreBtn.innerHTML = ELLIPSIS_ICON
      moreBtn.title = 'More actions'
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        showActionPopover(moreBtn, entry)
      })
      actions.appendChild(moreBtn)

      // Checkmark icon
      const check = document.createElement('span')
      check.className = 'cov-check-icon'
      check.innerHTML = CHECK_ICON
      actions.appendChild(check)

      li.appendChild(actions)

      // Hover → highlight matching component instances on the app page via RPC
      li.addEventListener('mouseenter', () => {
        highlightInstances(entry.componentName, true)
      })
      li.addEventListener('mouseleave', clearHighlights)

      list.appendChild(li)
    }

    section.appendChild(list)
    listWrap.appendChild(section)
  }

  root.appendChild(listWrap)

  pane.innerHTML = ''
  pane.appendChild(root)
}

// ─── Highlighter tab ────────────────────────────────────────────────

/** Currently selected component data (set via shared state from client) */
let selectedComponent: RegistryInstance | null = null

/**
 * Scroll a story card into view after creation — match the requested export
 * name against its Storybook-derived display name; fall back to the newest
 * card.
 */
function scrollToStoryCard(name?: string) {
  const cards = document.querySelectorAll<HTMLElement>('.hl-story-card')
  if (cards.length === 0) return
  let target: HTMLElement | undefined
  if (name) {
    const expectedName = storyNameFromExport(name)
    target = Array.from(cards).find(
      (c) =>
        (c.querySelector('.hl-story-label')?.textContent || '') ===
        expectedName,
    )
  }
  const card = target ?? cards[cards.length - 1]
  if (!card) return
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  // The cards' lazy preview iframes grow the list after the first scroll —
  // re-assert once the layout has settled.
  setTimeout(() => card.scrollIntoView({ block: 'nearest' }), 700)
}

function createStoryCard(
  story: StorybookIndexEntry,
  relPath: string,
  sbUrl: string,
): HTMLElement {
  const storyCard = document.createElement('div')
  storyCard.className = 'hl-story-card'
  storyCard.dataset['storyId'] = story.id

  const iframe = document.createElement('iframe')
  iframe.className = 'hl-story-iframe'
  iframe.src = `${sbUrl}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&shortcuts=false&singleStory=true`
  iframe.title = story.name
  iframe.setAttribute('loading', 'lazy')
  storyCard.appendChild(iframe)

  const storyLabel = document.createElement('div')
  storyLabel.className = 'hl-story-label'
  storyLabel.textContent = story.name
  storyCard.appendChild(storyLabel)

  // Click to navigate in the Storybook tab
  storyCard.addEventListener('click', () => {
    visitStory(relPath, story.name)
    switchTab('storybook')
  })

  return storyCard
}

/**
 * After a story is created, update the stories list in place — appending
 * only the new card keeps every existing preview iframe alive (a full pane
 * rebuild reloads them all, which reads as a flash) and gives the new card
 * its final fixed-height layout immediately, so scrolling to it is reliable.
 * Returns false when the list isn't updatable in place (pane gone, or no
 * stories resolvable yet) so the caller can fall back to a full rebuild.
 */
async function refreshStoriesAfterCreate(
  relPath: string,
  componentName: string | undefined,
  requestedName: string,
): Promise<boolean> {
  const pane = document.getElementById('pane-highlighter')
  const body = pane?.querySelector('.hl-stories-body')
  if (!pane || !body) return false

  const stories = await findMatchingStories(relPath, componentName)
  if (stories.length === 0) return false

  let list = body.querySelector('.hl-stories-list')
  if (!list) {
    // First story: replace the empty-state / not-running card with a list
    body.innerHTML = ''
    list = document.createElement('div')
    list.className = 'hl-stories-list'
    body.appendChild(list)
  }

  const sbUrl = getStorybookUrl()
  const existing = new Set(
    Array.from(list.querySelectorAll<HTMLElement>('.hl-story-card')).map(
      (c) => c.dataset['storyId'],
    ),
  )
  let appended: HTMLElement | null = null
  for (const story of stories) {
    if (existing.has(story.id)) continue
    appended = createStoryCard(story, relPath, sbUrl)
    list.appendChild(appended)
  }

  const hdr = pane.querySelector('.hl-stories-section .hl-section-hdr')
  if (hdr) {
    hdr.innerHTML = `<span class="hl-section-title">Stories <span class="cov-section-count">${stories.length}</span></span>`
  }

  const expectedName = storyNameFromExport(requestedName)
  const target =
    Array.from(list.querySelectorAll<HTMLElement>('.hl-story-card')).find(
      (c) =>
        (c.querySelector('.hl-story-label')?.textContent || '') ===
        expectedName,
    ) ??
    appended ??
    list.lastElementChild
  if (target) {
    scrollCardIntoView(target as HTMLElement, body as HTMLElement)
  }
  return true
}

/**
 * Scroll a story card into view and verify it landed. A single
 * scrollIntoView is unreliable here: the panel iframe is 0x0 whenever the
 * dock is closed (scrolls silently no-op), smooth scrolls get cancelled by
 * layout shifts, and late rebuilds reset scrollTop. Retry with instant
 * scrolls until the card is actually within the scroller, or give up.
 */
function scrollCardIntoView(card: HTMLElement, scroller: HTMLElement) {
  let attempts = 0
  const tick = () => {
    if (!card.isConnected) return
    const cr = card.getBoundingClientRect()
    const sr = scroller.getBoundingClientRect()
    const visibleViewport = sr.height > 0
    const inView =
      visibleViewport && cr.top >= sr.top - 2 && cr.bottom <= sr.bottom + 2
    if (inView) return
    if (visibleViewport) card.scrollIntoView({ block: 'nearest' })
    attempts++
    if (attempts < 40) setTimeout(tick, 250)
  }
  tick()
}

/** Find stories matching a component by file path or title */
async function findMatchingStories(relativeFilePath: string, componentName?: string): Promise<StorybookIndexEntry[]> {
  const entries = await getStorybookIndex()
  if (!entries || Object.keys(entries).length === 0) return []
  const baseName =
    stripExtForMatch(relativeFilePath).split('/').pop() || relativeFilePath
  return findStoryCandidates(
    entries,
    relativeFilePath,
    componentName || baseName,
  ) as StorybookIndexEntry[]
}

/** Build the highlighter panel — empty state or component detail */
async function buildHighlighterPanel() {
  const pane = document.getElementById('pane-highlighter')
  if (!pane) return

  if (!selectedComponent) {
    pane.innerHTML = `
      <div class="hl-empty">
        <div class="hl-empty-title">Select a component</div>
        <div class="hl-empty-sub">Hover and click a component in your app to inspect it.</div>
      </div>`
    return
  }

  const comp = selectedComponent
  const relPath = comp.meta.relativeFilePath || comp.meta.filePath
  const root = document.createElement('div')
  root.className = 'hl-root'

  // Look up stories first so we can conditionally show story-related actions
  const matchingStories = await findMatchingStories(relPath, comp.meta.componentName)
  const hasStories = matchingStories.length > 0

  // Also look up the coverage entry to find storyPath
  let storyPath: string | null = null
  try {
    const covData = await fetchCoverage()
    if (covData) {
      const covEntry = covData.entries.find(e => e.filePath === comp.meta.filePath)
      if (covEntry?.storyPath) storyPath = covEntry.storyPath
    }
  } catch { /* best effort */ }

  // ── Header ──
  const hdr = document.createElement('div')
  hdr.className = 'hl-hdr'

  const hdrInfo = document.createElement('div')
  hdrInfo.className = 'hl-hdr-info'
  hdrInfo.innerHTML = `
    <div class="hl-comp-name">${esc(comp.meta.componentName)}</div>
    <div class="hl-comp-file">${esc(relPath)}</div>
  `
  hdr.appendChild(hdrInfo)

  const hdrActions = document.createElement('div')
  hdrActions.className = 'hl-hdr-actions'

  // Locate (scroll to) button
  const locateBtn = document.createElement('button')
  locateBtn.className = 'act-btn'
  locateBtn.innerHTML = BULLSEYE_ICON
  locateBtn.title = 'Locate component'
  locateBtn.addEventListener('click', () => {
    rpcCall('component-highlighter:scroll-to-component', {
      componentName: comp.meta.componentName,
      id: comp.id,
    }).catch(() => {})
  })
  hdrActions.appendChild(locateBtn)

  // Open in editor button
  const editorBtn = document.createElement('button')
  editorBtn.className = 'act-btn'
  editorBtn.innerHTML = CODE_ICON
  editorBtn.title = 'Open in editor'
  editorBtn.addEventListener('click', () => openInEditor(comp.meta.filePath))
  hdrActions.appendChild(editorBtn)

  // More actions dropdown
  const moreBtn = document.createElement('button')
  moreBtn.className = 'act-btn'
  moreBtn.innerHTML = ELLIPSIS_ICON
  moreBtn.title = 'More actions'
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    showHighlighterPopover(moreBtn, comp, hasStories, storyPath)
  })
  hdrActions.appendChild(moreBtn)

  hdr.appendChild(hdrActions)
  root.appendChild(hdr)

  // ── Properties section ──
  // serializedProps is the single RPC-safe representation for every framework
  // (React markers, Vue/Svelte already-serialized values).
  const displayProps = comp.serializedProps || {}
  const propsEntries = Object.entries(displayProps)
  if (propsEntries.length > 0) {
    const propsSection = document.createElement('div')
    propsSection.className = 'hl-section'

    const propsHdr = document.createElement('div')
    propsHdr.className = 'hl-section-hdr'
    propsHdr.innerHTML = `<span class="hl-section-title">Properties <span class="cov-section-count">${propsEntries.length}</span></span>`
    propsSection.appendChild(propsHdr)

    const propsTable = document.createElement('div')
    propsTable.className = 'hl-props-table'

    for (const [key, initialValue] of propsEntries) {
      const row = document.createElement('div')
      row.className = 'hl-prop-row'

      const label = document.createElement('div')
      label.className = 'hl-prop-key'
      label.textContent = key

      const val = document.createElement('div')
      val.className = 'hl-prop-val'

      // The value captured when the panel was built goes stale after an edit
      // (the app pushes the new value back via the registry shared state, with
      // a short debounce). Read the freshest value + edited-state from the
      // registry so re-opening the editor seeds the *current* value and the
      // reset button reflects reality.
      const liveInstance = () => fetchRegistry().find((i) => i.id === comp.id)
      const liveValue = (): unknown => {
        const sp = liveInstance()?.serializedProps
        return sp && key in sp ? sp[key] : initialValue
      }
      const isEdited = (): boolean =>
        (liveInstance()?.editedProps ?? []).includes(key)

      // Read-only renderer for the current value (+ edit / reset affordances).
      const renderValue = () => {
        val.innerHTML = ''
        const value = liveValue()
        const isObj = value && typeof value === 'object'
        const isFunction =
          isObj && (value as Record<string, unknown>)['__isFunction']
        const isJSX = isObj && (value as Record<string, unknown>)['__isJSX']
        const isObjMarker =
          isObj && (value as Record<string, unknown>)['__isObject']
        const edit = propEditability(value)

        if (isFunction) {
          const fn = value as { __isFunction: true; name: string }
          val.innerHTML = `<span class="hl-prop-fn">${fn.name ? fn.name : '() => {}'}</span>`
        } else if (isJSX) {
          const jsx = value as { __isJSX: true; source: string }
          const wrapper = document.createElement('details')
          wrapper.className = 'hl-prop-details'
          const summary = document.createElement('summary')
          summary.innerHTML = `<span class="hl-prop-jsx-badge">JSX</span>`
          wrapper.appendChild(summary)
          const code = document.createElement('pre')
          code.className = 'hl-prop-code'
          code.textContent = jsx.source
          wrapper.appendChild(code)
          val.appendChild(wrapper)
        } else if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          const span = document.createElement('span')
          span.className = `hl-prop-scalar hl-prop-${typeof value}`
          span.textContent = String(value)
          val.appendChild(span)
        } else if (value === null || value === undefined) {
          val.innerHTML = `<span class="hl-prop-null">${String(value)}</span>`
        } else if (isObjMarker) {
          const o = value as { name?: string }
          val.innerHTML = `<span class="hl-prop-obj">${o.name || 'Object'}</span>`
        } else if (isObj && (value as Record<string, unknown>)['__isDate']) {
          const span = document.createElement('span')
          span.className = 'hl-prop-scalar'
          span.textContent = String(
            (value as { iso?: string }).iso ?? 'Invalid Date',
          )
          val.appendChild(span)
        } else {
          const wrapper = document.createElement('details')
          wrapper.className = 'hl-prop-details'
          const summary = document.createElement('summary')
          summary.innerHTML = `<span class="hl-prop-obj">${Array.isArray(value) ? `Array(${(value as unknown[]).length})` : 'Object'}</span>`
          wrapper.appendChild(summary)
          const code = document.createElement('pre')
          code.className = 'hl-prop-code'
          try {
            code.textContent = JSON.stringify(value, null, 2)
          } catch {
            code.textContent = String(value)
          }
          wrapper.appendChild(code)
          val.appendChild(wrapper)
        }
        if (edit.editable) {
          const editBtn = document.createElement('button')
          editBtn.className = 'hl-prop-edit-btn'
          editBtn.title = `Edit ${key} live`
          editBtn.innerHTML = PENCIL_ICON
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            openEditor()
          })
          val.appendChild(editBtn)
        }
        if (isEdited()) {
          const resetBtn = document.createElement('button')
          resetBtn.className = 'hl-prop-reset-btn'
          resetBtn.title = `Reset ${key} to original`
          resetBtn.innerHTML = RESET_ICON
          resetBtn.addEventListener('click', (e) => {
            e.stopPropagation()
            rpcCall('component-highlighter:reset-prop', {
              id: comp.id,
              path: [key],
            })
            // Re-render now, then again after the debounced registry push so
            // the reverted value + cleared reset state are reflected.
            renderValue()
            setTimeout(renderValue, 600)
          })
          val.appendChild(resetBtn)
        }
      }

      const openEditor = () => {
        val.innerHTML = ''
        // Seed from the CURRENT value, not the value captured at build time.
        const current = liveValue()
        createPropEditor({
          parent: val,
          value: current,
          kind: propEditability(current).kind,
          classes: {
            form: 'hl-prop-edit-form',
            input: 'hl-prop-input',
            textarea: 'hl-prop-input hl-prop-textarea',
            actions: 'hl-prop-edit-actions',
            save: 'hl-prop-edit-save',
            cancel: 'hl-prop-edit-cancel',
            error: 'hl-prop-edit-error',
          },
          // Panel: route the edit through RPC (relayed to the client's
          // __componentHighlighterSetProp). Fire-and-forget — the live app is
          // the source of truth and pushes the new value back via the registry.
          onApply: (payload) => {
            rpcCall('component-highlighter:set-prop', {
              id: comp.id,
              path: [key],
              payload,
            })
          },
          onApplied: () => {
            renderValue()
            // Pick up the serialized value + edited-state after the debounced
            // registry push settles.
            setTimeout(renderValue, 600)
          },
          onCancel: () => renderValue(),
        })
      }

      renderValue()
      row.appendChild(label)
      row.appendChild(val)
      propsTable.appendChild(row)
    }

    propsSection.appendChild(propsTable)
    root.appendChild(propsSection)
  }

  // ── Story creation ──
  const createSection = document.createElement('div')
  createSection.className = 'hl-section'

  const createHdr = document.createElement('div')
  createHdr.className = 'hl-section-hdr'
  createHdr.innerHTML = `<span class="hl-section-title">Create Story</span>`

  createSection.appendChild(createHdr)

  // Story name input
  const storyNameRow = document.createElement('div')
  storyNameRow.className = 'hl-story-name-row'
  const storyNameInput = document.createElement('input')
  storyNameInput.className = 'hl-prop-input'
  storyNameInput.type = 'text'
  storyNameInput.placeholder = 'Story name\u2026'
  storyNameInput.value = suggestStoryName(comp.serializedProps || {})
  storyNameInput.addEventListener('focus', () => storyNameInput.select())
  storyNameRow.appendChild(storyNameInput)

  const addBtn = document.createElement('button')
  addBtn.className = 'create-all-btn'
  addBtn.textContent = 'Add'
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true
    addBtn.textContent = 'Creating\u2026'
    try {
      // Re-resolve the latest registry entry so live prop edits (the panel
      // pencil → set-prop → overrideProps) are reflected in the story file,
      // not the snapshot captured when this inspector was rendered.
      const latest =
        fetchRegistry().find((i) => i.id === comp.id) ?? comp
      const requestedName = storyNameInput.value.trim()
      const preIds = new Set(
        (
          await findMatchingStories(
            comp.meta.relativeFilePath || comp.meta.filePath,
            comp.meta.componentName,
          )
        ).map((st) => st.id),
      )
      await rpcCall('component-highlighter:create-story', {
        meta: latest.meta,
        serializedProps: latest.serializedProps,
        storyName: requestedName || undefined,
        // Stay on this view: the new story appears in the list below
        // instead of the panel jumping to the Storybook tab.
        skipNavigation: true,
      })
      // Bust the storybook index cache and retry until the new story appears
      const refreshAfterCreate = async () => {
        try {
          lastCoverageJson = ''
          refreshCoverage()
          // Retry with cache busting until the index contains the NEW story —
          // a non-empty list isn't enough, pre-existing stories satisfy that
          // immediately while the indexer is still catching up.
          const expectedName = storyNameFromExport(requestedName)
          for (let i = 0; i < 20; i++) {
            storybookIndexCache = null
            const stories = await findMatchingStories(
              comp.meta.relativeFilePath || comp.meta.filePath,
              comp.meta.componentName,
            )
            const fresh = stories.some(
              (st) => !preIds.has(st.id) || st.name === expectedName,
            )
            if (fresh) {
              const updated = await refreshStoriesAfterCreate(
                comp.meta.relativeFilePath || comp.meta.filePath,
                comp.meta.componentName,
                requestedName,
              )
              if (!updated) {
                await buildHighlighterPanel()
                scrollToStoryCard(requestedName)
              }
              return
            }
            await new Promise(r => setTimeout(r, 1000))
          }
          buildHighlighterPanel() // rebuild anyway after max retries
        } finally {
          // The in-place refresh keeps this button alive — reset it.
          addBtn.disabled = false
          addBtn.textContent = 'Add'
        }
      }
      setTimeout(refreshAfterCreate, 1500)
    } catch {
      addBtn.disabled = false
      addBtn.textContent = 'Add'
    }
  })
  storyNameRow.appendChild(addBtn)

  createSection.appendChild(storyNameRow)
  root.appendChild(createSection)

  // ── Stories section ──
  const storiesSection = document.createElement('div')
  storiesSection.className = 'hl-section hl-stories-section'

  const storiesHdr = document.createElement('div')
  storiesHdr.className = 'hl-section-hdr'
  storiesHdr.innerHTML = `<span class="hl-section-title">Stories${matchingStories.length > 0 ? ` <span class="cov-section-count">${matchingStories.length}</span>` : ''}</span>`
  storiesSection.appendChild(storiesHdr)

  const storiesBody = document.createElement('div')
  storiesBody.className = 'hl-stories-body'

  const sbRunning = await checkStorybook()

  if (!sbRunning) {
    // Storybook not running — show indicator and start button
    const notRunning = document.createElement('div')
    notRunning.className = 'hl-sb-status'
    notRunning.innerHTML = `
      <div class="hl-sb-status-msg">Storybook is not running</div>
      <div class="hl-sb-status-sub">Start Storybook to preview stories for this component.</div>
    `
    const startBtn = document.createElement('button')
    startBtn.className = 'start-btn'
    startBtn.textContent = 'Start Storybook'
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true
      startBtn.textContent = 'Starting\u2026'

      try {
        await rpcCall('component-highlighter:start-storybook')
      } catch { /* best effort */ }

      // Replace with loading spinner
      notRunning.innerHTML = `
        <div class="spinner"></div>
        <div class="hl-sb-status-msg">Starting Storybook\u2026</div>
      `
      startBtn.remove()

      // Poll until Storybook is ready, then refresh the panel in place
      let attempts = 0
      const poll = setInterval(async () => {
        attempts++
        const status = await getStorybookStatus()
        if (status.startFailure) {
          clearInterval(poll)
          // Mirror the failure on the Storybook tab, but keep the user here.
          renderStorybookState('failed', status.startFailure)
          notRunning.innerHTML = `
            <div class="hl-sb-status-msg">Storybook failed to start</div>
            ${
              status.startFailure.detail
                ? `<pre class="sb-error-detail">${esc(status.startFailure.detail)}</pre>`
                : '<div class="hl-sb-status-sub">The terminal has the error output.</div>'
            }
          `
          const errBtn = document.createElement('button')
          errBtn.className = 'start-btn'
          errBtn.textContent = 'Open Terminal'
          errBtn.addEventListener('click', openStorybookTerminal)
          notRunning.appendChild(errBtn)
        } else if (status.running) {
          clearInterval(poll)
          // Also refresh the Storybook tab iframe in the background
          renderStorybookState('running')
          // Bust index cache and rebuild this panel
          storybookIndexCache = null
          buildHighlighterPanel()
        } else if (attempts > 120) {
          clearInterval(poll)
          notRunning.innerHTML = `
            <div class="hl-sb-status-msg">Failed to start Storybook</div>
          `
        }
      }, 1000)
    })
    notRunning.appendChild(startBtn)
    storiesBody.appendChild(notRunning)
  } else if (matchingStories.length === 0) {
    // Storybook running but no stories found for this component
    const noStories = document.createElement('div')
    noStories.className = 'hl-sb-status'
    noStories.innerHTML = `<div class="hl-sb-status-msg">No stories found for this component</div>`
    storiesBody.appendChild(noStories)
  } else {
    // Storybook running and stories found — render iframe previews
    const storiesList = document.createElement('div')
    storiesList.className = 'hl-stories-list'

    const sbUrl = getStorybookUrl()
    for (const story of matchingStories) {
      storiesList.appendChild(createStoryCard(story, relPath, sbUrl))
    }
    storiesBody.appendChild(storiesList)
  }

  storiesSection.appendChild(storiesBody)

  // Rebuilding for the component already on screen: swap only the inspector
  // sections and keep the existing stories section's DOM — recreating (or
  // even moving) the preview iframes reloads them, which reads as a flash.
  const existingRoot = pane.querySelector<HTMLElement>(':scope > .hl-root')
  const existingStories = existingRoot?.querySelector<HTMLElement>(
    ':scope > .hl-stories-section',
  )
  if (
    existingRoot &&
    existingStories &&
    existingRoot.dataset['component'] === comp.meta.filePath
  ) {
    while (
      existingRoot.firstChild &&
      existingRoot.firstChild !== existingStories
    ) {
      existingRoot.removeChild(existingRoot.firstChild)
    }
    while (root.firstChild) {
      existingRoot.insertBefore(root.firstChild, existingStories)
    }
    return
  }

  root.dataset['component'] = comp.meta.filePath
  root.appendChild(storiesSection)
  pane.innerHTML = ''
  pane.appendChild(root)
}

const COPY_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
const HIGHLIGHT_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`

/** Show a popover with actions for the highlighter panel's selected component */
function showHighlighterPopover(
  anchor: HTMLElement,
  comp: RegistryInstance,
  hasStories: boolean,
  storyPath: string | null,
) {
  const popover = getActionPopover()
  if (!popover.hidden && popover.dataset['entry'] === `hl-${comp.meta.componentName}`) {
    popover.hidden = true
    return
  }

  popover.innerHTML = ''
  popover.dataset['entry'] = `hl-${comp.meta.componentName}`
  const relPath = comp.meta.relativeFilePath || comp.meta.filePath

  popover.appendChild(
    makePopoverItem(CODE_ICON, 'Open component in editor', () =>
      openInEditor(comp.meta.filePath),
    ),
  )

  if (hasStories && storyPath) {
    popover.appendChild(
      makePopoverItem(CODE_ICON, 'Open story in editor', () =>
        openInEditor(storyPath),
      ),
    )
  }

  popover.appendChild(
    makePopoverItem(COPY_ICON, 'Copy path', () => {
      navigator.clipboard.writeText(relPath).catch(() => {})
    }),
  )

  popover.appendChild(
    makePopoverItem(
      HIGHLIGHT_ICON,
      highlightsVisible ? 'Hide highlights' : 'Show highlights',
      () => {
        rpcCall('component-highlighter:toggle-highlight-visibility').catch(
          () => {},
        )
      },
    ),
  )

  if (hasStories) {
    popover.appendChild(
      makePopoverItem(EYE_ICON, 'Open in Storybook', () =>
        visitStory(relPath),
      ),
    )
  }

  positionPopover(popover, anchor)
}

// ─── Bootstrap ──────────────────────────────────────────────────────

function init() {
  const app = document.getElementById('app')!

  app.style.display = 'flex'
  app.style.flexDirection = 'row'
  app.style.height = '100%'

  // ── Vertical rail ──────────────────────────────────────────────────
  const rail = document.createElement('div')
  rail.className = 'rail'

  // Storybook tab — full-color logo
  const sbBtn = document.createElement('button')
  sbBtn.className = 'rail-btn rail-sb-btn active'
  sbBtn.setAttribute('data-tab', 'storybook')
  sbBtn.innerHTML = SB_LOGO_FULL
  sbBtn.title = 'Storybook'
  sbBtn.addEventListener('click', () => switchTab('storybook'))

  // Component highlighter tab
  const highlightBtn = document.createElement('button')
  highlightBtn.className = 'rail-btn'
  highlightBtn.id = 'highlight-toggle'
  highlightBtn.setAttribute('data-tab', 'highlighter')
  highlightBtn.innerHTML = CROSSHAIR_ICON
  highlightBtn.title = 'Component Highlighter'
  highlightBtn.addEventListener('click', () => switchTab('highlighter'))

  // Coverage tab
  const covBtn = document.createElement('button')
  covBtn.className = 'rail-btn'
  covBtn.setAttribute('data-tab', 'coverage')
  covBtn.innerHTML = COVERAGE_TAB_ICON
  covBtn.title = 'Coverage'
  covBtn.addEventListener('click', () => switchTab('coverage'))

  // Docs button — opens docs in new tab (no panel pane)
  const docsBtn = document.createElement('button')
  docsBtn.className = 'rail-btn'
  docsBtn.innerHTML = DOCS_TAB_ICON
  docsBtn.title = 'Open Storybook docs'
  docsBtn.addEventListener('click', () => {
    window.open(storybookDocsUrl, '_blank')
  })

  // Spacer pushes help to bottom
  const spacer = document.createElement('div')
  spacer.className = 'rail-spacer'

  // Help / About tab
  const helpBtn = document.createElement('button')
  helpBtn.className = 'rail-btn'
  helpBtn.setAttribute('data-tab', 'about')
  helpBtn.innerHTML = HELP_ICON
  helpBtn.title = 'About'
  helpBtn.addEventListener('click', () => switchTab('about'))

  rail.appendChild(sbBtn)
  rail.appendChild(highlightBtn)
  rail.appendChild(covBtn)
  rail.appendChild(docsBtn)
  rail.appendChild(spacer)
  rail.appendChild(helpBtn)
  app.appendChild(rail)

  // ── Tab content panes ──────────────────────────────────────────────
  const content = document.createElement('div')
  content.className = 'tab-content'

  const sbPane = document.createElement('div')
  sbPane.className = 'tab-pane active'
  sbPane.id = 'pane-storybook'

  const covPane = document.createElement('div')
  covPane.className = 'tab-pane'
  covPane.id = 'pane-coverage'
  covPane.innerHTML =
    '<div class="coverage-root"><div class="empty">Loading coverage data\u2026</div></div>'

  const aboutPane = document.createElement('div')
  aboutPane.className = 'tab-pane'
  aboutPane.id = 'pane-about'
  aboutPane.innerHTML = `
    <div class="about-root">
      <div class="about-logo">${SB_LOGO_FULL.replace('width="20" height="20"', 'width="48" height="48"')}</div>
      <div class="about-name">Storybook DevTools</div>
      <div class="about-version">@storybook/experimental-devtools</div>
      <a class="about-link" href="https://github.com/storybookjs/vite-plugin-experimental-storybook-devtools" target="_blank" rel="noopener noreferrer">
        ${CODE_ICON} View on GitHub
      </a>
    </div>`

  const hlPane = document.createElement('div')
  hlPane.className = 'tab-pane'
  hlPane.id = 'pane-highlighter'

  content.appendChild(sbPane)
  content.appendChild(hlPane)
  content.appendChild(covPane)
  content.appendChild(aboutPane)
  app.appendChild(content)

  // Init RPC client — also sets up shared state subscriptions for
  // pending visit/tab, registry, and highlight toggle sync.
  initRpcClient().then(() => {
    registerPanelRpcHandlers()
  })

  // Init storybook tab
  initStorybookTab()

  // Clean up highlights when the panel iframe is hidden or unloaded
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearAllHighlights()
  })
  window.addEventListener('pagehide', cleanupOnPanelClose)
  window.addEventListener('beforeunload', cleanupOnPanelClose)

  // Detect panel iframe being hidden by the dock (display:none).
  // When the dock hides us, frameElement.offsetParent becomes null.
  // Poll periodically to detect this and clean up highlighter-tab-active.
  setupPanelVisibilityCheck()
}

/** Check if the panel iframe is visible (not hidden by display:none) */
function isPanelVisible(): boolean {
  try {
    const frame = window.frameElement as HTMLElement | null
    if (!frame) return true // not in iframe, assume visible
    return frame.offsetParent !== null
  } catch {
    return true // cross-origin, assume visible
  }
}

/** Clean up highlight state when panel is hidden/closed */
function cleanupOnPanelClose() {
  clearAllHighlights()
  if (highlightEnabled) {
    highlightEnabled = false
    syncHighlighterTabState(false)
  }
}

/** Poll for panel visibility changes to clean up stale state */
function setupPanelVisibilityCheck() {
  let wasVisible = true
  setInterval(() => {
    const visible = isPanelVisible()
    if (wasVisible && !visible) {
      // Panel just became hidden — clean up highlight state
      cleanupOnPanelClose()
    } else if (!wasVisible && visible && activeTab === 'highlighter') {
      // Panel just became visible again — re-sync tab state
      highlightEnabled = true
      syncHighlighterTabState(true)
    }
    wasVisible = visible
  }, 300)
}

init()
