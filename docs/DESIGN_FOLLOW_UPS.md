# Designer follow-ups

The coverage and inspector iteration addresses the four follow-ups:

- **Coverage list patterns:** compact component rows, Storybook tokens, clear
  group headings, name/path search, and keyboard-visible focus.
- **Coverage actions:** the component name opens Properties. A labeled primary
  action creates stories or opens Stories; an always-visible menu holds
  secondary actions. Bulk actions live above the list and apply to all visible
  uncovered components, independent of the search filter.
- **Coverage status:** separate warning/check icons are removed. Needs stories /
  Has stories headings and Create story / View stories actions communicate the
  state and available next step together.
- **Highlighter content:** Properties, Stories, and Docs are peer tabs.
  Properties opens first for a new instance. Stories owns creation and previews;
  Docs is omitted when unavailable and loads only when selected. Switching tabs
  or refreshing props preserves the same instance's draft and loaded frames.

The shared panel browser suite covers search, actions, tab visibility, and
keyboard navigation across all six playgrounds. The serial Storybook suite
covers real autodocs entries, lazy iframe preservation, draft preservation,
and new-selection resets. Review the visual treatment in light/dark themes
and at narrow dock widths when changing these patterns.
