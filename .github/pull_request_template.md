## Summary

<!-- What changed? -->

## Why

<!-- Why is this needed? -->

## Scope

- [ ] Supported framework impact considered (see `docs/SUPPORTED_FRAMEWORKS.md`)
- [ ] Shared e2e helpers/suite reused where possible

## Validation

<!-- Paste exact commands and results -->

```bash
# Baseline
pnpm build
pnpm test --run
pnpm typecheck
pnpm exec playwright test
# For Storybook peer, indexing, generation, or launcher changes:
pnpm exec playwright test --config=playwright.storybook.config.ts
```

## Screenshots / Evidence

<!-- Attach screenshots/GIFs for UI-facing changes. Drag & drop images into the PR description. -->

- [ ] Added screenshots or a short recording for visible feature changes
- [ ] Included a short caption per image (what the image proves)

## Documentation

- [ ] Updated `AGENTS.md` if workflow/expectations changed
- [ ] Added/updated inline comments for non-obvious logic

## PR Type

- [ ] Tests-only
- [ ] Implementation
- [ ] Docs
- [ ] Refactor

## Notes for Reviewers

<!-- Caveats, follow-ups, stacked PR context -->
