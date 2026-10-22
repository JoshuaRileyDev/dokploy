## Code style
- Don't write comments that restate what the code already says.
- Comment only the "why" when something isn't obvious: workarounds,
  counterintuitive decisions, constraints from an external API.
- No section-divider comments like `// --- Helpers ---`.
- Don't leave comments describing the change you just made.
## Shipping changes
- Every change shipped from this fork bumps the version in
  `apps/dokploy/package.json` (`v<upstream>-fork.<N>`) as a separate final
  commit, just before pushing and opening the PR. Follow the `bump-version`
  skill in `.claude/skills/bump-version/SKILL.md`.
