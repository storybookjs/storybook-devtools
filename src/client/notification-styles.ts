/**
 * Adapt the hub's existing toasts to Storybook's NotificationItem styling.
 * Keep the hub's dismissal, timing, message history and action handlers.
 * These selectors are the @devframes/hub-ui 1.x toast markup; the shared
 * panel E2E suite exercises the real hub to catch upstream markup changes.
 */
const styles = `
:host {
  --sb-notification-bg: rgba(26, 57, 77, 0.97);
  --sb-notification-fg: #FFFFFF;
  --sb-notification-border: hsl(212 50% 30% / 0.15);
  --sb-notification-shadow: 0 2px 5px rgba(0,0,0,0.05), 0 5px 15px rgba(0,0,0,0.1);
  --sb-notification-radius: 5px;
  --sb-notification-font: "Nunito Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --sb-notification-font-size: 12px;
  --sb-notification-space: 12px;
  --sb-notification-focus: #006DEB;
}
@media (prefers-color-scheme: dark) {
  :host {
    --sb-notification-bg: rgba(238, 243, 246, 0.97);
    --sb-notification-fg: #1B1C1D;
    --sb-notification-border: hsl(0 0% 100% / 0.1);
    --sb-notification-focus: #479DFF;
  }
}
.z-dock-toast > .bg-toast-glass {
  background: var(--sb-notification-bg);
  color: var(--sb-notification-fg);
  border: 1px solid var(--sb-notification-border);
  border-radius: var(--sb-notification-radius);
  box-shadow: var(--sb-notification-shadow);
  font-family: var(--sb-notification-font);
  overflow: hidden;
}
.z-dock-toast > .bg-toast-glass > div {
  padding: var(--sb-notification-space) calc(var(--sb-notification-space) / 2) var(--sb-notification-space) var(--sb-notification-space);
  align-items: center;
  gap: 10px;
}
/* Storybook uses an inverse surface and icon, without a severity stripe. */
.z-dock-toast > .bg-toast-glass > div > .absolute { display: none; }
.z-dock-toast > .bg-toast-glass > div > .flex-none { color: inherit; margin-top: 0; }
.z-dock-toast .font-medium {
  font-size: var(--sb-notification-font-size);
  font-weight: 700;
  line-height: 16px;
  white-space: normal;
  overflow-wrap: anywhere;
}
.z-dock-toast .whitespace-pre-wrap { font-size: 11px; line-height: 14px; opacity: 0.75; }
.z-dock-toast button { color: inherit; opacity: 0.7; }
.z-dock-toast button:last-child { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; }
.z-dock-toast button:hover { opacity: 1; background: transparent; }
.z-dock-toast button:focus-visible { outline: 2px solid var(--sb-notification-focus); outline-offset: -2px; }
`

export function installNotificationStyles() {
  const install = () => {
    const roots = Array.from(document.querySelectorAll('devframes-dock-embedded, devframes-dock-standalone'))
      .map(host => host.shadowRoot).filter((root): root is ShadowRoot => !!root)
    for (const root of roots) {
      if (root.getElementById('sb-notification-styles')) continue
      const style = document.createElement('style')
      style.id = 'sb-notification-styles'
      style.textContent = styles
      root.appendChild(style)
    }
    return roots.length > 0
  }
  if (install()) return
  const observer = new MutationObserver(() => { if (install()) observer.disconnect() })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  // Custom element upgrade creates a shadow root without a light-DOM mutation.
  for (const tag of ['devframes-dock-embedded', 'devframes-dock-standalone']) {
    customElements.whenDefined(tag).then(() => { if (install()) observer.disconnect() })
  }
}
