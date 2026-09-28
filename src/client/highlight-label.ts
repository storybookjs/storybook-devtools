/**
 * Shared highlight-label rendering for component overlays.
 *
 * Both the interactive component-highlighter (overlay.ts) and the coverage
 * highlights (coverage-actions.ts) use this module so every overlay has a
 * consistent name label attached to the highlight box.
 *
 * Design: a small Storybook logo badge (separate square) followed by a
 * white-background / black-text name pill, both sitting 2 px above the
 * highlight outline. The name aligns with the component’s left edge; the
 * badge sits outside it unless that would clip at the viewport edge.
 *
 * Placement priority:
 *   1. Above the box (top-left, offset upward)
 *   2. Below the box (bottom-left, offset downward)
 *   3. Inside the box at top-left (if neither outside edge is visible)
 *
 * All styles are hardcoded hex — inline styles on the host-page DOM where
 * CSS custom properties are not available.
 */

// Flat Storybook icon — single-color (white) so it works on any colored badge bg.
// Same "S" silhouette as SB_TAB_ICON in panel.ts but encoded as a data URI.
const SB_ICON_FLAT_DATA_URI = `data:image/svg+xml,${encodeURIComponent('<svg width="12" height="12" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="#fff" d="m16.71.243l-.12 2.71a.18.18 0 0 0 .29.15l1.06-.8l.9.7a.18.18 0 0 0 .28-.14l-.1-2.76l1.33-.1a1.2 1.2 0 0 1 1.279 1.2v21.596a1.2 1.2 0 0 1-1.26 1.2l-16.096-.72a1.2 1.2 0 0 1-1.15-1.16l-.75-19.797a1.2 1.2 0 0 1 1.13-1.27L16.7.222zM13.64 9.3c0 .47 3.16.24 3.59-.08c0-3.2-1.72-4.89-4.859-4.89c-3.15 0-4.899 1.72-4.899 4.29c0 4.45 5.999 4.53 5.999 6.959c0 .7-.32 1.1-1.05 1.1c-.96 0-1.35-.49-1.3-2.16c0-.36-3.649-.48-3.769 0c-.27 4.03 2.23 5.2 5.099 5.2c2.79 0 4.969-1.49 4.969-4.18c0-4.77-6.099-4.64-6.099-6.999c0-.97.72-1.1 1.13-1.1c.45 0 1.25.07 1.19 1.87z"/></svg>')}`

/** Height of the label row in px. */
const LABEL_H = 20
/** Gap between label and highlight outline in px. */
const GAP = 2

/** CSS class applied to the label wrapper for easy querying. */
export const LABEL_CLASS = 'ch-highlight-label'

/**
 * Create (or update) the name-label element attached to a highlight box.
 *
 * @param container  The highlight box element to attach the label to.
 * @param rect       Bounding rect of the highlighted component (viewport coords).
 * @param name       Component name to display.
 * @param color      Highlight outline color (used for the SB icon badge bg).
 * @param showBadge  Whether to show the Storybook icon badge (default true).
 */
export function attachHighlightLabel(
  container: HTMLElement,
  rect: DOMRect,
  name: string,
  color: string,
  showBadge = true,
): void {
  // Re-use existing wrapper if present
  let wrapper = container.querySelector(`.${LABEL_CLASS}`) as HTMLDivElement | null
  if (!wrapper) {
    wrapper = document.createElement('div')
    wrapper.className = LABEL_CLASS

    // ── Storybook icon badge (separate square) ──
    const badge = document.createElement('div')
    badge.className = 'ch-label-badge'
    const icon = document.createElement('img')
    icon.src = SB_ICON_FLAT_DATA_URI
    icon.width = 12
    icon.height = 12
    icon.style.cssText = 'display: block;'
    badge.appendChild(icon)
    wrapper.appendChild(badge)

    // ── Name pill ──
    const pill = document.createElement('div')
    pill.className = 'ch-label-name'
    wrapper.appendChild(pill)

    container.appendChild(wrapper)
  }

  // Update name text
  const pill = wrapper.querySelector('.ch-label-name') as HTMLDivElement
  if (pill.textContent !== name) {
    pill.textContent = name
  }

  // ── Placement logic ──
  const viewportH = window.innerHeight
  const fitsAbove = rect.top >= LABEL_H + GAP
  const fitsBelow = rect.bottom + LABEL_H + GAP <= viewportH
  // Prefer above → below → inside-top
  let placement: 'above' | 'below' | 'inside'
  if (fitsAbove) {
    placement = 'above'
  } else if (fitsBelow) {
    placement = 'below'
  } else {
    placement = 'inside'
  }

  // Align the name pill with the component, leaving the badge to its left.
  // At the viewport edge keep the entire row inside, badge first.
  const badgeOffset = showBadge ? LABEL_H + GAP : 0
  const left = rect.left >= badgeOffset ? -badgeOffset : Math.max(0, -rect.left)

  // Position the wrapper
  let posCSS: string
  switch (placement) {
    case 'above':
      posCSS = `top: -${LABEL_H + GAP}px; bottom: auto; left: ${left}px;`
      break
    case 'below':
      posCSS = `top: auto; bottom: -${LABEL_H + GAP}px; left: ${left}px;`
      break
    case 'inside':
      posCSS = `top: 4px; bottom: auto; left: ${left}px;`
      break
  }

  wrapper.style.cssText = `
    position: absolute;
    ${posCSS}
    height: ${LABEL_H}px;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    pointer-events: none;
    white-space: nowrap;
    line-height: 1;
  `

  // Style the badge — hidden when component has no stories
  const badge = wrapper.querySelector('.ch-label-badge') as HTMLDivElement
  badge.style.cssText = showBadge
    ? `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: ${LABEL_H}px;
    height: ${LABEL_H}px;
    background: ${color};
    border-radius: 3px;
    flex-shrink: 0;
  `
    : `display: none;`

  // Style the name pill
  pill.style.cssText = `
    display: inline-flex;
    align-items: center;
    height: ${LABEL_H}px;
    padding: 0 6px;
    background: #fff;
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    font-size: 11px;
    font-weight: 600;
    border-radius: 3px;
  `
}

/**
 * Remove the name-label from a highlight box (if present).
 */
export function removeHighlightLabel(container: HTMLElement): void {
  const label = container.querySelector(`.${LABEL_CLASS}`)
  if (label) label.remove()
}
