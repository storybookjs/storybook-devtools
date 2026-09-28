# Designer follow-ups

The concrete notification, navigation, hover and editor-action fixes are
implemented separately from these open design decisions. These items still
need an agreed design and are not marked as implemented.

- **Coverage list patterns:** compare the hierarchy, rows and spacing with
  Storybook’s existing lists and choose the matching pattern.
- **Coverage actions:** clarify the primary row action and the placement of
  secondary actions, including the relationship to bulk generation.
- **Coverage status:** decide whether to combine status with the create-story
  button or remove redundant status icons. If a status becomes an action,
  define its click behavior and accessible label.
- **Highlighter content:** explore Properties / Docs / Stories as peer tabs.
  Define the initial tab, behavior when docs or stories are absent, and
  whether switching components preserves the active tab. The current
  Properties section and contextual Stories/Docs tabs remain in place.

Review candidates in both light and dark mode, at narrow dock widths, and
with uncovered, covered and multiply rendered components in React and Vue.
